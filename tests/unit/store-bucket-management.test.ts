import { describe, it, expect, afterEach } from 'vitest';
import { Store, BucketNotDefinedError } from '../../src/core/store.js';
import type { BucketDefinition } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const usersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    email: { type: 'string', format: 'email' },
  },
  indexes: ['email'],
};

const minimalDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
  },
};

// ── Helpers ──────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

// ── hasBucket ────────────────────────────────────────────────────

describe('Store.hasBucket', () => {
  it('returns false for undefined bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    expect(store.hasBucket('nonexistent')).toBe(false);
  });

  it('returns true for defined bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    expect(store.hasBucket('users')).toBe(true);
  });

  it('returns false after bucket is dropped', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('temp', minimalDef);
    await store.dropBucket('temp');

    expect(store.hasBucket('temp')).toBe(false);
  });
});

// ── getBucketSchema ──────────────────────────────────────────────

describe('Store.getBucketSchema', () => {
  it('returns undefined for non-existent bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    expect(store.getBucketSchema('nonexistent')).toBeUndefined();
  });

  it('returns the definition for an existing bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    const schema = store.getBucketSchema('users');
    expect(schema).toBeDefined();
    expect(schema!.key).toBe('id');
    expect(schema!.schema.name).toEqual({ type: 'string', required: true });
    expect(schema!.indexes).toEqual(['email']);
  });

  it('returns the same object reference passed to defineBucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    expect(store.getBucketSchema('users')).toBe(usersDef);
  });
});

// ── dropBucket ───────────────────────────────────────────────────

describe('Store.dropBucket', () => {
  it('returns true when dropping an existing bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('temp', minimalDef);

    expect(await store.dropBucket('temp')).toBe(true);
  });

  it('returns false when dropping a non-existent bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    expect(await store.dropBucket('nonexistent')).toBe(false);
  });

  it('removes bucket from registry', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('temp', minimalDef);

    await store.dropBucket('temp');

    expect(store.hasBucket('temp')).toBe(false);
    expect(store.getBucketSchema('temp')).toBeUndefined();
  });

  it('accessing dropped bucket throws BucketNotDefinedError', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('temp', minimalDef);
    await store.dropBucket('temp');

    expect(() => store.bucket('temp')).toThrow(BucketNotDefinedError);
  });

  it('allows re-defining bucket after drop', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('reusable', minimalDef);
    await store.bucket('reusable').insert({});
    expect(await store.bucket('reusable').count()).toBe(1);

    await store.dropBucket('reusable');
    await store.defineBucket('reusable', minimalDef);

    expect(await store.bucket('reusable').count()).toBe(0);
  });

  it('cancels reactive subscriptions that depend on dropped bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('items', minimalDef);

    store.defineQuery('allItems', async (ctx) => {
      return ctx.bucket('items').all();
    });

    const results: unknown[] = [];
    await store.subscribe('allItems', (r) => results.push(r));

    const stats = await store.getStats();
    expect(stats.queries.activeSubscriptions).toBe(1);

    await store.dropBucket('items');

    const statsAfter = await store.getStats();
    expect(statsAfter.queries.activeSubscriptions).toBe(0);
  });
});

// ── updateBucket — addFields ────────────────────────────────────

describe('Store.updateBucket — addFields', () => {
  it('adds new fields to the schema', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await store.updateBucket('users', {
      addFields: {
        phone: { type: 'string' },
        age: { type: 'number', min: 0 },
      },
    });

    const schema = store.getBucketSchema('users')!;
    expect(schema.schema.phone).toEqual({ type: 'string' });
    expect(schema.schema.age).toEqual({ type: 'number', min: 0 });
  });

  it('preserves existing fields', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await store.updateBucket('users', {
      addFields: { phone: { type: 'string' } },
    });

    const schema = store.getBucketSchema('users')!;
    expect(schema.schema.name).toEqual({ type: 'string', required: true });
    expect(schema.schema.email).toEqual({ type: 'string', format: 'email' });
  });

  it('preserves existing data', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    const inserted = await store.bucket('users').insert({ name: 'Alice', email: 'alice@example.com' });

    await store.updateBucket('users', {
      addFields: { phone: { type: 'string' } },
    });

    const record = await store.bucket('users').get(inserted.id);
    expect(record).toBeDefined();
    expect(record!.name).toBe('Alice');
    expect(record!.email).toBe('alice@example.com');
  });

  it('validates new fields on insert after update', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await store.updateBucket('users', {
      addFields: { age: { type: 'number', min: 0 } },
    });

    // Valid insert with new field
    const record = await store.bucket('users').insert({ name: 'Bob', age: 25 });
    expect(record.age).toBe(25);
  });

  it('throws when adding a field that already exists', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await expect(
      store.updateBucket('users', {
        addFields: { name: { type: 'string' } },
      }),
    ).rejects.toThrow('Field "name" already exists');
  });

  it('throws BucketNotDefinedError for non-existent bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    await expect(
      store.updateBucket('nonexistent', { addFields: { x: { type: 'string' } } }),
    ).rejects.toThrow(BucketNotDefinedError);
  });
});

