import { describe, it, expect, afterEach, vi } from 'vitest';
import { MemoryAdapter } from '@hamicek/noex';
import { Store, UniqueConstraintError } from '../../src/core/store.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    email: { type: 'string', format: 'email', unique: true },
    tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
  },
  indexes: ['email', 'tier'],
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    product: { type: 'string', required: true },
    quantity: { type: 'number', required: true, min: 1 },
  },
};

// ── Helpers ──────────────────────────────────────────────────────

const stores: Store[] = [];

async function startStore(adapter: MemoryAdapter, name = 'test'): Promise<Store> {
  const s = await Store.start({ name, persistence: { adapter } });
  stores.push(s);
  return s;
}

afterEach(async () => {
  for (const s of stores.splice(0)) {
    await s.stop();
  }
});

// ── 1. Basic persistence lifecycle ──────────────────────────────

describe('persistence: basic lifecycle', () => {
  it('data survives store restart', async () => {
    const adapter = new MemoryAdapter();

    const s1 = await startStore(adapter);
    await s1.defineBucket('customers', customersDef);
    const alice = await s1.bucket('customers').insert({ name: 'Alice', email: 'alice@x.cz', tier: 'vip' });
    const bob = await s1.bucket('customers').insert({ name: 'Bob', email: 'bob@x.cz' });
    await s1.stop();
    stores.length = 0;

    const s2 = await startStore(adapter);
    await s2.defineBucket('customers', customersDef);

    const restoredAlice = await s2.bucket('customers').get(alice.id);
    const restoredBob = await s2.bucket('customers').get(bob.id);

    expect(restoredAlice).toBeDefined();
    expect(restoredAlice!.name).toBe('Alice');
    expect(restoredAlice!.tier).toBe('vip');
    expect(restoredAlice!._version).toBe(1);

    expect(restoredBob).toBeDefined();
    expect(restoredBob!.name).toBe('Bob');

    expect(await s2.bucket('customers').count()).toBe(2);
  });
});

// ── 2. Multiple buckets ─────────────────────────────────────────

describe('persistence: multiple buckets', () => {
  it('restores multiple independent buckets', async () => {
    const adapter = new MemoryAdapter();

    const s1 = await startStore(adapter);
    await s1.defineBucket('customers', customersDef);
    await s1.defineBucket('orders', ordersDef);
    await s1.bucket('customers').insert({ name: 'Alice', email: 'a@x.cz' });
    await s1.bucket('orders').insert({ product: 'Widget', quantity: 3 });
    await s1.bucket('orders').insert({ product: 'Gadget', quantity: 1 });
    await s1.stop();
    stores.length = 0;

    const s2 = await startStore(adapter);
    await s2.defineBucket('customers', customersDef);
    await s2.defineBucket('orders', ordersDef);

    expect(await s2.bucket('customers').count()).toBe(1);
    expect(await s2.bucket('orders').count()).toBe(2);

    const customer = await s2.bucket('customers').findOne({ name: 'Alice' });
    expect(customer).toBeDefined();

    const orders = await s2.bucket('orders').all();
    expect(orders.map((o) => o.product).sort()).toEqual(['Gadget', 'Widget']);
  });
});

// ── 3. Indexes after restore ────────────────────────────────────

describe('persistence: indexes after restore', () => {
  it('index-accelerated where() works after restore', async () => {
    const adapter = new MemoryAdapter();

    const s1 = await startStore(adapter);
    await s1.defineBucket('customers', customersDef);
    await s1.bucket('customers').insert({ name: 'Alice', email: 'a@x.cz', tier: 'vip' });
    await s1.bucket('customers').insert({ name: 'Bob', email: 'b@x.cz', tier: 'basic' });
    await s1.bucket('customers').insert({ name: 'Carol', email: 'c@x.cz', tier: 'vip' });
    await s1.stop();
    stores.length = 0;

    const s2 = await startStore(adapter);
    await s2.defineBucket('customers', customersDef);

    const vips = await s2.bucket('customers').where({ tier: 'vip' });
    expect(vips).toHaveLength(2);
    expect(vips.map((r) => r.name).sort()).toEqual(['Alice', 'Carol']);
  });

  it('unique constraint from rebuilt index prevents duplicates', async () => {
    const adapter = new MemoryAdapter();

    const s1 = await startStore(adapter);
    await s1.defineBucket('customers', customersDef);
    await s1.bucket('customers').insert({ name: 'Alice', email: 'alice@x.cz' });
    await s1.stop();
    stores.length = 0;

    const s2 = await startStore(adapter);
    await s2.defineBucket('customers', customersDef);

    await expect(
      s2.bucket('customers').insert({ name: 'Fake', email: 'alice@x.cz' }),
    ).rejects.toThrow(UniqueConstraintError);
  });
});

