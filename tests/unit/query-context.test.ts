import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import { QueryContextImpl } from '../../src/reactive/query-context.js';
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
    score: { type: 'number', default: 0 },
  },
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    amount: { type: 'number', required: true },
  },
};

let eventBusRef: EventBusRef;
let customersRef: BucketRef;
let ordersRef: BucketRef;

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
  const customersBehavior = createBucketBehavior('customers', customersDef, eventBusRef);
  customersRef = await GenServer.start(customersBehavior) as BucketRef;
  const ordersBehavior = createBucketBehavior('orders', ordersDef, eventBusRef);
  ordersRef = await GenServer.start(ordersBehavior) as BucketRef;
});

afterEach(async () => {
  if (GenServer.isRunning(customersRef)) await GenServer.stop(customersRef);
  if (GenServer.isRunning(ordersRef)) await GenServer.stop(ordersRef);
  if (EventBus.isRunning(eventBusRef)) await EventBus.stop(eventBusRef);
});

// ── Two-level dependency tracking ────────────────────────────────

describe('QueryContextImpl two-level dependency tracking', () => {
  it('get() creates a record-level dependency', async () => {
    const handle = bucketAccessor('customers');
    const inserted = await handle.insert({ name: 'Alice' });

    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').get(inserted.id);

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel.size).toBe(0);
    expect(deps.recordLevel.size).toBe(1);
    expect(deps.recordLevel.get('customers')).toEqual(new Set([inserted.id]));
  });

  it('where() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').where({ tier: 'vip' });

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('all() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').all();

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('findOne() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').findOne({ tier: 'vip' });

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('count() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').count();

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('first() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').first(5);

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('last() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').last(5);

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('paginate() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').paginate({ limit: 10 });

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('sum() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').sum('score');

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('avg() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').avg('score');

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('min() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').min('score');

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('max() creates a bucket-level dependency', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').max('score');

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    expect(deps.recordLevel.size).toBe(0);
  });

  it('get + where on same bucket — bucket-level subsumes record-level', async () => {
    const handle = bucketAccessor('customers');
    const inserted = await handle.insert({ name: 'Alice' });

    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').get(inserted.id);
    await ctx.bucket('customers').where({ tier: 'vip' });

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers']));
    // record-level key is still tracked, but bucket-level takes precedence
    expect(deps.recordLevel.get('customers')).toEqual(new Set([inserted.id]));
  });

  it('get on different buckets creates separate record-level entries', async () => {
    const customersHandle = bucketAccessor('customers');
    const customer = await customersHandle.insert({ name: 'Alice' });
    const ordersHandle = bucketAccessor('orders');
    const order = await ordersHandle.insert({ amount: 100 });

    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').get(customer.id);
    await ctx.bucket('orders').get(order.id);

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel.size).toBe(0);
    expect(deps.recordLevel.size).toBe(2);
    expect(deps.recordLevel.get('customers')).toEqual(new Set([customer.id]));
    expect(deps.recordLevel.get('orders')).toEqual(new Set([order.id]));
  });

  it('multiple get() on same bucket accumulates keys', async () => {
    const handle = bucketAccessor('customers');
    const a = await handle.insert({ name: 'Alice' });
    const b = await handle.insert({ name: 'Bob' });

    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').get(a.id);
    await ctx.bucket('customers').get(b.id);

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel.size).toBe(0);
    expect(deps.recordLevel.get('customers')).toEqual(new Set([a.id, b.id]));
  });

  it('mixed query — get from one bucket, where from another', async () => {
    const handle = bucketAccessor('customers');
    const customer = await handle.insert({ name: 'Alice' });

    const ctx = new QueryContextImpl(bucketAccessor);
    await ctx.bucket('customers').get(customer.id);
    await ctx.bucket('orders').where({ customerId: customer.id });

    const deps = ctx.getDependencies();
    // orders is bucket-level (where)
    expect(deps.bucketLevel).toEqual(new Set(['orders']));
    // customers is record-level (get)
    expect(deps.recordLevel.size).toBe(1);
    expect(deps.recordLevel.get('customers')).toEqual(new Set([customer.id]));
  });

  it('starts with empty dependencies', () => {
    const ctx = new QueryContextImpl(bucketAccessor);

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel.size).toBe(0);
    expect(deps.recordLevel.size).toBe(0);
  });

  it('bucket() alone does not create any dependency', () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    ctx.bucket('customers');

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel.size).toBe(0);
    expect(deps.recordLevel.size).toBe(0);
  });
});

// ── Read-only API ─────────────────────────────────────────────────

describe('QueryBucketHandle read-only API', () => {
  it('does not expose insert, update, delete, or clear methods', () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    const qBucket = ctx.bucket('customers');

    // QueryBucket interface only defines read methods
    expect(typeof qBucket.get).toBe('function');
    expect(typeof qBucket.all).toBe('function');
    expect(typeof qBucket.where).toBe('function');
    expect(typeof qBucket.findOne).toBe('function');
    expect(typeof qBucket.count).toBe('function');
    expect(typeof qBucket.first).toBe('function');
    expect(typeof qBucket.last).toBe('function');
    expect(typeof qBucket.paginate).toBe('function');
    expect(typeof qBucket.sum).toBe('function');
    expect(typeof qBucket.avg).toBe('function');
    expect(typeof qBucket.min).toBe('function');
    expect(typeof qBucket.max).toBe('function');

    // Write methods must not be present
    expect('insert' in qBucket).toBe(false);
    expect('update' in qBucket).toBe(false);
    expect('delete' in qBucket).toBe(false);
    expect('clear' in qBucket).toBe(false);
  });
});