// ── updateBucket — addIndexes ───────────────────────────────────

describe('Store.updateBucket — addIndexes', () => {
  it('adds new indexes', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await store.updateBucket('users', {
      addFields: { phone: { type: 'string' } },
      addIndexes: ['phone'],
    });

    const schema = store.getBucketSchema('users')!;
    expect(schema.indexes).toContain('email');
    expect(schema.indexes).toContain('phone');
  });

  it('new index is functional for where queries', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
        status: { type: 'string' },
      },
    });

    await store.bucket('users').insert({ name: 'Alice', status: 'active' });
    await store.bucket('users').insert({ name: 'Bob', status: 'inactive' });
    await store.bucket('users').insert({ name: 'Carol', status: 'active' });

    await store.updateBucket('users', { addIndexes: ['status'] });

    const active = await store.bucket('users').where({ status: 'active' });
    expect(active).toHaveLength(2);
    expect(active.map((r) => r.name).sort()).toEqual(['Alice', 'Carol']);
  });

  it('existing records are indexed after addIndexes', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    await store.bucket('users').insert({ name: 'Alice' });

    await store.updateBucket('users', { addIndexes: ['name'] });

    const stats = await store.getStats();
    expect(stats.indexes.perBucket.users).toBe(1);
  });

  it('throws when adding index for non-existent field', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await expect(
      store.updateBucket('users', { addIndexes: ['nonexistent'] }),
    ).rejects.toThrow('Index field "nonexistent" does not exist');
  });

  it('adding already-existing index is a no-op', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    await store.updateBucket('users', { addIndexes: ['email'] });

    const schema = store.getBucketSchema('users')!;
    const emailCount = schema.indexes!.filter((i) => i === 'email').length;
    expect(emailCount).toBe(1);
  });
});

// ── updateBucket — TTL ──────────────────────────────────────────

describe('Store.updateBucket — TTL', () => {
  it('sets TTL on a bucket that had none', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('data', minimalDef);

    await store.updateBucket('data', { ttl: '1h' });

    const schema = store.getBucketSchema('data')!;
    expect(schema.ttl).toBe('1h');
  });

  it('changes existing TTL', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('data', { ...minimalDef, ttl: '1h' });

    await store.updateBucket('data', { ttl: '30d' });

    const schema = store.getBucketSchema('data')!;
    expect(schema.ttl).toBe('30d');
  });

  it('removes TTL with null', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('data', { ...minimalDef, ttl: '1h' });

    await store.updateBucket('data', { ttl: null });

    const schema = store.getBucketSchema('data')!;
    expect(schema.ttl).toBeUndefined();
  });

  it('TTL applies to new records after update', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('data', minimalDef);

    await store.updateBucket('data', { ttl: 100 });

    const record = await store.bucket('data').insert({});
    expect((record as Record<string, unknown>)._expiresAt).toBeDefined();
    expect((record as Record<string, unknown>)._expiresAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('preserves TTL when not in update', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('data', { ...minimalDef, ttl: '1h' });

    await store.updateBucket('data', {
      addFields: { extra: { type: 'string' } },
    });

    const schema = store.getBucketSchema('data')!;
    expect(schema.ttl).toBe('1h');
  });
});

// ── updateBucket — combined operations ──────────────────────────

describe('Store.updateBucket — combined', () => {
  it('adds fields, indexes, and TTL in one call', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('products', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    await store.bucket('products').insert({ name: 'Widget' });

    await store.updateBucket('products', {
      addFields: {
        price: { type: 'number', min: 0 },
        sku: { type: 'string' },
      },
      addIndexes: ['name', 'sku'],
      ttl: '90d',
    });

    const schema = store.getBucketSchema('products')!;
    expect(schema.schema.price).toEqual({ type: 'number', min: 0 });
    expect(schema.schema.sku).toEqual({ type: 'string' });
    expect(schema.indexes).toContain('name');
    expect(schema.indexes).toContain('sku');
    expect(schema.ttl).toBe('90d');

    // Existing data preserved
    const all = await store.bucket('products').all();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Widget');
  });

  it('preserves key field and other definition properties', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('data', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        value: { type: 'number' },
      },
      maxSize: 100,
    });

    await store.updateBucket('data', {
      addFields: { tag: { type: 'string' } },
    });

    const schema = store.getBucketSchema('data')!;
    expect(schema.key).toBe('id');
    expect(schema.maxSize).toBe(100);
  });

  it('empty update is a no-op', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('data', usersDef);
    await store.bucket('data').insert({ name: 'Test', email: 'test@test.com' });

    await store.updateBucket('data', {});

    const schema = store.getBucketSchema('data')!;
    expect(schema.indexes).toEqual(['email']);
    expect(await store.bucket('data').count()).toBe(1);
  });

  it('autoincrement counter is preserved after update', async () => {
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

    await store.updateBucket('orders', {
      addFields: { notes: { type: 'string' } },
    });

    const third = await store.bucket('orders').insert({ product: 'C' });
    expect(third.id).toBe(3);
  });
});
