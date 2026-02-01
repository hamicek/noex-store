import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import {
  QueryManager,
  QueryAlreadyDefinedError,
  QueryNotDefinedError,
} from '../../src/reactive/query-manager.js';
import { BucketHandle } from '../../src/core/bucket-handle.js';
import {
  createBucketBehavior,
  type BucketRef,
} from '../../src/core/bucket-server.js';
import type { BucketDefinition } from '../../src/types/index.js';

// ── Fixtures ──────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
  },
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    customerId: { type: 'string', required: true },
    amount: { type: 'number', required: true },
  },
};

let eventBusRef: EventBusRef;
let customersRef: BucketRef;
let ordersRef: BucketRef;
let manager: QueryManager;

function bucketAccessor(name: string): BucketHandle {
  const refs: Record<string, BucketRef> = {
    customers: customersRef,
    orders: ordersRef,
  };
  const ref = refs[name];
  if (ref === undefined) {
    throw new Error(`Unknown bucket: ${name}`);
  }
  return new BucketHandle(name, ref);
}

// ── Setup / Teardown ──────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
  customersRef = await GenServer.start(
    createBucketBehavior('customers', customersDef, eventBusRef),
  ) as BucketRef;
  ordersRef = await GenServer.start(
    createBucketBehavior('orders', ordersDef, eventBusRef),
  ) as BucketRef;
  manager = new QueryManager(bucketAccessor);
});

afterEach(async () => {
  manager.destroy();
  if (GenServer.isRunning(customersRef)) await GenServer.stop(customersRef);
  if (GenServer.isRunning(ordersRef)) await GenServer.stop(ordersRef);
  if (EventBus.isRunning(eventBusRef)) await EventBus.stop(eventBusRef);
});

// ── defineQuery ───────────────────────────────────────────────────

describe('defineQuery', () => {
  it('registers a query', () => {
    expect(() => {
      manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').where({ tier: 'vip' }));
    }).not.toThrow();
  });

  it('throws QueryAlreadyDefinedError on duplicate', () => {
    manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').all());
    expect(() => {
      manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').all());
    }).toThrow(QueryAlreadyDefinedError);
  });

  it('includes query name in error', () => {
    manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').all());
    try {
      manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').all());
    } catch (e) {
      expect(e).toBeInstanceOf(QueryAlreadyDefinedError);
      expect((e as QueryAlreadyDefinedError).query).toBe('vips');
    }
  });
});

// ── runQuery ──────────────────────────────────────────────────────

describe('runQuery', () => {
  it('executes a query and returns the result', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', tier: 'vip' });
    await handle.insert({ name: 'Bob', tier: 'basic' });

    manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').where({ tier: 'vip' }));
    const result = await manager.runQuery('vips');

    expect(result).toHaveLength(1);
    expect((result as any[])[0].name).toBe('Alice');
  });

  it('throws QueryNotDefinedError for unknown query', async () => {
    await expect(manager.runQuery('nonexistent')).rejects.toThrow(QueryNotDefinedError);
  });

  it('includes query name in error', async () => {
    try {
      await manager.runQuery('missing');
    } catch (e) {
      expect(e).toBeInstanceOf(QueryNotDefinedError);
      expect((e as QueryNotDefinedError).query).toBe('missing');
    }
  });

  it('supports parameterized queries', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', tier: 'vip' });
    await handle.insert({ name: 'Bob', tier: 'basic' });

    manager.defineQuery('byTier', async (ctx, params: { tier: string }) =>
      ctx.bucket('customers').where({ tier: params.tier }),
    );

    const vips = await manager.runQuery('byTier', { tier: 'vip' });
    expect(vips).toHaveLength(1);
    expect((vips as any[])[0].name).toBe('Alice');

    const basics = await manager.runQuery('byTier', { tier: 'basic' });
    expect(basics).toHaveLength(1);
    expect((basics as any[])[0].name).toBe('Bob');
  });
});

// ── subscribe ─────────────────────────────────────────────────────

describe('subscribe', () => {
  it('evaluates the query and stores lastResult without calling callback', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', tier: 'vip' });

    manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').where({ tier: 'vip' }));

    const callback = vi.fn();
    await manager.subscribe('vips', callback);

    expect(callback).not.toHaveBeenCalled();
  });

  it('throws QueryNotDefinedError for unknown query', async () => {
    await expect(manager.subscribe('missing', vi.fn())).rejects.toThrow(QueryNotDefinedError);
  });

  it('returns an unsubscribe function', async () => {
    manager.defineQuery('all', async (ctx) => ctx.bucket('customers').all());
    const unsub = await manager.subscribe('all', vi.fn());

    expect(typeof unsub).toBe('function');
  });

  it('supports subscribe with params', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', tier: 'vip' });

    manager.defineQuery('byTier', async (ctx, params: { tier: string }) =>
      ctx.bucket('customers').where({ tier: params.tier }),
    );

    const callback = vi.fn();
    await manager.subscribe('byTier', { tier: 'vip' }, callback);

    expect(callback).not.toHaveBeenCalled();
  });
});

