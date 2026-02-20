import { describe, it, expect, afterEach } from 'vitest';
import { Store } from '../../src/core/store.js';
import { runMigrations } from '../../src/migration/migration-runner.js';
import type { BucketDefinition } from '../../src/types/index.js';
import type { Migration } from '../../src/types/migration.js';

// ── Fixtures ─────────────────────────────────────────────────────

const usersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
    age: { type: 'number' },
  },
};

// ── Helpers ──────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

// ── runMigrations — basic flow ──────────────────────────────────

describe('runMigrations — basic flow', () => {
  it('runs pending migrations in version order', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    const migrations: Migration[] = [
      {
        version: 2,
        name: 'add-email',
        up: async (ctx) => {
          const users = ctx.bucket('users');
          await users.addField('email', { type: 'string' });
        },
      },
      {
        version: 1,
        name: 'create-users',
        up: async (ctx) => {
          await ctx.createBucket('users', usersDef);
        },
      },
    ];

    const result = await runMigrations(store, migrations);

    expect(result.applied).toBe(2);
    expect(result.currentVersion).toBe(2);
    expect(store.hasBucket('users')).toBe(true);
    expect(store.getBucketSchema('users')!.schema.email).toBeDefined();
  });

  it('skips already applied migrations (idempotent)', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    const migrations: Migration[] = [
      {
        version: 1,
        name: 'create-users',
        up: async (ctx) => {
          await ctx.createBucket('users', usersDef);
        },
      },
    ];

    const first = await runMigrations(store, migrations);
    expect(first.applied).toBe(1);

    const second = await runMigrations(store, migrations);
    expect(second.applied).toBe(0);
    expect(second.currentVersion).toBe(1);
  });

  it('applies only new migrations on subsequent run', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    const m1: Migration[] = [
      {
        version: 1,
        name: 'create-users',
        up: async (ctx) => {
          await ctx.createBucket('users', usersDef);
        },
      },
    ];

    await runMigrations(store, m1);
    await store.bucket('users').insert({ name: 'Alice', age: 30 });

    const m2: Migration[] = [
      ...m1,
      {
        version: 2,
        name: 'add-email',
        up: async (ctx) => {
          const users = ctx.bucket('users');
          await users.addField('email', { type: 'string' }, 'unknown@example.com');
        },
      },
    ];

    const result = await runMigrations(store, m2);
    expect(result.applied).toBe(1);
    expect(result.currentVersion).toBe(2);

    const alice = await store.bucket('users').get(1);
    expect(alice!.email).toBe('unknown@example.com');
  });

  it('returns currentVersion 0 for empty migrations', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    const result = await runMigrations(store, []);
    expect(result.applied).toBe(0);
    expect(result.currentVersion).toBe(0);
  });
});

// ── Validation ──────────────────────────────────────────────────

describe('runMigrations — validation', () => {
  it('rejects duplicate versions', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    const migrations: Migration[] = [
      { version: 1, name: 'first', up: async () => {} },
      { version: 1, name: 'second', up: async () => {} },
    ];

    await expect(runMigrations(store, migrations)).rejects.toThrow('Duplicate migration version: 1');
  });

  it('rejects non-positive version', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    await expect(
      runMigrations(store, [{ version: 0, name: 'bad', up: async () => {} }]),
    ).rejects.toThrow('positive integer');

    await expect(
      runMigrations(store, [{ version: -1, name: 'bad', up: async () => {} }]),
    ).rejects.toThrow('positive integer');
  });

  it('rejects non-integer version', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    await expect(
      runMigrations(store, [{ version: 1.5, name: 'bad', up: async () => {} }]),
    ).rejects.toThrow('positive integer');
  });

  it('rejects empty name', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    await expect(
      runMigrations(store, [{ version: 1, name: '', up: async () => {} }]),
    ).rejects.toThrow('non-empty name');
  });
});

// ── addField ────────────────────────────────────────────────────

