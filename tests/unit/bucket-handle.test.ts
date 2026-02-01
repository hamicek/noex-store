import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import { BucketHandle } from '../../src/core/bucket-handle.js';
import {
  createBucketBehavior,
  type BucketRef,
} from '../../src/core/bucket-server.js';
import type { BucketDefinition, PaginatedResult, StoreRecord } from '../../src/types/index.js';
import { ValidationError } from '../../src/core/schema-validator.js';

// ── Fixtures ──────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const usersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true, minLength: 1 },
    tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
    email: { type: 'string', format: 'email' },
  },
};

let eventBusRef: EventBusRef;
let bucketRef: BucketRef;
let handle: BucketHandle;

// ── Setup / Teardown ──────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
  const behavior = createBucketBehavior('users', usersDef, eventBusRef);
  bucketRef = await GenServer.start(behavior) as BucketRef;
  handle = new BucketHandle('users', bucketRef);
});

afterEach(async () => {
  if (GenServer.isRunning(bucketRef)) {
    await GenServer.stop(bucketRef);
  }
  if (EventBus.isRunning(eventBusRef)) {
    await EventBus.stop(eventBusRef);
  }
});

// ── Construction ──────────────────────────────────────────────────

describe('BucketHandle construction', () => {
  it('exposes the bucket name', () => {
    expect(handle.name).toBe('users');
  });
});

// ── CRUD through handle ──────────────────────────────────────────

describe('BucketHandle CRUD', () => {
  it('insert() returns a record with meta and generated fields', async () => {
    const record = await handle.insert({ name: 'Alice' });

    expect(record.id).toMatch(UUID_RE);
    expect(record.name).toBe('Alice');
    expect(record.tier).toBe('basic');
    expect(record._version).toBe(1);
    expect(typeof record._createdAt).toBe('number');
    expect(record._createdAt).toBe(record._updatedAt);
  });

  it('get() retrieves an inserted record by key', async () => {
    const inserted = await handle.insert({ name: 'Bob' });
    const fetched = await handle.get(inserted.id);

    expect(fetched).toEqual(inserted);
  });

  it('get() returns undefined for a non-existing key', async () => {
    const result = await handle.get('no-such-id');

    expect(result).toBeUndefined();
  });

  it('update() returns the updated record with bumped version', async () => {
    const inserted = await handle.insert({ name: 'Carol' });
    const updated = await handle.update(inserted.id, { name: 'Caroline', tier: 'vip' });

    expect(updated.id).toBe(inserted.id);
    expect(updated.name).toBe('Caroline');
    expect(updated.tier).toBe('vip');
    expect(updated._version).toBe(2);
    expect(updated._createdAt).toBe(inserted._createdAt);
    expect(updated._updatedAt).toBeGreaterThanOrEqual(inserted._updatedAt);
  });

  it('update() throws on non-existing key', async () => {
    await expect(
      handle.update('ghost', { name: 'Nope' }),
    ).rejects.toThrow(/not found/i);
  });

  it('delete() removes a record', async () => {
    const inserted = await handle.insert({ name: 'Dave' });
    await handle.delete(inserted.id);
    const result = await handle.get(inserted.id);

    expect(result).toBeUndefined();
  });

  it('delete() on non-existing key is a no-op', async () => {
    await expect(handle.delete('ghost')).resolves.toBeUndefined();
  });

  it('clear() removes all records', async () => {
    await handle.insert({ name: 'E1' });
    await handle.insert({ name: 'E2' });
    await handle.clear();

    const all = await handle.all();
    expect(all).toHaveLength(0);
  });
});

// ── Queries through handle ───────────────────────────────────────