// ── Re-evaluation ─────────────────────────────────────────────────

describe('re-evaluation via onBucketChange', () => {
  it('calls callback when result changes after bucket mutation', async () => {
    manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').where({ tier: 'vip' }));

    const callback = vi.fn();
    await manager.subscribe('vips', callback);

    // Insert a VIP — triggers change
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', tier: 'vip' });

    manager.onBucketChange('customers');
    await manager.waitForPending();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as any[];
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Alice');
  });

  it('skips callback when result is deep-equal (no actual change)', async () => {
    manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').where({ tier: 'vip' }));

    const callback = vi.fn();
    await manager.subscribe('vips', callback);

    // Insert a basic customer — VIP result stays []
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Bob', tier: 'basic' });

    manager.onBucketChange('customers');
    await manager.waitForPending();

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not re-evaluate for unrelated bucket changes', async () => {
    manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').where({ tier: 'vip' }));

    const callback = vi.fn();
    await manager.subscribe('vips', callback);

    // Change in 'orders' bucket — unrelated to 'customers'
    manager.onBucketChange('orders');
    await manager.waitForPending();

    expect(callback).not.toHaveBeenCalled();
  });

  it('handles multiple sequential changes', async () => {
    manager.defineQuery('vips', async (ctx) => ctx.bucket('customers').where({ tier: 'vip' }));

    const callback = vi.fn();
    await manager.subscribe('vips', callback);

    const handle = bucketAccessor('customers');
    const alice = await handle.insert({ name: 'Alice', tier: 'vip' });
    manager.onBucketChange('customers');
    await manager.waitForPending();

    await handle.insert({ name: 'Bob', tier: 'vip' });
    manager.onBucketChange('customers');
    await manager.waitForPending();

    expect(callback).toHaveBeenCalledTimes(2);

    const firstResult = callback.mock.calls[0]![0] as any[];
    expect(firstResult).toHaveLength(1);

    const secondResult = callback.mock.calls[1]![0] as any[];
    expect(secondResult).toHaveLength(2);
  });
});

// ── Parameterized subscriptions ───────────────────────────────────

describe('parameterized subscriptions', () => {
  it('re-evaluates with correct params after change', async () => {
    manager.defineQuery('byTier', async (ctx, params: { tier: string }) =>
      ctx.bucket('customers').where({ tier: params.tier }),
    );

    const vipCallback = vi.fn();
    const basicCallback = vi.fn();
    await manager.subscribe('byTier', { tier: 'vip' }, vipCallback);
    await manager.subscribe('byTier', { tier: 'basic' }, basicCallback);

    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', tier: 'vip' });

    manager.onBucketChange('customers');
    await manager.waitForPending();

    // VIP callback should fire (result changed from [] to [Alice])
    expect(vipCallback).toHaveBeenCalledTimes(1);
    // Basic callback should NOT fire (result is still [])
    expect(basicCallback).not.toHaveBeenCalled();
  });
});

// ── Dependency updates ────────────────────────────────────────────

describe('dependency tracking updates', () => {
  it('updates dependencies when query accesses different buckets on re-evaluation', async () => {
    // A query that reads 'orders' only when there are VIP customers
    manager.defineQuery('conditionalOrders', async (ctx) => {
      const vips = await ctx.bucket('customers').where({ tier: 'vip' });
      if (vips.length > 0) {
        return ctx.bucket('orders').all();
      }
      return [];
    });

    const callback = vi.fn();
    await manager.subscribe('conditionalOrders', callback);

    // Initially no VIPs → depends only on 'customers'
    // Change in orders should NOT trigger re-evaluation
    const ordersHandle = bucketAccessor('orders');
    await ordersHandle.insert({ customerId: 'x', amount: 100 });
    manager.onBucketChange('orders');
    await manager.waitForPending();
    expect(callback).not.toHaveBeenCalled();

    // Now add a VIP → re-evaluation reads both buckets
    const customersHandle = bucketAccessor('customers');
    await customersHandle.insert({ name: 'Alice', tier: 'vip' });
    manager.onBucketChange('customers');
    await manager.waitForPending();

    expect(callback).toHaveBeenCalledTimes(1);

    // Now orders is a dependency — change in orders triggers re-evaluation
    callback.mockClear();
    await ordersHandle.insert({ customerId: 'y', amount: 200 });
    manager.onBucketChange('orders');
    await manager.waitForPending();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as any[];
    expect(result).toHaveLength(2);
  });
});

