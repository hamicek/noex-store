import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import {
  createBucketBehavior,
  type BucketRef,
  type BucketCallMsg,
  type BucketCallReply,
} from '../../src/core/bucket-server.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';
import { Store } from '../../src/core/store.js';

// ── Helpers ──────────────────────────────────────────────────────

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    customer: { type: 'string', required: true },
    status: { type: 'string', required: true },
    amount: { type: 'number', required: true },
    notes: { type: 'string' },
    priority: { type: 'number' },
  },
  indexes: ['status'],
};

let eventBusRef: EventBusRef;
let bucketRef: BucketRef;

async function startBucket(def: BucketDefinition = ordersDef): Promise<BucketRef> {
  const behavior = createBucketBehavior('orders', def, eventBusRef);
  return GenServer.start(behavior) as Promise<BucketRef>;
}

function call(msg: BucketCallMsg): Promise<BucketCallReply> {
  return GenServer.call(bucketRef, msg);
}

async function seedOrders(): Promise<StoreRecord[]> {
  const r1 = await call({ type: 'insert', data: { customer: 'Alice', status: 'paid', amount: 100, notes: 'Express delivery', priority: 1 } }) as StoreRecord;
  const r2 = await call({ type: 'insert', data: { customer: 'Bob', status: 'pending', amount: 250, notes: 'Gift wrapping', priority: 2 } }) as StoreRecord;
  const r3 = await call({ type: 'insert', data: { customer: 'Charlie', status: 'shipped', amount: 75, notes: 'Fragile items', priority: 1 } }) as StoreRecord;
  const r4 = await call({ type: 'insert', data: { customer: 'Diana', status: 'paid', amount: 500, priority: 3 } }) as StoreRecord;
  const r5 = await call({ type: 'insert', data: { customer: 'Eve', status: 'pending', amount: 150, notes: 'Express delivery please', priority: 2 } }) as StoreRecord;
  return [r1, r2, r3, r4, r5];
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
  bucketRef = await startBucket();
});

afterEach(async () => {
  if (GenServer.isRunning(bucketRef)) {
    await GenServer.stop(bucketRef);
  }
  if (EventBus.isRunning(eventBusRef)) {
    await EventBus.stop(eventBusRef);
  }
});

// ── Backward compatibility ──────────────────────────────────────

describe('backward compatibility', () => {
  it('plain value filter works exactly as before', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: 'paid' } }) as StoreRecord[];
    expect(result).toHaveLength(2);
    expect(result.every(r => r.status === 'paid')).toBe(true);
  });

  it('multi-field plain value filter', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: 'paid', customer: 'Alice' } }) as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Alice');
  });

  it('empty filter returns all', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: {} }) as StoreRecord[];
    expect(result).toHaveLength(5);
  });
});

// ── $eq ─────────────────────────────────────────────────────────

describe('$eq operator', () => {
  it('matches exact value', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: { $eq: 'paid' } } }) as StoreRecord[];
    expect(result).toHaveLength(2);
  });
});

// ── $neq ────────────────────────────────────────────────────────

describe('$neq operator', () => {
  it('excludes matching records', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: { $neq: 'paid' } } }) as StoreRecord[];
    expect(result).toHaveLength(3);
    expect(result.every(r => r.status !== 'paid')).toBe(true);
  });
});

// ── $gt / $gte / $lt / $lte ─────────────────────────────────────