describe('MigrationBucketHandle.addField', () => {
  it('adds a new field to the schema', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await runMigrations(store, [
      {
        version: 1,
        name: 'add-email',
        up: async (ctx) => {
          await ctx.bucket('users').addField('email', { type: 'string', format: 'email' });
        },
      },
    ]);

    const schema = store.getBucketSchema('users')!;
    expect(schema.schema.email).toEqual({ type: 'string', format: 'email' });
  });

  it('backfills default value on existing records', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);
    await store.bucket('users').insert({ name: 'Alice', age: 30 });
    await store.bucket('users').insert({ name: 'Bob', age: 25 });

    await runMigrations(store, [
      {
        version: 1,
        name: 'add-active-flag',
        up: async (ctx) => {
          await ctx.bucket('users').addField('active', { type: 'boolean' }, true);
        },
      },
    ]);

    const all = await store.bucket('users').all();
    expect(all).toHaveLength(2);
    for (const user of all) {
      expect(user.active).toBe(true);
    }
  });

  it('preserves existing data when no default given', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);
    await store.bucket('users').insert({ name: 'Alice', age: 30 });

    await runMigrations(store, [
      {
        version: 1,
        name: 'add-optional-bio',
        up: async (ctx) => {
          await ctx.bucket('users').addField('bio', { type: 'string' });
        },
      },
    ]);

    const alice = await store.bucket('users').get(1);
    expect(alice!.name).toBe('Alice');
    expect(alice!.age).toBe(30);
    expect(alice!.bio).toBeUndefined();
  });

  it('throws when field already exists', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await expect(
      runMigrations(store, [
        {
          version: 1,
          name: 'duplicate',
          up: async (ctx) => {
            await ctx.bucket('users').addField('name', { type: 'string' });
          },
        },
      ]),
    ).rejects.toThrow('already exists');
  });
});

// ── removeField ─────────────────────────────────────────────────

describe('MigrationBucketHandle.removeField', () => {
  it('removes a field from schema and records', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);
    await store.bucket('users').insert({ name: 'Alice', age: 30 });

    await runMigrations(store, [
      {
        version: 1,
        name: 'remove-age',
        up: async (ctx) => {
          await ctx.bucket('users').removeField('age');
        },
      },
    ]);

    const schema = store.getBucketSchema('users')!;
    expect(schema.schema.age).toBeUndefined();

    const alice = await store.bucket('users').get(1);
    expect(alice!.name).toBe('Alice');
    expect((alice as Record<string, unknown>).age).toBeUndefined();
  });

  it('also removes the index when removing an indexed field', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('items', {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        name: { type: 'string', required: true },
        category: { type: 'string' },
      },
      indexes: ['category'],
    });

    await runMigrations(store, [
      {
        version: 1,
        name: 'remove-category',
        up: async (ctx) => {
          await ctx.bucket('items').removeField('category');
        },
      },
    ]);

    const schema = store.getBucketSchema('items')!;
    expect(schema.schema.category).toBeUndefined();
    expect(schema.indexes ?? []).not.toContain('category');
  });

  it('throws when removing the key field', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await expect(
      runMigrations(store, [
        {
          version: 1,
          name: 'bad-remove',
          up: async (ctx) => {
            await ctx.bucket('users').removeField('id');
          },
        },
      ]),
    ).rejects.toThrow('Cannot remove key field');
  });

  it('throws when field does not exist', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await expect(
      runMigrations(store, [
        {
          version: 1,
          name: 'bad-remove',
          up: async (ctx) => {
            await ctx.bucket('users').removeField('nonexistent');
          },
        },
      ]),
    ).rejects.toThrow('does not exist');
  });
});

// ── renameField ─────────────────────────────────────────────────