// ── 4. Autoincrement continuity ─────────────────────────────────

describe('persistence: autoincrement continuity', () => {
  it('continues autoincrement counter from persisted value', async () => {
    const adapter = new MemoryAdapter();

    const s1 = await startStore(adapter);
    await s1.defineBucket('orders', ordersDef);
    await s1.bucket('orders').insert({ product: 'A', quantity: 1 });
    await s1.bucket('orders').insert({ product: 'B', quantity: 1 });
    await s1.bucket('orders').insert({ product: 'C', quantity: 1 });
    await s1.stop();
    stores.length = 0;

    const s2 = await startStore(adapter);
    await s2.defineBucket('orders', ordersDef);

    const newOrder = await s2.bucket('orders').insert({ product: 'D', quantity: 1 });
    expect(newOrder.id).toBe(4);

    expect(await s2.bucket('orders').count()).toBe(4);
  });
});

// ── 5. Non-persistent bucket ────────────────────────────────────

describe('persistence: non-persistent bucket', () => {
  it('bucket with persistent: false is not restored', async () => {
    const adapter = new MemoryAdapter();

    const ephemeralDef: BucketDefinition = {
      ...ordersDef,
      persistent: false,
    };

    const s1 = await startStore(adapter);
    await s1.defineBucket('customers', customersDef);
    await s1.defineBucket('cache', ephemeralDef);
    await s1.bucket('customers').insert({ name: 'Alice', email: 'a@x.cz' });
    await s1.bucket('cache').insert({ product: 'Temp', quantity: 1 });
    await s1.stop();
    stores.length = 0;

    const s2 = await startStore(adapter);
    await s2.defineBucket('customers', customersDef);
    await s2.defineBucket('cache', ephemeralDef);

    expect(await s2.bucket('customers').count()).toBe(1);
    expect(await s2.bucket('cache').count()).toBe(0);
  });
});

// ── 6. Reactive queries after restore ───────────────────────────

