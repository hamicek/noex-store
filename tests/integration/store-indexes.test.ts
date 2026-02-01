import { describe, it, expect, afterEach } from 'vitest';
import { Store, UniqueConstraintError } from '../../src/core/store.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';

// ── Fixtures ──────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    email: { type: 'string', format: 'email', unique: true },
    tier: { type: 'string', enum: ['basic', 'silver', 'vip'], default: 'basic' },
  },
  indexes: ['email', 'tier'],
};

/** Bucket with no indexes — used for regression testing. */
const plainDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
};

// ── Helpers ────────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

async function seedCustomers(s: Store): Promise<StoreRecord[]> {
  const b = s.bucket('customers');
  const alice = await b.insert({ name: 'Alice', email: 'alice@x.cz', tier: 'vip' });
  const bob = await b.insert({ name: 'Bob', email: 'bob@x.cz', tier: 'basic' });
  const carol = await b.insert({ name: 'Carol', email: 'carol@x.cz', tier: 'vip' });
  return [alice, bob, carol];
}

// ── Index-accelerated where() ─────────────────────────────────────

describe('Index-accelerated where()', () => {
  it('filters by non-unique indexed field', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    const [alice, , carol] = await seedCustomers(store);

    const vips = await store.bucket('customers').where({ tier: 'vip' });

    expect(vips).toHaveLength(2);
    const names = vips.map((r) => r.name);
    expect(names).toContain('Alice');
    expect(names).toContain('Carol');
  });

  it('filters by unique indexed field', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    const [alice] = await seedCustomers(store);

    const result = await store.bucket('customers').where({ email: 'alice@x.cz' });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(alice.id);
  });

  it('applies compound filter with indexed + non-indexed field', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    const result = await store.bucket('customers').where({ tier: 'vip', name: 'Alice' });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Alice');
  });

  it('returns empty array when indexed value has no matches', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    const result = await store.bucket('customers').where({ tier: 'silver' });

    expect(result).toEqual([]);
  });

  it('returns empty array when compound filter narrows to zero', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    const result = await store.bucket('customers').where({ tier: 'vip', name: 'Bob' });

    expect(result).toEqual([]);
  });
});

// ── Index-accelerated findOne() ───────────────────────────────────

describe('Index-accelerated findOne()', () => {
  it('finds a record via unique index', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    const [alice] = await seedCustomers(store);

    const result = await store.bucket('customers').findOne({ email: 'alice@x.cz' });

    expect(result).toBeDefined();
    expect(result!.id).toBe(alice.id);
    expect(result!.name).toBe('Alice');
  });

  it('finds a record via non-unique index', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    const result = await store.bucket('customers').findOne({ tier: 'basic' });

    expect(result).toBeDefined();
    expect(result!.name).toBe('Bob');
  });

  it('returns undefined when no match exists', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    const result = await store.bucket('customers').findOne({ email: 'nobody@x.cz' });

    expect(result).toBeUndefined();
  });
});

// ── Index-accelerated count() ─────────────────────────────────────

describe('Index-accelerated count()', () => {
  it('counts records matching an indexed field', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    expect(await store.bucket('customers').count({ tier: 'vip' })).toBe(2);
    expect(await store.bucket('customers').count({ tier: 'basic' })).toBe(1);
    expect(await store.bucket('customers').count({ tier: 'silver' })).toBe(0);
  });

  it('counts records matching a unique indexed field', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    expect(await store.bucket('customers').count({ email: 'alice@x.cz' })).toBe(1);
    expect(await store.bucket('customers').count({ email: 'ghost@x.cz' })).toBe(0);
  });

  it('total count is unaffected by indexes', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    expect(await store.bucket('customers').count()).toBe(3);
  });
});

// ── Unique constraint enforcement ─────────────────────────────────

describe('Unique constraint enforcement', () => {
  it('rejects duplicate insert on unique field', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await store.bucket('customers').insert({ name: 'Alice', email: 'dup@x.cz' });

    await expect(
      store.bucket('customers').insert({ name: 'Bob', email: 'dup@x.cz' }),
    ).rejects.toThrow(UniqueConstraintError);
  });

  it('UniqueConstraintError contains correct metadata', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await store.bucket('customers').insert({ name: 'Alice', email: 'meta@x.cz' });

    try {
      await store.bucket('customers').insert({ name: 'Bob', email: 'meta@x.cz' });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UniqueConstraintError);
      const e = err as UniqueConstraintError;
      expect(e.bucket).toBe('customers');
      expect(e.field).toBe('email');
      expect(e.value).toBe('meta@x.cz');
    }
  });

  it('rejects update that would violate unique constraint', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await store.bucket('customers').insert({ name: 'Alice', email: 'a@x.cz' });
    const bob = await store.bucket('customers').insert({ name: 'Bob', email: 'b@x.cz' });

    await expect(
      store.bucket('customers').update(bob.id, { email: 'a@x.cz' }),
    ).rejects.toThrow(UniqueConstraintError);
  });

  it('allows update to own current unique value', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    const alice = await store.bucket('customers').insert({ name: 'Alice', email: 'a@x.cz' });

    // Updating name but keeping same email — should not throw
    const updated = await store.bucket('customers').update(alice.id, { name: 'Alice Cooper' });

    expect(updated.email).toBe('a@x.cz');
    expect(updated.name).toBe('Alice Cooper');
  });

  it('allows re-insert of unique value after delete', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    const alice = await store.bucket('customers').insert({ name: 'Alice', email: 'reuse@x.cz' });

    await store.bucket('customers').delete(alice.id);
    const bob = await store.bucket('customers').insert({ name: 'Bob', email: 'reuse@x.cz' });

    expect(bob.email).toBe('reuse@x.cz');
    expect(bob.name).toBe('Bob');
  });

  it('failed insert does not pollute the store', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await store.bucket('customers').insert({ name: 'Alice', email: 'sole@x.cz' });

    await expect(
      store.bucket('customers').insert({ name: 'Bob', email: 'sole@x.cz' }),
    ).rejects.toThrow(UniqueConstraintError);

    expect(await store.bucket('customers').count()).toBe(1);
    const all = await store.bucket('customers').all();
    expect(all[0]!.name).toBe('Alice');
  });

  it('allows multiple records with null/undefined unique field', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);

    // email is omitted (undefined) — should not trigger unique check
    await store.bucket('customers').insert({ name: 'A' });
    await store.bucket('customers').insert({ name: 'B' });

    expect(await store.bucket('customers').count()).toBe(2);
  });
});