describe('MigrationBucketHandle.renameField', () => {
  it('renames a field in schema and records', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);
    await store.bucket('users').insert({ name: 'Alice', age: 30 });

    await runMigrations(store, [
      {
        version: 1,
        name: 'rename-name-to-fullName',
        up: async (ctx) => {
          await ctx.bucket('users').renameField('name', 'fullName');
        },
      },
    ]);

    const schema = store.getBucketSchema('users')!;
    expect(schema.schema.name).toBeUndefined();
    expect(schema.schema.fullName).toEqual({ type: 'string', required: true });

    const alice = await store.bucket('users').get(1);
    expect((alice as Record<string, unknown>).name).toBeUndefined();
    expect(alice!.fullName).toBe('Alice');
  });

  it('preserves index when renaming an indexed field', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('items', {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        category: { type: 'string' },
      },
      indexes: ['category'],
    });

    await store.bucket('items').insert({ category: 'electronics' });
    await store.bucket('items').insert({ category: 'books' });

    await runMigrations(store, [
      {
        version: 1,
        name: 'rename-category',
        up: async (ctx) => {
          await ctx.bucket('items').renameField('category', 'group');
        },
      },
    ]);

    const schema = store.getBucketSchema('items')!;
    expect(schema.indexes).toContain('group');
    expect(schema.indexes).not.toContain('category');

    // Index should be functional
    const electronics = await store.bucket('items').where({ group: 'electronics' });
    expect(electronics).toHaveLength(1);
  });

  it('throws when renaming the key field', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await expect(
      runMigrations(store, [
        {
          version: 1,
          name: 'bad-rename',
          up: async (ctx) => {
            await ctx.bucket('users').renameField('id', 'userId');
          },
        },
      ]),
    ).rejects.toThrow('Cannot rename key field');
  });

  it('throws when target name already exists', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await expect(
      runMigrations(store, [
        {
          version: 1,
          name: 'bad-rename',
          up: async (ctx) => {
            await ctx.bucket('users').renameField('name', 'age');
          },
        },
      ]),
    ).rejects.toThrow('already exists');
  });
});

// ── changeFieldType ─────────────────────────────────────────────

describe('MigrationBucketHandle.changeFieldType', () => {
  it('changes field type and transforms values', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);
    await store.bucket('users').insert({ name: 'Alice', age: 30 });
    await store.bucket('users').insert({ name: 'Bob', age: 25 });

    await runMigrations(store, [
      {
        version: 1,
        name: 'age-to-string',
        up: async (ctx) => {
          await ctx.bucket('users').changeFieldType('age', 'string', (v) => String(v));
        },
      },
    ]);

    const schema = store.getBucketSchema('users')!;
    expect(schema.schema.age!.type).toBe('string');

    const alice = await store.bucket('users').get(1);
    expect(alice!.age).toBe('30');

    const bob = await store.bucket('users').get(2);
    expect(bob!.age).toBe('25');
  });

  it('skips null/undefined values during transform', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);
    await store.bucket('users').insert({ name: 'Alice' }); // no age

    await runMigrations(store, [
      {
        version: 1,
        name: 'age-to-string',
        up: async (ctx) => {
          await ctx.bucket('users').changeFieldType('age', 'string', (v) => String(v));
        },
      },
    ]);

    const alice = await store.bucket('users').get(1);
    expect(alice!.age).toBeUndefined();
  });

  it('throws when changing the key field type', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await expect(
      runMigrations(store, [
        {
          version: 1,
          name: 'bad-type-change',
          up: async (ctx) => {
            await ctx.bucket('users').changeFieldType('id', 'string', (v) => String(v));
          },
        },
      ]),
    ).rejects.toThrow('Cannot change type of key field');
  });
});

// ── addIndex / removeIndex ──────────────────────────────────────

