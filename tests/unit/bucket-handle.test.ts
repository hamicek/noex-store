import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import { BucketHandle } from '../../src/core/bucket-handle.js';
import {
  createBucketBehavior,
  type BucketRef,
} from '../../src/core/bucket-server.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';
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