describe('comparison operators', () => {
  it('$gt filters records with value greater than', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { amount: { $gt: 150 } } }) as StoreRecord[];
    expect(result).toHaveLength(2);
    expect(result.every(r => (r.amount as number) > 150)).toBe(true);
  });

  it('$gte includes the boundary', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { amount: { $gte: 150 } } }) as StoreRecord[];
    expect(result).toHaveLength(3); // 250, 500, 150
  });

  it('$lt filters records with value less than', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { amount: { $lt: 100 } } }) as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Charlie');
  });

  it('$lte includes the boundary', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { amount: { $lte: 100 } } }) as StoreRecord[];
    expect(result).toHaveLength(2); // 100, 75
  });

  it('$gt with null/undefined values excludes them', async () => {
    await seedOrders();
    // priority field: 1, 2, 1, 3, 2 — all defined
    const result = await call({ type: 'where', filter: { priority: { $gt: 1 } } }) as StoreRecord[];
    expect(result).toHaveLength(3);
  });

  it('comparison with strings works lexicographically', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { customer: { $gte: 'Charlie' } } }) as StoreRecord[];
    expect(result.map(r => r.customer).sort()).toEqual(['Charlie', 'Diana', 'Eve']);
  });
});

// ── $in / $nin ──────────────────────────────────────────────────

describe('$in / $nin operators', () => {
  it('$in matches records with value in array', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: { $in: ['paid', 'shipped'] } } }) as StoreRecord[];
    expect(result).toHaveLength(3);
  });

  it('$in with single-element array', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: { $in: ['shipped'] } } }) as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Charlie');
  });

  it('$in with empty array matches nothing', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: { $in: [] } } }) as StoreRecord[];
    expect(result).toHaveLength(0);
  });

  it('$nin excludes records with value in array', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: { $nin: ['paid', 'shipped'] } } }) as StoreRecord[];
    expect(result).toHaveLength(2);
    expect(result.every(r => r.status === 'pending')).toBe(true);
  });

  it('$nin with empty array matches everything', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: { $nin: [] } } }) as StoreRecord[];
    expect(result).toHaveLength(5);
  });
});

// ── $contains / $startsWith / $endsWith ─────────────────────────

describe('string operators', () => {
  it('$contains — case-insensitive substring', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { notes: { $contains: 'express' } } }) as StoreRecord[];
    expect(result).toHaveLength(2);
    expect(result.map(r => r.customer).sort()).toEqual(['Alice', 'Eve']);
  });

  it('$contains does not match non-string fields', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { amount: { $contains: '100' } } }) as StoreRecord[];
    expect(result).toHaveLength(0);
  });

  it('$startsWith — exact prefix match', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { notes: { $startsWith: 'Express' } } }) as StoreRecord[];
    expect(result).toHaveLength(2);
  });

  it('$startsWith is case-sensitive', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { notes: { $startsWith: 'express' } } }) as StoreRecord[];
    expect(result).toHaveLength(0);
  });

  it('$endsWith — exact suffix match', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { notes: { $endsWith: 'delivery' } } }) as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Alice');
  });

  it('$endsWith is case-sensitive', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { notes: { $endsWith: 'Delivery' } } }) as StoreRecord[];
    expect(result).toHaveLength(0);
  });
});

// ── $exists ─────────────────────────────────────────────────────

describe('$exists operator', () => {
  it('$exists: true matches records where field is defined and non-null', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { notes: { $exists: true } } }) as StoreRecord[];
    // Diana has no notes (undefined)
    expect(result).toHaveLength(4);
  });

  it('$exists: false matches records where field is null/undefined', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { notes: { $exists: false } } }) as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Diana');
  });
});

// ── $between ────────────────────────────────────────────────────

describe('$between operator', () => {
  it('inclusive range match', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { amount: { $between: [100, 250] } } }) as StoreRecord[];
    expect(result).toHaveLength(3); // 100, 250, 150
  });

  it('range with no matches', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { amount: { $between: [300, 400] } } }) as StoreRecord[];
    expect(result).toHaveLength(0);
  });

  it('single-point range (lower === upper)', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { amount: { $between: [100, 100] } } }) as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Alice');
  });

  it('excludes null/undefined values', async () => {
    await seedOrders();
    // priority: 1, 2, 1, 3, 2 — all defined
    const result = await call({ type: 'where', filter: { priority: { $between: [1, 2] } } }) as StoreRecord[];
    expect(result).toHaveLength(4);
  });
});