// ── Index maintenance ─────────────────────────────────────────────

describe('Index maintenance', () => {
  it('insert is reflected in subsequent queries', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    await store.bucket('customers').insert({ name: 'Dave', email: 'dave@x.cz', tier: 'vip' });

    const vips = await store.bucket('customers').where({ tier: 'vip' });
    expect(vips).toHaveLength(3);
  });

  it('update is reflected in subsequent queries', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    const [, bob] = await seedCustomers(store);

    await store.bucket('customers').update(bob.id, { tier: 'vip' });

    const vips = await store.bucket('customers').where({ tier: 'vip' });
    expect(vips).toHaveLength(3);
    expect(await store.bucket('customers').count({ tier: 'basic' })).toBe(0);
  });

  it('delete is reflected in subsequent queries', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    const [alice] = await seedCustomers(store);

    await store.bucket('customers').delete(alice.id);

    const vips = await store.bucket('customers').where({ tier: 'vip' });
    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Carol');

    expect(await store.bucket('customers').findOne({ email: 'alice@x.cz' })).toBeUndefined();
  });

  it('clear removes all indexed data', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    await store.bucket('customers').clear();

    expect(await store.bucket('customers').where({ tier: 'vip' })).toEqual([]);
    expect(await store.bucket('customers').count()).toBe(0);
  });

  it('insert after clear indexes correctly', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await seedCustomers(store);

    await store.bucket('customers').clear();
    // Re-insert same email that existed before — unique index should allow it
    await store.bucket('customers').insert({ name: 'Eve', email: 'alice@x.cz', tier: 'silver' });

    expect(await store.bucket('customers').count({ tier: 'silver' })).toBe(1);
    const found = await store.bucket('customers').findOne({ email: 'alice@x.cz' });
    expect(found!.name).toBe('Eve');
  });

  it('update of unique field updates lookup path', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    const [alice] = await seedCustomers(store);

    await store.bucket('customers').update(alice.id, { email: 'newalice@x.cz' });

    expect(await store.bucket('customers').findOne({ email: 'alice@x.cz' })).toBeUndefined();
    const found = await store.bucket('customers').findOne({ email: 'newalice@x.cz' });
    expect(found!.name).toBe('Alice');
  });
});

// ── Regression: bucket without indexes ────────────────────────────

describe('Bucket without indexes (regression)', () => {
  it('insert + get + update + delete works without indexes', async () => {
    store = await Store.start();
    await store.defineBucket('plain', plainDef);

    const inserted = await store.bucket('plain').insert({ name: 'Alice' });
    expect(inserted.name).toBe('Alice');
    expect(inserted.role).toBe('user');

    const fetched = await store.bucket('plain').get(inserted.id);
    expect(fetched).toEqual(inserted);

    const updated = await store.bucket('plain').update(inserted.id, { role: 'admin' });
    expect(updated.role).toBe('admin');

    await store.bucket('plain').delete(inserted.id);
    expect(await store.bucket('plain').get(inserted.id)).toBeUndefined();
  });

  it('where() works via full scan without indexes', async () => {
    store = await Store.start();
    await store.defineBucket('plain', plainDef);

    await store.bucket('plain').insert({ name: 'Alice', role: 'admin' });
    await store.bucket('plain').insert({ name: 'Bob' });
    await store.bucket('plain').insert({ name: 'Carol', role: 'admin' });

    const admins = await store.bucket('plain').where({ role: 'admin' });
    expect(admins).toHaveLength(2);
  });

  it('findOne() works via full scan without indexes', async () => {
    store = await Store.start();
    await store.defineBucket('plain', plainDef);

    await store.bucket('plain').insert({ name: 'Alice', role: 'admin' });
    await store.bucket('plain').insert({ name: 'Bob' });

    const admin = await store.bucket('plain').findOne({ role: 'admin' });
    expect(admin).toBeDefined();
    expect(admin!.name).toBe('Alice');
  });

  it('count() with filter works via full scan without indexes', async () => {
    store = await Store.start();
    await store.defineBucket('plain', plainDef);

    await store.bucket('plain').insert({ name: 'Alice', role: 'admin' });
    await store.bucket('plain').insert({ name: 'Bob' });
    await store.bucket('plain').insert({ name: 'Carol' });

    expect(await store.bucket('plain').count({ role: 'admin' })).toBe(1);
    expect(await store.bucket('plain').count({ role: 'user' })).toBe(2);
    expect(await store.bucket('plain').count()).toBe(3);
  });

  it('clear() works without indexes', async () => {
    store = await Store.start();
    await store.defineBucket('plain', plainDef);

    await store.bucket('plain').insert({ name: 'Alice' });
    await store.bucket('plain').insert({ name: 'Bob' });

    await store.bucket('plain').clear();
    expect(await store.bucket('plain').count()).toBe(0);
  });
});