describe('persistence: reactive queries after restore', () => {
  it('subscription sees restored data on mutation trigger', async () => {
    const adapter = new MemoryAdapter();

    const s1 = await startStore(adapter);
    await s1.defineBucket('customers', customersDef);
    await s1.bucket('customers').insert({ name: 'Alice', email: 'a@x.cz', tier: 'vip' });
    await s1.stop();
    stores.length = 0;

    const s2 = await startStore(adapter);
    await s2.defineBucket('customers', customersDef);

    s2.defineQuery('vips', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const callback = vi.fn();
    await s2.subscribe('vips', callback);

    // Insert another VIP to trigger re-evaluation
    await s2.bucket('customers').insert({ name: 'Bob', email: 'b@x.cz', tier: 'vip' });
    await s2.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
  });
});

// ── 7. Store without persistence ────────────────────────────────

describe('persistence: store without persistence config', () => {
  it('works normally with no persistence option', async () => {
    const s = await Store.start({ name: 'no-persist' });
    stores.push(s);

    await s.defineBucket('customers', customersDef);
    await s.bucket('customers').insert({ name: 'Alice', email: 'a@x.cz' });

    expect(await s.bucket('customers').count()).toBe(1);
  });
});

// ── 8. Empty bucket restore ─────────────────────────────────────

describe('persistence: empty bucket restore', () => {
  it('restores an empty bucket without errors', async () => {
    const adapter = new MemoryAdapter();

    const s1 = await startStore(adapter);
    await s1.defineBucket('customers', customersDef);
    // No inserts — bucket is empty
    await s1.stop();
    stores.length = 0;

    const s2 = await startStore(adapter);
    await s2.defineBucket('customers', customersDef);

    expect(await s2.bucket('customers').count()).toBe(0);

    // Bucket is functional after empty restore
    const alice = await s2.bucket('customers').insert({ name: 'Alice', email: 'a@x.cz' });
    expect(alice.name).toBe('Alice');
    expect(await s2.bucket('customers').count()).toBe(1);
  });
});

// ── 9. Update and delete persistence ────────────────────────────

describe('persistence: update and delete', () => {
  it('persists state reflecting updates and deletes', async () => {
    const adapter = new MemoryAdapter();

    const s1 = await startStore(adapter);
    await s1.defineBucket('customers', customersDef);
    const alice = await s1.bucket('customers').insert({ name: 'Alice', email: 'a@x.cz', tier: 'basic' });
    const bob = await s1.bucket('customers').insert({ name: 'Bob', email: 'b@x.cz', tier: 'basic' });
    await s1.bucket('customers').update(alice.id, { tier: 'vip' });
    await s1.bucket('customers').delete(bob.id);
    await s1.stop();
    stores.length = 0;

    const s2 = await startStore(adapter);
    await s2.defineBucket('customers', customersDef);

    expect(await s2.bucket('customers').count()).toBe(1);

    const restored = await s2.bucket('customers').get(alice.id);
    expect(restored).toBeDefined();
    expect(restored!.tier).toBe('vip');
    expect(restored!._version).toBe(2);

    expect(await s2.bucket('customers').get(bob.id)).toBeUndefined();
  });
});

// ── 10. Verification from plan ──────────────────────────────────

describe('persistence: end-to-end verification from plan', () => {
  it('matches the verification scenario', async () => {
    const adapter = new MemoryAdapter();

    const store1 = await Store.start({
      name: 'test',
      persistence: { adapter },
    });
    stores.push(store1);

    await store1.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });
    await store1.bucket('users').insert({ name: 'Persistent' });
    await store1.stop();
    stores.length = 0;

    const store2 = await Store.start({
      name: 'test',
      persistence: { adapter },
    });
    stores.push(store2);

    await store2.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    const user = await store2.bucket('users').findOne({ name: 'Persistent' });
    expect(user).toBeDefined();
    expect(user!.name).toBe('Persistent');
  });

  it('full scenario with indexes, unique constraints, and count', async () => {
    const adapter = new MemoryAdapter();

    const store1 = await Store.start({
      name: 'my-store',
      persistence: { adapter },
    });
    stores.push(store1);

    await store1.defineBucket('customers', customersDef);

    const jan = await store1.bucket('customers').insert({
      name: 'Jan', email: 'jan@example.cz', tier: 'vip',
    });
    await store1.bucket('customers').insert({
      name: 'Petra', email: 'petra@example.cz',
    });

    expect(await store1.bucket('customers').count()).toBe(2);
    await store1.stop();
    stores.length = 0;

    const store2 = await Store.start({
      name: 'my-store',
      persistence: { adapter },
    });
    stores.push(store2);

    await store2.defineBucket('customers', customersDef);

    // Data survived restart
    const janRestored = await store2.bucket('customers').get(jan.id);
    expect(janRestored).toBeDefined();
    expect(janRestored!.name).toBe('Jan');
    expect(janRestored!._version).toBe(1);

    // Indexes work
    const vips = await store2.bucket('customers').where({ tier: 'vip' });
    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Jan');

    // Unique constraint works (from rebuilt index)
    await expect(
      store2.bucket('customers').insert({ name: 'X', email: 'jan@example.cz' }),
    ).rejects.toThrow(UniqueConstraintError);

    // Count is correct
    expect(await store2.bucket('customers').count()).toBe(2);
  });
});