// ── Combined operators on single field ──────────────────────────

describe('combined operators on single field', () => {
  it('$gte + $lt = half-open range', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { amount: { $gte: 100, $lt: 250 } } }) as StoreRecord[];
    expect(result).toHaveLength(2); // 100, 150
  });

  it('$neq + $in narrows result', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { status: { $in: ['paid', 'pending'], $neq: 'paid' } } }) as StoreRecord[];
    expect(result).toHaveLength(2);
    expect(result.every(r => r.status === 'pending')).toBe(true);
  });
});

// ── $or / $and logical combinators ──────────────────────────────

describe('$or combinator', () => {
  it('matches records satisfying any condition', async () => {
    await seedOrders();
    const result = await call({
      type: 'where',
      filter: {
        $or: [
          { status: 'shipped' },
          { amount: { $gt: 400 } },
        ],
      },
    }) as StoreRecord[];
    expect(result).toHaveLength(2); // Charlie (shipped) + Diana (500)
  });

  it('$or with no matching branches returns empty', async () => {
    await seedOrders();
    const result = await call({
      type: 'where',
      filter: {
        $or: [
          { status: 'cancelled' },
          { amount: { $gt: 1000 } },
        ],
      },
    }) as StoreRecord[];
    expect(result).toHaveLength(0);
  });
});

describe('$and combinator', () => {
  it('matches records satisfying all conditions', async () => {
    await seedOrders();
    const result = await call({
      type: 'where',
      filter: {
        $and: [
          { status: 'paid' },
          { amount: { $gt: 200 } },
        ],
      },
    }) as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Diana');
  });
});

describe('mixed $or/$and with field-level filters', () => {
  it('field-level + $or combined', async () => {
    await seedOrders();
    const result = await call({
      type: 'where',
      filter: {
        priority: { $lte: 2 },
        $or: [
          { status: 'paid' },
          { status: 'shipped' },
        ],
      },
    }) as StoreRecord[];
    // priority <= 2: Alice(1), Bob(2), Charlie(1), Eve(2)
    // AND (paid OR shipped): Alice(paid,1), Charlie(shipped,1)
    expect(result).toHaveLength(2);
    expect(result.map(r => r.customer).sort()).toEqual(['Alice', 'Charlie']);
  });

  it('nested $or inside $and', async () => {
    await seedOrders();
    const result = await call({
      type: 'where',
      filter: {
        $and: [
          { amount: { $gte: 100 } },
          {
            $or: [
              { status: 'paid' },
              { status: 'pending' },
            ],
          },
        ],
      },
    }) as StoreRecord[];
    // amount >= 100: Alice(100), Bob(250), Diana(500), Eve(150)
    // AND (paid OR pending): Alice(paid), Bob(pending), Diana(paid), Eve(pending)
    expect(result).toHaveLength(4);
  });
});

// ── findOne with operators ──────────────────────────────────────

describe('findOne with operators', () => {
  it('returns first matching record', async () => {
    await seedOrders();
    const result = await call({
      type: 'findOne',
      filter: { amount: { $gt: 200 } },
    }) as StoreRecord;
    expect(result).toBeDefined();
    expect((result.amount as number) > 200).toBe(true);
  });

  it('returns undefined when no match', async () => {
    await seedOrders();
    const result = await call({
      type: 'findOne',
      filter: { amount: { $gt: 1000 } },
    });
    expect(result).toBeUndefined();
  });
});

// ── count with operators ────────────────────────────────────────

describe('count with operators', () => {
  it('counts records matching operator filter', async () => {
    await seedOrders();
    const result = await call({
      type: 'count',
      filter: { amount: { $gte: 150 } },
    });
    expect(result).toBe(3);
  });
});

// ── Aggregations with operators ─────────────────────────────────