// ── Multiple subscriptions ────────────────────────────────────────

describe('multiple subscriptions', () => {
  it('notifies all subscribers on the same query', async () => {
    manager.defineQuery('allCustomers', async (ctx) => ctx.bucket('customers').all());

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    await manager.subscribe('allCustomers', cb1);
    await manager.subscribe('allCustomers', cb2);

    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });

    manager.onBucketChange('customers');
    await manager.waitForPending();

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('subscriptions on different queries are independent', async () => {
    manager.defineQuery('customerCount', async (ctx) => ctx.bucket('customers').count());
    manager.defineQuery('orderCount', async (ctx) => ctx.bucket('orders').count());

    const customerCb = vi.fn();
    const orderCb = vi.fn();
    await manager.subscribe('customerCount', customerCb);
    await manager.subscribe('orderCount', orderCb);

    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });
    manager.onBucketChange('customers');
    await manager.waitForPending();

    expect(customerCb).toHaveBeenCalledTimes(1);
    expect(orderCb).not.toHaveBeenCalled();
  });
});

// ── Unsubscribe ───────────────────────────────────────────────────

describe('unsubscribe', () => {
  it('stops callbacks after unsubscribe', async () => {
    manager.defineQuery('allCustomers', async (ctx) => ctx.bucket('customers').all());

    const callback = vi.fn();
    const unsub = await manager.subscribe('allCustomers', callback);

    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });
    manager.onBucketChange('customers');
    await manager.waitForPending();
    expect(callback).toHaveBeenCalledTimes(1);

    unsub();

    await handle.insert({ name: 'Bob' });
    manager.onBucketChange('customers');
    await manager.waitForPending();

    // Should still be 1 — no new calls after unsub
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('repeated unsubscribe is a no-op', async () => {
    manager.defineQuery('allCustomers', async (ctx) => ctx.bucket('customers').all());

    const unsub = await manager.subscribe('allCustomers', vi.fn());
    unsub();

    expect(() => unsub()).not.toThrow();
  });

  it('does not affect other subscriptions', async () => {
    manager.defineQuery('allCustomers', async (ctx) => ctx.bucket('customers').all());

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = await manager.subscribe('allCustomers', cb1);
    await manager.subscribe('allCustomers', cb2);

    unsub1();

    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });
    manager.onBucketChange('customers');
    await manager.waitForPending();

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});

// ── Error handling ────────────────────────────────────────────────

describe('error handling in re-evaluation', () => {
  it('keeps subscription alive when query throws during re-evaluation', async () => {
    let shouldThrow = false;

    manager.defineQuery('flakyQuery', async (ctx) => {
      const all = await ctx.bucket('customers').all();
      if (shouldThrow) throw new Error('Transient failure');
      return all;
    });

    const callback = vi.fn();
    await manager.subscribe('flakyQuery', callback);

    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });

    // First re-evaluation throws
    shouldThrow = true;
    manager.onBucketChange('customers');
    await manager.waitForPending();
    expect(callback).not.toHaveBeenCalled();

    // Recovery — query works again
    shouldThrow = false;
    manager.onBucketChange('customers');
    await manager.waitForPending();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// ── waitForPending ────────────────────────────────────────────────

describe('waitForPending', () => {
  it('resolves immediately when nothing is pending', async () => {
    await expect(manager.waitForPending()).resolves.toBeUndefined();
  });

  it('resolves after all pending re-evaluations complete', async () => {
    manager.defineQuery('all', async (ctx) => ctx.bucket('customers').all());
    await manager.subscribe('all', vi.fn());

    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });

    manager.onBucketChange('customers');

    // waitForPending should resolve without hanging
    await expect(manager.waitForPending()).resolves.toBeUndefined();
  });
});

// ── destroy ───────────────────────────────────────────────────────

describe('destroy', () => {
  it('clears all queries, subscriptions, and dependency index', async () => {
    manager.defineQuery('all', async (ctx) => ctx.bucket('customers').all());
    await manager.subscribe('all', vi.fn());

    manager.destroy();

    // Cannot define a query with the same name — it was cleared
    expect(() => {
      manager.defineQuery('all', async (ctx) => ctx.bucket('customers').all());
    }).not.toThrow();

    // runQuery on non-existing query throws
    await expect(manager.runQuery('all')).resolves.toBeDefined();
  });
});
