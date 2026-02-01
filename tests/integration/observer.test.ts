import { describe, it, expect, afterEach } from 'vitest';
import { Store } from '../../src/core/store.js';
import type { StoreStats } from '../../src/core/store.js';
import type { BucketDefinition } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    tier: { type: 'string', default: 'basic' },
  },
  indexes: ['tier'],
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    product: { type: 'string', required: true },
    amount: { type: 'number', default: 0 },
  },
};

const productsDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    price: { type: 'number', required: true },
    category: { type: 'string', default: 'misc' },
  },
  indexes: ['category'],
};

// ── Tests ─────────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

describe('Store.getStats()', () => {
  it('returns correct stats for empty store (no buckets)', async () => {
    store = await Store.start({ name: 'stats-empty', ttlCheckIntervalMs: 0 });

    const stats = await store.getStats();

    expect(stats.name).toBe('stats-empty');
    expect(stats.buckets.count).toBe(0);
    expect(stats.buckets.names).toEqual([]);
    expect(stats.records.total).toBe(0);
    expect(stats.records.perBucket).toEqual({});
    expect(stats.indexes.total).toBe(0);
    expect(stats.indexes.perBucket).toEqual({});
    expect(stats.queries.defined).toBe(0);
    expect(stats.queries.activeSubscriptions).toBe(0);
    expect(stats.persistence.enabled).toBe(false);
    expect(stats.ttl.enabled).toBe(false);
    expect(stats.ttl.checkIntervalMs).toBe(0);
  });

  it('returns correct bucket count and names', async () => {
    store = await Store.start({ name: 'stats-buckets', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);
    await store.defineBucket('orders', ordersDef);

    const stats = await store.getStats();

    expect(stats.buckets.count).toBe(2);
    expect(stats.buckets.names).toContain('customers');
    expect(stats.buckets.names).toContain('orders');
  });

  it('returns correct record counts after inserts', async () => {
    store = await Store.start({ name: 'stats-records', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);
    await store.defineBucket('orders', ordersDef);

    await store.bucket('customers').insert({ name: 'Alice' });
    await store.bucket('customers').insert({ name: 'Bob', tier: 'vip' });
    await store.bucket('customers').insert({ name: 'Charlie' });
    await store.bucket('orders').insert({ product: 'Widget' });

    const stats = await store.getStats();

    expect(stats.records.total).toBe(4);
    expect(stats.records.perBucket.customers).toBe(3);
    expect(stats.records.perBucket.orders).toBe(1);
  });

  it('returns correct index counts', async () => {
    store = await Store.start({ name: 'stats-indexes', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);
    await store.defineBucket('orders', ordersDef);
    await store.defineBucket('products', productsDef);

    const stats = await store.getStats();

    // customers has 1 index (tier), orders has 0, products has 1 (category)
    expect(stats.indexes.total).toBe(2);
    expect(stats.indexes.perBucket.customers).toBe(1);
    expect(stats.indexes.perBucket.orders).toBe(0);
    expect(stats.indexes.perBucket.products).toBe(1);
  });

  it('returns correct query stats with definitions and subscriptions', async () => {
    store = await Store.start({ name: 'stats-queries', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    store.defineQuery('all-customers', async (ctx) => ctx.bucket('customers').all());
    store.defineQuery('vip-customers', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const statsBeforeSub = await store.getStats();
    expect(statsBeforeSub.queries.defined).toBe(2);
    expect(statsBeforeSub.queries.activeSubscriptions).toBe(0);

    const unsub1 = await store.subscribe('all-customers', () => {});
    const unsub2 = await store.subscribe('vip-customers', () => {});

    const statsAfterSub = await store.getStats();
    expect(statsAfterSub.queries.defined).toBe(2);
    expect(statsAfterSub.queries.activeSubscriptions).toBe(2);

    unsub1();

    const statsAfterUnsub = await store.getStats();
    expect(statsAfterUnsub.queries.activeSubscriptions).toBe(1);

    unsub2();
  });

  it('reports persistence disabled when not configured', async () => {
    store = await Store.start({ name: 'stats-no-persist', ttlCheckIntervalMs: 0 });

    const stats = await store.getStats();
    expect(stats.persistence.enabled).toBe(false);
  });

  it('reports TTL enabled with correct interval', async () => {
    store = await Store.start({ name: 'stats-ttl', ttlCheckIntervalMs: 2000 });

    const stats = await store.getStats();
    expect(stats.ttl.enabled).toBe(true);
    expect(stats.ttl.checkIntervalMs).toBe(2000);
  });

  it('reports TTL disabled when checkIntervalMs is 0', async () => {
    store = await Store.start({ name: 'stats-no-ttl', ttlCheckIntervalMs: 0 });

    const stats = await store.getStats();
    expect(stats.ttl.enabled).toBe(false);
    expect(stats.ttl.checkIntervalMs).toBe(0);
  });

  it('reflects bucket removal after dropBucket', async () => {
    store = await Store.start({ name: 'stats-drop', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);
    await store.defineBucket('orders', ordersDef);

    await store.bucket('customers').insert({ name: 'Alice' });
    await store.bucket('orders').insert({ product: 'Widget' });

    const statsBefore = await store.getStats();
    expect(statsBefore.buckets.count).toBe(2);
    expect(statsBefore.records.total).toBe(2);

    await store.dropBucket('customers');

    const statsAfter = await store.getStats();
    expect(statsAfter.buckets.count).toBe(1);
    expect(statsAfter.buckets.names).toEqual(['orders']);
    expect(statsAfter.records.total).toBe(1);
    expect(statsAfter.records.perBucket.customers).toBeUndefined();
    expect(statsAfter.records.perBucket.orders).toBe(1);
  });

  it('updates record counts after deletes', async () => {
    store = await Store.start({ name: 'stats-delete', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const alice = await store.bucket('customers').insert({ name: 'Alice' });
    await store.bucket('customers').insert({ name: 'Bob' });

    const statsBefore = await store.getStats();
    expect(statsBefore.records.total).toBe(2);

    await store.bucket('customers').delete((alice as Record<string, unknown>).id);

    const statsAfter = await store.getStats();
    expect(statsAfter.records.total).toBe(1);
    expect(statsAfter.records.perBucket.customers).toBe(1);
  });

  it('returns satisfies StoreStats type shape', async () => {
    store = await Store.start({ name: 'stats-shape', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const stats: StoreStats = await store.getStats();

    // Verify all top-level keys exist
    expect(stats).toHaveProperty('name');
    expect(stats).toHaveProperty('buckets');
    expect(stats).toHaveProperty('records');
    expect(stats).toHaveProperty('indexes');
    expect(stats).toHaveProperty('queries');
    expect(stats).toHaveProperty('persistence');
    expect(stats).toHaveProperty('ttl');
  });
});
