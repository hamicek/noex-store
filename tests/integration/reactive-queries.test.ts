import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store, QueryNotDefinedError } from '../../src/core/store.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    tier: { type: 'string', enum: ['basic', 'silver', 'vip'], default: 'basic' },
  },
  indexes: ['tier'],
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    customerId: { type: 'string', required: true },
    amount: { type: 'number', required: true },
  },
  indexes: ['customerId'],
};

// ── Helpers ──────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

async function createStore(): Promise<Store> {
  store = await Store.start();
  await store.defineBucket('customers', customersDef);
  await store.defineBucket('orders', ordersDef);
  return store;
}

// ── Basic lifecycle ──────────────────────────────────────────────

describe('reactive queries: basic lifecycle', () => {
  it('defineQuery → subscribe → insert → settle → callback fires', async () => {
    const s = await createStore();

    s.defineQuery('vips', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const results: unknown[] = [];
    await s.subscribe('vips', (vips) => { results.push(vips); });

    await s.bucket('customers').insert({ name: 'Alice', tier: 'vip' });
    await s.settle();

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveLength(1);
    expect((results[0] as StoreRecord[])[0]!.name).toBe('Alice');
  });
});

// ── Callback only on actual change ──────────────────────────────

describe('reactive queries: callback only on actual change', () => {
  it('skips callback when insert does not affect query result', async () => {
    const s = await createStore();

    s.defineQuery('vips', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const callback = vi.fn();
    await s.subscribe('vips', callback);

    // Insert a basic customer — VIP list stays empty
    await s.bucket('customers').insert({ name: 'Alice', tier: 'basic' });
    await s.settle();

    expect(callback).not.toHaveBeenCalled();
  });

  it('fires callback when insert matches query filter', async () => {
    const s = await createStore();

    s.defineQuery('vips', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const callback = vi.fn();
    await s.subscribe('vips', callback);

    // Basic customer — no callback
    await s.bucket('customers').insert({ name: 'Alice', tier: 'basic' });
    await s.settle();
    expect(callback).not.toHaveBeenCalled();

    // VIP customer — callback fires
    await s.bucket('customers').insert({ name: 'Bob', tier: 'vip' });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(1);

    const result = callback.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Bob');
  });
});

// ── Update triggers re-evaluation ───────────────────────────────

describe('reactive queries: update triggers re-evaluation', () => {
  it('fires callback when update changes query result', async () => {
    const s = await createStore();

    s.defineQuery('vips', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const callback = vi.fn();
    await s.subscribe('vips', callback);

    // Insert basic → no callback
    const alice = await s.bucket('customers').insert({ name: 'Alice', tier: 'basic' });
    await s.settle();
    expect(callback).not.toHaveBeenCalled();

    // Update tier to VIP → callback fires
    await s.bucket('customers').update(alice.id, { tier: 'vip' });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Alice');
    expect(result[0]!.tier).toBe('vip');
  });
});

// ── Delete triggers re-evaluation ───────────────────────────────

describe('reactive queries: delete triggers re-evaluation', () => {
  it('fires callback when delete changes query result', async () => {
    const s = await createStore();

    // Insert a VIP before subscribing
    const bob = await s.bucket('customers').insert({ name: 'Bob', tier: 'vip' });

    s.defineQuery('vips', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const callback = vi.fn();
    await s.subscribe('vips', callback);

    // Delete VIP → callback fires with empty result
    await s.bucket('customers').delete(bob.id);
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toEqual([]);
  });
});

// ── Multiple buckets dependency ─────────────────────────────────

describe('reactive queries: multiple bucket dependencies', () => {
  it('re-evaluates when any dependent bucket changes', async () => {
    const s = await createStore();

    s.defineQuery('summary', async (ctx) => {
      const customers = await ctx.bucket('customers').all();
      const orders = await ctx.bucket('orders').all();
      return { customerCount: customers.length, orderCount: orders.length };
    });

    const callback = vi.fn();
    await s.subscribe('summary', callback);

    // Change in customers → re-evaluation
    await s.bucket('customers').insert({ name: 'Alice' });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toEqual({ customerCount: 1, orderCount: 0 });

    // Change in orders → re-evaluation
    await s.bucket('orders').insert({ customerId: 'x', amount: 100 });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1]![0]).toEqual({ customerCount: 1, orderCount: 1 });
  });

  it('does NOT re-evaluate for changes in unrelated buckets', async () => {
    const s = await createStore();

    // Query reads only from 'customers'
    s.defineQuery('customerCount', async (ctx) =>
      ctx.bucket('customers').count(),
    );

    const callback = vi.fn();
    await s.subscribe('customerCount', callback);

    // Change in 'orders' — unrelated bucket
    await s.bucket('orders').insert({ customerId: 'x', amount: 50 });
    await s.settle();

    expect(callback).not.toHaveBeenCalled();
  });
});

// ── Parameterized queries ────────────────────────────────────────

describe('reactive queries: parameterized queries', () => {
  it('passes params to query function and reacts to changes', async () => {
    const s = await createStore();

    s.defineQuery('customerOrders', async (ctx, params: { customerId: string }) =>
      ctx.bucket('orders').where({ customerId: params.customerId }),
    );

    const aliceCallback = vi.fn();
    await s.subscribe('customerOrders', { customerId: 'alice-id' }, aliceCallback);

    // Insert order for alice
    await s.bucket('orders').insert({ customerId: 'alice-id', amount: 100 });
    await s.settle();

    expect(aliceCallback).toHaveBeenCalledTimes(1);
    const result = aliceCallback.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customerId).toBe('alice-id');
  });

  it('independent params result in independent callbacks', async () => {
    const s = await createStore();

    s.defineQuery('customerOrders', async (ctx, params: { customerId: string }) =>
      ctx.bucket('orders').where({ customerId: params.customerId }),
    );

    const aliceCb = vi.fn();
    const bobCb = vi.fn();
    await s.subscribe('customerOrders', { customerId: 'alice' }, aliceCb);
    await s.subscribe('customerOrders', { customerId: 'bob' }, bobCb);

    // Order for alice only
    await s.bucket('orders').insert({ customerId: 'alice', amount: 100 });
    await s.settle();

    expect(aliceCb).toHaveBeenCalledTimes(1);
    // Bob's result stays [] → deep-equal → no callback
    expect(bobCb).not.toHaveBeenCalled();
  });
});

// ── runQuery ─────────────────────────────────────────────────────

describe('reactive queries: runQuery', () => {
  it('executes query once and returns the result', async () => {
    const s = await createStore();

    await s.bucket('customers').insert({ name: 'Alice', tier: 'vip' });
    await s.bucket('customers').insert({ name: 'Bob', tier: 'basic' });

    s.defineQuery('vips', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const result = await s.runQuery<StoreRecord[]>('vips');

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Alice');
  });

  it('throws QueryNotDefinedError for unknown query', async () => {
    const s = await createStore();

    await expect(s.runQuery('nonexistent')).rejects.toThrow(QueryNotDefinedError);
  });
});

// ── Multiple subscribers ─────────────────────────────────────────

describe('reactive queries: multiple subscribers', () => {
  it('notifies all subscribers on the same query', async () => {
    const s = await createStore();

    s.defineQuery('allCustomers', async (ctx) =>
      ctx.bucket('customers').all(),
    );

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    await s.subscribe('allCustomers', cb1);
    await s.subscribe('allCustomers', cb2);

    await s.bucket('customers').insert({ name: 'Alice' });
    await s.settle();

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});

// ── Unsubscribe ──────────────────────────────────────────────────

describe('reactive queries: unsubscribe', () => {
  it('stops callbacks after unsubscribe', async () => {
    const s = await createStore();

    s.defineQuery('allCustomers', async (ctx) =>
      ctx.bucket('customers').all(),
    );

    const callback = vi.fn();
    const unsub = await s.subscribe('allCustomers', callback);

    await s.bucket('customers').insert({ name: 'Alice' });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(1);

    unsub();

    await s.bucket('customers').insert({ name: 'Bob' });
    await s.settle();

    // Still 1 — no new calls after unsub
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// ── Error resilience ─────────────────────────────────────────────

describe('reactive queries: error resilience', () => {
  it('failing query does not break other subscriptions', async () => {
    const s = await createStore();

    s.defineQuery('flakyQuery', async () => {
      throw new Error('Boom');
    });
    s.defineQuery('allCustomers', async (ctx) =>
      ctx.bucket('customers').all(),
    );

    const flakyCb = vi.fn();
    const stableCb = vi.fn();

    // Both queries depend on customers (flaky accesses none, but let's trigger manually)
    await s.subscribe('allCustomers', stableCb);

    // flakyQuery throws during initial evaluation — subscribe should still succeed
    // since the query itself throws, we need to handle it; let's define a query
    // that only throws on re-evaluation
    s.defineQuery('flakyOnReeval', async (ctx) => {
      const all = await ctx.bucket('customers').all();
      if (all.length > 0) throw new Error('Transient failure');
      return all;
    });

    await s.subscribe('flakyOnReeval', flakyCb);

    await s.bucket('customers').insert({ name: 'Alice' });
    await s.settle();

    // Flaky throws during re-evaluation → no callback
    expect(flakyCb).not.toHaveBeenCalled();
    // Stable query works fine
    expect(stableCb).toHaveBeenCalledTimes(1);
  });
});

// ── Deep equality: same result after mutation ────────────────────

describe('reactive queries: deep equality', () => {
  it('skips callback when data changes but query result stays the same', async () => {
    const s = await createStore();

    // Query counts VIPs — result is a number
    s.defineQuery('vipCount', async (ctx) =>
      ctx.bucket('customers').count({ tier: 'vip' }),
    );

    const callback = vi.fn();
    await s.subscribe('vipCount', callback);

    // Insert basic customer — count stays 0
    await s.bucket('customers').insert({ name: 'Alice', tier: 'basic' });
    await s.settle();

    expect(callback).not.toHaveBeenCalled();
  });

  it('skips callback when re-evaluated result is structurally equal', async () => {
    const s = await createStore();

    // Query returns an object derived from customer data
    s.defineQuery('tierStats', async (ctx) => {
      const vips = await ctx.bucket('customers').where({ tier: 'vip' });
      return { vipCount: vips.length };
    });

    const callback = vi.fn();
    await s.subscribe('tierStats', callback);

    // Insert basic customer — vipCount stays 0, result { vipCount: 0 }
    await s.bucket('customers').insert({ name: 'Alice', tier: 'basic' });
    await s.settle();

    expect(callback).not.toHaveBeenCalled();

    // Insert VIP → { vipCount: 1 } — different from { vipCount: 0 }
    await s.bucket('customers').insert({ name: 'Bob', tier: 'vip' });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toEqual({ vipCount: 1 });
  });
});

// ── End-to-end verification from plan ────────────────────────────

describe('reactive queries: end-to-end verification', () => {
  it('matches the verification scenario from the plan', async () => {
    const s = await createStore();

    s.defineQuery('vips', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const results: unknown[] = [];
    const unsub = await s.subscribe('vips', (vips) => { results.push(vips); });

    // Insert basic customer → result stays [] → deep-equal → no callback
    await s.bucket('customers').insert({ name: 'A', tier: 'basic' });
    await s.settle();
    expect(results).toHaveLength(0);

    // Insert VIP → result changes to [Bob]
    const bob = await s.bucket('customers').insert({ name: 'B', tier: 'vip' });
    await s.settle();

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveLength(1);
    expect((results[0] as StoreRecord[])[0]!.name).toBe('B');

    // Update Bob's tier back to basic → VIP list empty again
    await s.bucket('customers').update(bob.id, { tier: 'basic' });
    await s.settle();

    expect(results).toHaveLength(2);
    expect(results[1]).toEqual([]);

    unsub();

    // After unsub, no more callbacks
    await s.bucket('customers').insert({ name: 'C', tier: 'vip' });
    await s.settle();

    expect(results).toHaveLength(2);
  });

  it('runQuery returns current result without subscription', async () => {
    const s = await createStore();

    await s.bucket('customers').insert({ name: 'Alice', tier: 'vip' });

    s.defineQuery('vips', async (ctx) =>
      ctx.bucket('customers').where({ tier: 'vip' }),
    );

    const vipList = await s.runQuery<StoreRecord[]>('vips');

    expect(Array.isArray(vipList)).toBe(true);
    expect(vipList).toHaveLength(1);
    expect(vipList[0]!.name).toBe('Alice');
  });
});