describe('MigrationBucketHandle.addIndex / removeIndex', () => {
  it('adds an index', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);
    await store.bucket('users').insert({ name: 'Alice', age: 30 });

    await runMigrations(store, [
      {
        version: 1,
        name: 'add-name-index',
        up: async (ctx) => {
          await ctx.bucket('users').addIndex('name');
        },
      },
    ]);

    const schema = store.getBucketSchema('users')!;
    expect(schema.indexes).toContain('name');

    // Index should be functional
    const results = await store.bucket('users').where({ name: 'Alice' });
    expect(results).toHaveLength(1);
  });

  it('removes an index', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('items', {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        name: { type: 'string', required: true },
      },
      indexes: ['name'],
    });

    await runMigrations(store, [
      {
        version: 1,
        name: 'remove-name-index',
        up: async (ctx) => {
          await ctx.bucket('items').removeIndex('name');
        },
      },
    ]);

    const schema = store.getBucketSchema('items')!;
    expect(schema.indexes ?? []).not.toContain('name');
  });

  it('throws when removing non-existent index', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await expect(
      runMigrations(store, [
        {
          version: 1,
          name: 'bad-remove',
          up: async (ctx) => {
            await ctx.bucket('users').removeIndex('nonexistent');
          },
        },
      ]),
    ).rejects.toThrow('does not exist');
  });
});

// ── transformAll ────────────────────────────────────────────────

describe('MigrationBucketHandle.transformAll', () => {
  it('transforms all existing records', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);
    await store.bucket('users').insert({ name: 'alice', age: 30 });
    await store.bucket('users').insert({ name: 'bob', age: 25 });

    await runMigrations(store, [
      {
        version: 1,
        name: 'uppercase-names',
        up: async (ctx) => {
          await ctx.bucket('users').transformAll((record) => ({
            ...record,
            name: (record.name as string).toUpperCase(),
          }));
        },
      },
    ]);

    const all = await store.bucket('users').all();
    const names = all.map(r => r.name).sort();
    expect(names).toEqual(['ALICE', 'BOB']);
  });

  it('preserves record keys', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);
    await store.bucket('users').insert({ name: 'Alice', age: 30 });

    await runMigrations(store, [
      {
        version: 1,
        name: 'double-age',
        up: async (ctx) => {
          await ctx.bucket('users').transformAll((record) => ({
            ...record,
            age: (record.age as number) * 2,
          }));
        },
      },
    ]);

    const alice = await store.bucket('users').get(1);
    expect(alice).toBeDefined();
    expect(alice!.age).toBe(60);
  });
});

// ── createBucket / dropBucket ───────────────────────────────────

describe('MigrationContext.createBucket / dropBucket', () => {
  it('creates a new bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    await runMigrations(store, [
      {
        version: 1,
        name: 'create-products',
        up: async (ctx) => {
          await ctx.createBucket('products', {
            key: 'id',
            schema: {
              id: { type: 'number', generated: 'autoincrement' },
              name: { type: 'string', required: true },
              price: { type: 'number', min: 0 },
            },
            indexes: ['name'],
          });
        },
      },
    ]);

    expect(store.hasBucket('products')).toBe(true);
    const record = await store.bucket('products').insert({ name: 'Widget', price: 9.99 });
    expect(record.id).toBe(1);
  });

  it('drops an existing bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('temp', {
      key: 'id',
      schema: { id: { type: 'number', generated: 'autoincrement' } },
    });

    await runMigrations(store, [
      {
        version: 1,
        name: 'drop-temp',
        up: async (ctx) => {
          await ctx.dropBucket('temp');
        },
      },
    ]);

    expect(store.hasBucket('temp')).toBe(false);
  });
});

// ── Complex multi-step migration ────────────────────────────────