describe('BucketHandle queries', () => {
  async function seedRecords(): Promise<StoreRecord[]> {
    const r1 = await handle.insert({ name: 'Alice', tier: 'vip' });
    const r2 = await handle.insert({ name: 'Bob' });
    const r3 = await handle.insert({ name: 'Carol' });
    return [r1, r2, r3];
  }

  it('all() returns every record', async () => {
    const seeded = await seedRecords();
    const all = await handle.all();

    expect(all).toHaveLength(3);
    expect(all.map((r) => r.name)).toEqual(
      expect.arrayContaining(seeded.map((r) => r.name)),
    );
  });

  it('where() filters by simple equality', async () => {
    await seedRecords();
    const vips = await handle.where({ tier: 'vip' });

    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Alice');
  });

  it('where() returns empty array when no match', async () => {
    await seedRecords();
    const result = await handle.where({ name: 'Nobody' });

    expect(result).toEqual([]);
  });

  it('where() supports multi-field filter', async () => {
    await seedRecords();
    const result = await handle.where({ tier: 'basic', name: 'Bob' });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Bob');
  });

  it('findOne() returns the first matching record', async () => {
    await seedRecords();
    const result = await handle.findOne({ tier: 'basic' });

    expect(result).toBeDefined();
    expect(result!.tier).toBe('basic');
  });

  it('findOne() returns undefined when no match', async () => {
    await seedRecords();
    const result = await handle.findOne({ name: 'Nobody' });

    expect(result).toBeUndefined();
  });

  it('count() without filter returns total count', async () => {
    await seedRecords();
    const total = await handle.count();

    expect(total).toBe(3);
  });

  it('count() with filter returns filtered count', async () => {
    await seedRecords();
    const count = await handle.count({ tier: 'basic' });

    expect(count).toBe(2);
  });
});

// ── Validation through handle ────────────────────────────────────

describe('BucketHandle validation', () => {
  it('insert() rejects missing required fields', async () => {
    await expect(handle.insert({})).rejects.toThrow(ValidationError);
  });

  it('insert() rejects invalid enum value', async () => {
    await expect(
      handle.insert({ name: 'Test', tier: 'premium' }),
    ).rejects.toThrow(ValidationError);
  });

  it('update() rejects values violating schema', async () => {
    const inserted = await handle.insert({ name: 'Valid' });

    await expect(
      handle.update(inserted.id, { name: '' }),
    ).rejects.toThrow(ValidationError);
  });
});

// ── first / last through handle ───────────────────────────────────

describe('BucketHandle first/last', () => {
  const numDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      label: { type: 'string', required: true },
    },
    etsType: 'ordered_set',
  };

  let numHandle: BucketHandle;
  let numRef: BucketRef;

  beforeEach(async () => {
    const behavior = createBucketBehavior('nums', numDef, eventBusRef);
    numRef = await GenServer.start(behavior) as BucketRef;
    numHandle = new BucketHandle('nums', numRef);
  });

  afterEach(async () => {
    if (GenServer.isRunning(numRef)) {
      await GenServer.stop(numRef);
    }
  });

  it('first() on empty bucket returns empty array', async () => {
    const result = await numHandle.first(5);
    expect(result).toEqual([]);
  });

  it('first(n) returns first n records sorted by key', async () => {
    await numHandle.insert({ label: 'a' });
    await numHandle.insert({ label: 'b' });
    await numHandle.insert({ label: 'c' });
    await numHandle.insert({ label: 'd' });

    const result = await numHandle.first(2);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(1);
    expect(result[1]!.id).toBe(2);
  });

  it('first(n) with n > count returns all records', async () => {
    await numHandle.insert({ label: 'x' });
    const result = await numHandle.first(100);
    expect(result).toHaveLength(1);
  });

  it('last(n) returns last n records sorted by key', async () => {
    await numHandle.insert({ label: 'a' });
    await numHandle.insert({ label: 'b' });
    await numHandle.insert({ label: 'c' });
    await numHandle.insert({ label: 'd' });

    const result = await numHandle.last(2);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(3);
    expect(result[1]!.id).toBe(4);
  });

  it('last(n) with n > count returns all records', async () => {
    await numHandle.insert({ label: 'x' });
    await numHandle.insert({ label: 'y' });
    const result = await numHandle.last(50);
    expect(result).toHaveLength(2);
  });
});

// ── paginate through handle ───────────────────────────────────────