describe('aggregations with operator filters', () => {
  it('sum with operator filter', async () => {
    await seedOrders();
    const result = await call({
      type: 'sum',
      field: 'amount',
      filter: { status: { $in: ['paid', 'shipped'] } },
    });
    expect(result).toBe(100 + 75 + 500);
  });

  it('avg with operator filter', async () => {
    await seedOrders();
    const result = await call({
      type: 'avg',
      field: 'amount',
      filter: { amount: { $gt: 100 } },
    });
    // 250, 500, 150 → avg = 300
    expect(result).toBe(300);
  });

  it('min with operator filter', async () => {
    await seedOrders();
    const result = await call({
      type: 'min',
      field: 'amount',
      filter: { status: 'paid' },
    });
    expect(result).toBe(100);
  });

  it('max with operator filter', async () => {
    await seedOrders();
    const result = await call({
      type: 'max',
      field: 'amount',
      filter: { amount: { $lte: 200 } },
    });
    expect(result).toBe(150);
  });
});

// ── Index interaction ───────────────────────────────────────────

describe('index interaction', () => {
  it('plain value on indexed field uses index (same result as without index)', async () => {
    await seedOrders();
    // status is indexed
    const result = await call({ type: 'where', filter: { status: 'paid' } }) as StoreRecord[];
    expect(result).toHaveLength(2);
    expect(result.every(r => r.status === 'paid')).toBe(true);
  });

  it('operator on indexed field falls back to scan (correct result)', async () => {
    await seedOrders();
    const result = await call({
      type: 'where',
      filter: { status: { $in: ['paid', 'shipped'] } },
    }) as StoreRecord[];
    expect(result).toHaveLength(3);
  });

  it('plain value on indexed field + operator on another field', async () => {
    await seedOrders();
    const result = await call({
      type: 'where',
      filter: { status: 'paid', amount: { $gt: 200 } },
    }) as StoreRecord[];
    // Uses index for status=paid (Alice 100, Diana 500), then filters amount > 200 → Diana
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Diana');
  });
});

// ── Edge cases ──────────────────────────────────────────────────

describe('edge cases', () => {
  it('filter on non-existent field returns no matches', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { ghost: 'value' } }) as StoreRecord[];
    expect(result).toHaveLength(0);
  });

  it('$exists false on non-existent field matches all', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { ghost: { $exists: false } } }) as StoreRecord[];
    expect(result).toHaveLength(5);
  });

  it('$exists true on non-existent field matches none', async () => {
    await seedOrders();
    const result = await call({ type: 'where', filter: { ghost: { $exists: true } } }) as StoreRecord[];
    expect(result).toHaveLength(0);
  });

  it('$eq undefined is a no-op — use $exists: false instead', async () => {
    await seedOrders();
    // $eq: undefined is indistinguishable from "not set" — matches all records
    const result = await call({ type: 'where', filter: { notes: { $eq: undefined } } }) as StoreRecord[];
    expect(result).toHaveLength(5);

    // The correct way to find records with undefined/null fields:
    const noNotes = await call({ type: 'where', filter: { notes: { $exists: false } } }) as StoreRecord[];
    expect(noNotes).toHaveLength(1);
    expect(noNotes[0]!.customer).toBe('Diana');
  });
});

// ── Declarative queries with operators ──────────────────────────