describe('complex multi-step migration', () => {
  it('handles a realistic multi-step schema evolution', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    // Seed data
    await store.bucket('users').insert({ name: 'Alice', age: 30 });
    await store.bucket('users').insert({ name: 'Bob', age: 25 });
    await store.bucket('users').insert({ name: 'Carol', age: 35 });

    const migrations: Migration[] = [
      {
        version: 1,
        name: 'add-email-and-rename-name',
        up: async (ctx) => {
          const users = ctx.bucket('users');
          await users.addField('email', { type: 'string' }, null);
          await users.renameField('name', 'fullName');
        },
      },
      {
        version: 2,
        name: 'age-to-birth-year',
        up: async (ctx) => {
          const users = ctx.bucket('users');
          await users.changeFieldType('age', 'string', (v) => {
            const birthYear = new Date().getFullYear() - (v as number);
            return String(birthYear);
          });
          await users.renameField('age', 'birthYear');
        },
      },
      {
        version: 3,
        name: 'add-index-on-fullName',
        up: async (ctx) => {
          await ctx.bucket('users').addIndex('fullName');
        },
      },
    ];

    const result = await runMigrations(store, migrations);
    expect(result.applied).toBe(3);
    expect(result.currentVersion).toBe(3);

    // Verify final schema
    const schema = store.getBucketSchema('users')!;
    expect(schema.schema.fullName).toBeDefined();
    expect(schema.schema.email).toBeDefined();
    expect(schema.schema.birthYear).toBeDefined();
    expect(schema.schema.name).toBeUndefined();
    expect(schema.schema.age).toBeUndefined();
    expect(schema.indexes).toContain('fullName');

    // Verify data
    const all = await store.bucket('users').all();
    expect(all).toHaveLength(3);

    const alice = all.find(r => r.fullName === 'Alice')!;
    expect(alice).toBeDefined();
    expect(alice.email).toBe(null);
    expect(alice.birthYear).toBeDefined();
    expect(typeof alice.birthYear).toBe('string');

    // Index lookup works
    const found = await store.bucket('users').where({ fullName: 'Bob' });
    expect(found).toHaveLength(1);
  });

  it('preserves autoincrement counter across migrations', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('orders', {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        product: { type: 'string', required: true },
      },
    });

    await store.bucket('orders').insert({ product: 'A' });
    await store.bucket('orders').insert({ product: 'B' });

    await runMigrations(store, [
      {
        version: 1,
        name: 'add-quantity',
        up: async (ctx) => {
          await ctx.bucket('orders').addField('quantity', { type: 'number' }, 1);
        },
      },
    ]);

    const third = await store.bucket('orders').insert({ product: 'C', quantity: 5 });
    expect(third.id).toBe(3);
  });
});

// ── _migrations bucket ──────────────────────────────────────────

describe('_migrations tracking bucket', () => {
  it('records each applied migration', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    await runMigrations(store, [
      { version: 1, name: 'first', up: async () => {} },
      { version: 2, name: 'second', up: async () => {} },
    ]);

    expect(store.hasBucket('_migrations')).toBe(true);
    const records = await store.bucket('_migrations').all();
    expect(records).toHaveLength(2);
    expect(records.map(r => r.version).sort()).toEqual([1, 2]);
    expect(records.map(r => r.name).sort()).toEqual(['first', 'second']);

    for (const record of records) {
      expect(record.appliedAt).toBeTypeOf('number');
      expect(record.appliedAt).toBeGreaterThan(0);
    }
  });
});

// ── Edge case: non-existent bucket ──────────────────────────────

describe('error handling', () => {
  it('throws when operating on non-existent bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    await expect(
      runMigrations(store, [
        {
          version: 1,
          name: 'bad',
          up: async (ctx) => {
            await ctx.bucket('nonexistent').addField('x', { type: 'string' });
          },
        },
      ]),
    ).rejects.toThrow('does not exist');
  });

  it('does not record version when migration fails', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    const migrations: Migration[] = [
      { version: 1, name: 'ok', up: async () => {} },
      {
        version: 2,
        name: 'will-fail',
        up: async (ctx) => {
          await ctx.bucket('users').removeField('nonexistent');
        },
      },
    ];

    await expect(runMigrations(store, migrations)).rejects.toThrow();

    // Only version 1 should be recorded
    const records = await store.bucket('_migrations').all();
    expect(records).toHaveLength(1);
    expect(records[0]!.version).toBe(1);
  });
});
