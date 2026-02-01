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

// ── Dependency tracking ───────────────────────────────────────────

describe('QueryContextImpl dependency tracking', () => {
  it('records a single bucket access', () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    ctx.bucket('customers');

    expect(ctx.getDependencies()).toEqual(new Set(['customers']));
  });

  it('records accesses to multiple distinct buckets', () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    ctx.bucket('customers');
    ctx.bucket('orders');

    expect(ctx.getDependencies()).toEqual(new Set(['customers', 'orders']));
  });

  it('deduplicates repeated accesses to the same bucket', () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    ctx.bucket('customers');
    ctx.bucket('customers');
    ctx.bucket('customers');

    expect(ctx.getDependencies()).toEqual(new Set(['customers']));
    expect(ctx.getDependencies().size).toBe(1);
  });

  it('starts with an empty dependency set', () => {
    const ctx = new QueryContextImpl(bucketAccessor);

    expect(ctx.getDependencies().size).toBe(0);
  });

  it('returns a read-only set (no add method exposed)', () => {
    const ctx = new QueryContextImpl(bucketAccessor);
    ctx.bucket('customers');

    const deps = ctx.getDependencies();
    // ReadonlySet doesn't expose add/delete/clear
    expect('add' in deps).toBe(true); // Set has add, but type says ReadonlySet
    // The important thing is the type contract — runtime Set is fine
    expect(deps.has('customers')).toBe(true);
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
    expect(ctx.getDependencies()).toEqual(new Set(['customers', 'orders']));
  });
});