describe('declarative queries with operators', () => {
  let store: Store;

  afterEach(async () => {
    if (store !== undefined) {
      await store.stop();
    }
  });

  async function createStore(): Promise<Store> {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('orders', ordersDef);
    return store;
  }

  async function seedStoreOrders(s: Store): Promise<void> {
    const b = s.bucket('orders');
    await b.insert({ customer: 'Alice', status: 'paid', amount: 100, notes: 'Express', priority: 1 });
    await b.insert({ customer: 'Bob', status: 'pending', amount: 250, notes: 'Gift', priority: 2 });
    await b.insert({ customer: 'Charlie', status: 'shipped', amount: 75, notes: 'Fragile', priority: 1 });
    await b.insert({ customer: 'Diana', status: 'paid', amount: 500, priority: 3 });
  }

  it('declarative query with operator filter', async () => {
    const s = await createStore();
    await seedStoreOrders(s);

    s.defineDeclarativeQuery('high-value', {
      bucket: 'orders',
      filter: { amount: { $gt: 200 } },
      sort: { amount: 'desc' },
    });

    const result = await s.runQuery<StoreRecord[]>('high-value');
    expect(result).toHaveLength(2);
    expect(result[0]!.customer).toBe('Diana');
    expect(result[1]!.customer).toBe('Bob');
  });

  it('declarative query with $or filter', async () => {
    const s = await createStore();
    await seedStoreOrders(s);

    s.defineDeclarativeQuery('active', {
      bucket: 'orders',
      filter: {
        $or: [
          { status: 'paid' },
          { status: 'pending' },
        ],
      },
    });

    const result = await s.runQuery<StoreRecord[]>('active');
    expect(result).toHaveLength(3);
  });

  it('declarative query with parameter interpolation inside operators', async () => {
    const s = await createStore();
    await seedStoreOrders(s);

    s.defineDeclarativeQuery('above-threshold', {
      bucket: 'orders',
      filter: { amount: { $gt: '{{ params.minAmount }}' } },
    });

    const result = await s.runQuery<StoreRecord[]>('above-threshold', { minAmount: 100 });
    expect(result).toHaveLength(2); // 250, 500
  });

  it('declarative query aggregation with operator filter', async () => {
    const s = await createStore();
    await seedStoreOrders(s);

    s.defineDeclarativeQuery('paid-total', {
      bucket: 'orders',
      filter: { status: 'paid' },
      aggregate: { function: 'sum', field: 'amount' },
    });

    const result = await s.runQuery<number>('paid-total');
    expect(result).toBe(600);
  });
});

// ── Reactive subscriptions with operators ────────────────────────

describe('reactive subscriptions with operators', () => {
  let store: Store;

  afterEach(async () => {
    if (store !== undefined) {
      await store.stop();
    }
  });

  async function createStore(): Promise<Store> {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('orders', ordersDef);
    return store;
  }

  it('subscription re-evaluates when matching record is inserted', async () => {
    const s = await createStore();
    const b = s.bucket('orders');
    await b.insert({ customer: 'Alice', status: 'paid', amount: 100, priority: 1 });

    s.defineQuery('big-orders', async (ctx) => {
      return ctx.bucket('orders').where({ amount: { $gt: 200 } });
    });

    const callback = vi.fn();
    await s.subscribe('big-orders', callback);

    // Insert a high-value order — should trigger
    await b.insert({ customer: 'Bob', status: 'paid', amount: 500, priority: 2 });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Bob');
  });

  it('subscription re-evaluates when record is updated to match', async () => {
    const s = await createStore();
    const b = s.bucket('orders');
    const order = await b.insert({ customer: 'Alice', status: 'pending', amount: 100, priority: 1 });

    s.defineQuery('paid-orders', async (ctx) => {
      return ctx.bucket('orders').where({ status: { $in: ['paid', 'shipped'] } });
    });

    const callback = vi.fn();
    await s.subscribe('paid-orders', callback);

    await b.update(order.id, { status: 'paid' });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('paid');
  });

  it('declarative subscription with operator filter re-evaluates', async () => {
    const s = await createStore();
    const b = s.bucket('orders');
    await b.insert({ customer: 'Alice', status: 'paid', amount: 100, priority: 1 });

    s.defineDeclarativeQuery('expensive', {
      bucket: 'orders',
      filter: { amount: { $gte: 500 } },
    });

    const callback = vi.fn();
    await s.subscribe('expensive', callback);

    await b.insert({ customer: 'Diana', status: 'paid', amount: 500, priority: 3 });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.customer).toBe('Diana');
  });
});