// ── Delegation to BucketHandle ────────────────────────────────────

describe('QueryBucketHandle delegation', () => {
  it('get() delegates and returns the correct record', async () => {
    const handle = bucketAccessor('customers');
    const inserted = await handle.insert({ name: 'Alice', tier: 'vip' });

    const ctx = new QueryContextImpl(bucketAccessor);
    const qBucket = ctx.bucket('customers');
    const fetched = await qBucket.get(inserted.id);

    expect(fetched).toEqual(inserted);
  });

  it('get() returns undefined for non-existing key', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    const qBucket = ctx.bucket('customers');
    const result = await qBucket.get('non-existent');

    expect(result).toBeUndefined();
  });

  it('all() delegates and returns all records', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });
    await handle.insert({ name: 'Bob' });

    const ctx = new QueryContextImpl(bucketAccessor);
    const qBucket = ctx.bucket('customers');
    const all = await qBucket.all();

    expect(all).toHaveLength(2);
    expect(all.map((r) => r.name)).toEqual(expect.arrayContaining(['Alice', 'Bob']));
  });

  it('where() delegates and filters correctly', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', tier: 'vip' });
    await handle.insert({ name: 'Bob', tier: 'basic' });

    const ctx = new QueryContextImpl(bucketAccessor);
    const qBucket = ctx.bucket('customers');
    const vips = await qBucket.where({ tier: 'vip' });

    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Alice');
  });

  it('findOne() delegates and returns the first match', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', tier: 'basic' });
    await handle.insert({ name: 'Bob', tier: 'vip' });

    const ctx = new QueryContextImpl(bucketAccessor);
    const qBucket = ctx.bucket('customers');
    const vip = await qBucket.findOne({ tier: 'vip' });

    expect(vip).toBeDefined();
    expect(vip!.name).toBe('Bob');
  });

  it('findOne() returns undefined when no match', async () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    const qBucket = ctx.bucket('customers');
    const result = await qBucket.findOne({ tier: 'vip' });

    expect(result).toBeUndefined();
  });

  it('count() delegates without filter', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });
    await handle.insert({ name: 'Bob' });

    const ctx = new QueryContextImpl(bucketAccessor);
    const qBucket = ctx.bucket('customers');
    const total = await qBucket.count();

    expect(total).toBe(2);
  });

  it('count() delegates with filter', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', tier: 'vip' });
    await handle.insert({ name: 'Bob', tier: 'basic' });
    await handle.insert({ name: 'Carol', tier: 'vip' });

    const ctx = new QueryContextImpl(bucketAccessor);
    const qBucket = ctx.bucket('customers');
    const vipCount = await qBucket.count({ tier: 'vip' });

    expect(vipCount).toBe(2);
  });

  it('first() delegates correctly', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });
    await handle.insert({ name: 'Bob' });
    await handle.insert({ name: 'Carol' });

    const ctx = new QueryContextImpl(bucketAccessor);
    const result = await ctx.bucket('customers').first(2);

    expect(result).toHaveLength(2);
  });

  it('last() delegates correctly', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });
    await handle.insert({ name: 'Bob' });
    await handle.insert({ name: 'Carol' });

    const ctx = new QueryContextImpl(bucketAccessor);
    const result = await ctx.bucket('customers').last(2);

    expect(result).toHaveLength(2);
  });

  it('paginate() delegates correctly', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice' });
    await handle.insert({ name: 'Bob' });
    await handle.insert({ name: 'Carol' });

    const ctx = new QueryContextImpl(bucketAccessor);
    const result = await ctx.bucket('customers').paginate({ limit: 2 });

    expect(result.records).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it('sum() delegates correctly', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', score: 10 });
    await handle.insert({ name: 'Bob', score: 20 });

    const ctx = new QueryContextImpl(bucketAccessor);
    const result = await ctx.bucket('customers').sum('score');

    expect(result).toBe(30);
  });

  it('avg() delegates correctly', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', score: 10 });
    await handle.insert({ name: 'Bob', score: 20 });

    const ctx = new QueryContextImpl(bucketAccessor);
    const result = await ctx.bucket('customers').avg('score');

    expect(result).toBe(15);
  });

  it('min() delegates correctly', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', score: 10 });
    await handle.insert({ name: 'Bob', score: 20 });

    const ctx = new QueryContextImpl(bucketAccessor);
    const result = await ctx.bucket('customers').min('score');

    expect(result).toBe(10);
  });

  it('max() delegates correctly', async () => {
    const handle = bucketAccessor('customers');
    await handle.insert({ name: 'Alice', score: 10 });
    await handle.insert({ name: 'Bob', score: 20 });

    const ctx = new QueryContextImpl(bucketAccessor);
    const result = await ctx.bucket('customers').max('score');

    expect(result).toBe(20);
  });

  it('delegates to different buckets independently', async () => {
    const customersHandle = bucketAccessor('customers');
    await customersHandle.insert({ name: 'Alice' });

    const ordersHandle = bucketAccessor('orders');
    await ordersHandle.insert({ amount: 100 });
    await ordersHandle.insert({ amount: 200 });

    const ctx = new QueryContextImpl(bucketAccessor);
    const customersCount = await ctx.bucket('customers').count();
    const ordersCount = await ctx.bucket('orders').count();

    expect(customersCount).toBe(1);
    expect(ordersCount).toBe(2);

    const deps = ctx.getDependencies();
    expect(deps.bucketLevel).toEqual(new Set(['customers', 'orders']));
  });
});