describe('BucketHandle paginate', () => {
  const pagDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      label: { type: 'string', required: true },
    },
    etsType: 'ordered_set',
  };

  let pagHandle: BucketHandle;
  let pagRef: BucketRef;

  beforeEach(async () => {
    const behavior = createBucketBehavior('pag', pagDef, eventBusRef);
    pagRef = await GenServer.start(behavior) as BucketRef;
    pagHandle = new BucketHandle('pag', pagRef);
  });

  afterEach(async () => {
    if (GenServer.isRunning(pagRef)) {
      await GenServer.stop(pagRef);
    }
  });

  it('first page returns records with hasMore and nextCursor', async () => {
    for (let i = 0; i < 5; i++) await pagHandle.insert({ label: `r${i}` });

    const page = await pagHandle.paginate({ limit: 2 });
    expect(page.records).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(2);
  });

  it('cursor-based traversal covers all records', async () => {
    for (let i = 0; i < 5; i++) await pagHandle.insert({ label: `r${i}` });

    const page1 = await pagHandle.paginate({ limit: 2 });
    const page2 = await pagHandle.paginate({ after: page1.nextCursor, limit: 2 });
    const page3 = await pagHandle.paginate({ after: page2.nextCursor, limit: 2 });

    expect(page1.records).toHaveLength(2);
    expect(page2.records).toHaveLength(2);
    expect(page3.records).toHaveLength(1);
    expect(page3.hasMore).toBe(false);

    const allIds = [
      ...page1.records,
      ...page2.records,
      ...page3.records,
    ].map((r) => r.id);
    expect(allIds).toEqual([1, 2, 3, 4, 5]);
  });

  it('empty bucket returns no records', async () => {
    const page = await pagHandle.paginate({ limit: 10 });
    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it('non-existing cursor returns empty result', async () => {
    await pagHandle.insert({ label: 'only' });
    const page = await pagHandle.paginate({ after: 999, limit: 10 });
    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

// ── aggregations through handle ───────────────────────────────────

describe('BucketHandle aggregations', () => {
  const aggDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
      score: { type: 'number', default: 0 },
      tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
    },
    indexes: ['tier'],
  };

  let aggHandle: BucketHandle;
  let aggRef: BucketRef;

  beforeEach(async () => {
    const behavior = createBucketBehavior('agg', aggDef, eventBusRef);
    aggRef = await GenServer.start(behavior) as BucketRef;
    aggHandle = new BucketHandle('agg', aggRef);
  });

  afterEach(async () => {
    if (GenServer.isRunning(aggRef)) {
      await GenServer.stop(aggRef);
    }
  });

  async function seedAgg(): Promise<void> {
    await aggHandle.insert({ name: 'Alice', score: 10, tier: 'vip' });
    await aggHandle.insert({ name: 'Bob', score: 20 });
    await aggHandle.insert({ name: 'Carol', score: 30, tier: 'vip' });
  }

  it('sum() returns total of field values', async () => {
    await seedAgg();
    const result = await aggHandle.sum('score');
    expect(result).toBe(60);
  });

  it('sum() with filter sums only matching records', async () => {
    await seedAgg();
    const result = await aggHandle.sum('score', { tier: 'vip' });
    expect(result).toBe(40);
  });

  it('sum() on empty bucket returns 0', async () => {
    const result = await aggHandle.sum('score');
    expect(result).toBe(0);
  });

  it('avg() returns average of field values', async () => {
    await seedAgg();
    const result = await aggHandle.avg('score');
    expect(result).toBe(20);
  });

  it('avg() on empty bucket returns 0', async () => {
    const result = await aggHandle.avg('score');
    expect(result).toBe(0);
  });

  it('min() returns smallest field value', async () => {
    await seedAgg();
    const result = await aggHandle.min('score');
    expect(result).toBe(10);
  });

  it('min() on empty bucket returns undefined', async () => {
    const result = await aggHandle.min('score');
    expect(result).toBeUndefined();
  });

  it('max() returns largest field value', async () => {
    await seedAgg();
    const result = await aggHandle.max('score');
    expect(result).toBe(30);
  });

  it('max() with filter returns max of matching records', async () => {
    await seedAgg();
    const result = await aggHandle.max('score', { tier: 'basic' });
    expect(result).toBe(20);
  });
});
