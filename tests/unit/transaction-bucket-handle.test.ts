import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import {
  createBucketBehavior,
  type BucketRef,
} from '../../src/core/bucket-server.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';
import { TransactionBucketHandle } from '../../src/transaction/transaction-bucket-handle.js';
import { BucketWriteBuffer } from '../../src/transaction/write-buffer.js';

// ── Fixtures ────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true, minLength: 1 },
    tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
    score: { type: 'number', default: 0 },
  },
};

const autoincrementDef: BucketDefinition = {
  key: 'id',
  schema: {
    id:   { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
};

let eventBusRef: EventBusRef;
let bucketRef: BucketRef;

// ── Setup / Teardown ──────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
  const behavior = createBucketBehavior('customers', customersDef, eventBusRef);
  bucketRef = await GenServer.start(behavior) as BucketRef;
});

afterEach(async () => {
  if (GenServer.isRunning(bucketRef)) {
    await GenServer.stop(bucketRef);
  }
  if (EventBus.isRunning(eventBusRef)) {
    await EventBus.stop(eventBusRef);
  }
});

// ── Helpers ──────────────────────────────────────────────────────

function createHandle(
  ref: BucketRef = bucketRef,
  definition: BucketDefinition = customersDef,
  autoincrementCounter = 0,
): { handle: TransactionBucketHandle; buffer: BucketWriteBuffer } {
  const buffer = new BucketWriteBuffer();
  const handle = new TransactionBucketHandle(
    'customers',
    ref,
    buffer,
    definition,
    autoincrementCounter,
  );
  return { handle, buffer };
}

async function seedRecord(data: Record<string, unknown>): Promise<StoreRecord> {
  return GenServer.call(bucketRef, { type: 'insert', data }) as Promise<StoreRecord>;
}

// ── Construction ────────────────────────────────────────────────

describe('TransactionBucketHandle construction', () => {
  it('exposes the bucket name', () => {
    const { handle } = createHandle();
    expect(handle.name).toBe('customers');
  });

  it('exposes the autoincrement counter', () => {
    const { handle } = createHandle(bucketRef, customersDef, 42);
    expect(handle.autoincrementCounter).toBe(42);
  });
});

// ── insert() ──────────────────────────────────────────────────────

describe('TransactionBucketHandle insert()', () => {
  it('returns a complete record with generated fields and meta', async () => {
    const { handle } = createHandle();
    const record = await handle.insert({ name: 'Alice' });

    expect(record.id).toMatch(UUID_RE);
    expect(record.name).toBe('Alice');
    expect(record.tier).toBe('basic');
    expect(record.score).toBe(0);
    expect(record._version).toBe(1);
    expect(typeof record._createdAt).toBe('number');
    expect(record._createdAt).toBe(record._updatedAt);
  });

  it('buffers the insert locally without writing to real store', async () => {
    const { handle, buffer } = createHandle();
    const record = await handle.insert({ name: 'Alice' });

    // Buffer should contain the insert
    expect(buffer.inserts.has(record.id)).toBe(true);
    expect(buffer.inserts.get(record.id)).toBe(record);

    // Real store should NOT have it
    const real = await GenServer.call(bucketRef, { type: 'get', key: record.id });
    expect(real).toBeUndefined();
  });

  it('increments autoincrement counter on each insert', async () => {
    const { handle } = createHandle();
    expect(handle.autoincrementCounter).toBe(0);

    await handle.insert({ name: 'A' });
    expect(handle.autoincrementCounter).toBe(1);

    await handle.insert({ name: 'B' });
    expect(handle.autoincrementCounter).toBe(2);
  });

  it('generates sequential autoincrement keys', async () => {
    const aiBehavior = createBucketBehavior('items', autoincrementDef, eventBusRef);
    const aiRef = await GenServer.start(aiBehavior) as BucketRef;
    try {
      const buffer = new BucketWriteBuffer();
      const handle = new TransactionBucketHandle('items', aiRef, buffer, autoincrementDef, 0);

      const r1 = await handle.insert({ name: 'First' });
      const r2 = await handle.insert({ name: 'Second' });

      expect(r1.id).toBe(1);
      expect(r2.id).toBe(2);
    } finally {
      await GenServer.stop(aiRef);
    }
  });
});

// ── get() ──────────────────────────────────────────────────────────

describe('TransactionBucketHandle get()', () => {
  it('returns a record from the real store', async () => {
    const seeded = await seedRecord({ name: 'Alice' });
    const { handle } = createHandle();

    const found = await handle.get(seeded.id);
    expect(found).toEqual(seeded);
  });

  it('returns undefined for a non-existing key', async () => {
    const { handle } = createHandle();
    const found = await handle.get('nonexistent');
    expect(found).toBeUndefined();
  });

  it('returns a buffered insert (read-your-own-writes)', async () => {
    const { handle } = createHandle();
    const inserted = await handle.insert({ name: 'Alice' });

    const found = await handle.get(inserted.id);
    expect(found).toBe(inserted);
  });

  it('returns a buffered update over real store', async () => {
    const seeded = await seedRecord({ name: 'Alice' });
    const { handle } = createHandle();

    const updated = await handle.update(seeded.id, { name: 'Bob' });

    const found = await handle.get(seeded.id);
    expect(found).toBe(updated);
    expect(found!.name).toBe('Bob');
  });

  it('returns undefined for a buffered delete', async () => {
    const seeded = await seedRecord({ name: 'Alice' });
    const { handle } = createHandle();

    await handle.delete(seeded.id);

    const found = await handle.get(seeded.id);
    expect(found).toBeUndefined();
  });
});

// ── update() ──────────────────────────────────────────────────────

describe('TransactionBucketHandle update()', () => {
  it('returns the updated record', async () => {
    const seeded = await seedRecord({ name: 'Alice', tier: 'basic' });
    const { handle } = createHandle();

    const updated = await handle.update(seeded.id, { tier: 'vip' });

    expect(updated.name).toBe('Alice');
    expect(updated.tier).toBe('vip');
    expect(updated._version).toBe(2);
  });

  it('buffers the update without writing to real store', async () => {
    const seeded = await seedRecord({ name: 'Alice', tier: 'basic' });
    const { handle, buffer } = createHandle();

    await handle.update(seeded.id, { tier: 'vip' });

    expect(buffer.updates.has(seeded.id)).toBe(true);

    // Real store unchanged
    const real = await GenServer.call(bucketRef, { type: 'get', key: seeded.id }) as StoreRecord;
    expect(real.tier).toBe('basic');
  });

  it('throws when updating a non-existing key', async () => {
    const { handle } = createHandle();

    await expect(handle.update('nonexistent', { name: 'X' }))
      .rejects
      .toThrow('Record with key "nonexistent" not found in bucket "customers"');
  });

  it('can update a previously inserted record in same tx', async () => {
    const { handle, buffer } = createHandle();

    const inserted = await handle.insert({ name: 'Alice', tier: 'basic' });
    const updated = await handle.update(inserted.id, { tier: 'vip' });

    expect(updated.tier).toBe('vip');
    // The insert map should be updated in-place (not a separate update entry)
    expect(buffer.inserts.get(inserted.id)).toBe(updated);
    expect(buffer.updates.has(inserted.id)).toBe(false);
  });

  it('can chain multiple updates to the same key', async () => {
    const seeded = await seedRecord({ name: 'Alice', score: 0 });
    const { handle } = createHandle();

    await handle.update(seeded.id, { score: 10 });
    const final = await handle.update(seeded.id, { score: 20 });

    expect(final.score).toBe(20);

    const found = await handle.get(seeded.id);
    expect(found!.score).toBe(20);
  });
});

// ── delete() ──────────────────────────────────────────────────────

describe('TransactionBucketHandle delete()', () => {
  it('marks a real record as deleted in buffer', async () => {
    const seeded = await seedRecord({ name: 'Alice' });
    const { handle, buffer } = createHandle();

    await handle.delete(seeded.id);

    expect(buffer.deletes.has(seeded.id)).toBe(true);

    // Real store still has it
    const real = await GenServer.call(bucketRef, { type: 'get', key: seeded.id });
    expect(real).toBeDefined();
  });

  it('is idempotent for non-existing keys', async () => {
    const { handle } = createHandle();
    // Should not throw
    await handle.delete('nonexistent');
  });

  it('cancels a buffered insert (net-zero)', async () => {
    const { handle, buffer } = createHandle();

    const inserted = await handle.insert({ name: 'Alice' });
    await handle.delete(inserted.id);

    expect(buffer.inserts.has(inserted.id)).toBe(false);
    expect(buffer.deletes.has(inserted.id)).toBe(false);
  });
});

// ── all() ──────────────────────────────────────────────────────────

describe('TransactionBucketHandle all()', () => {
  it('returns all records from real store when buffer is empty', async () => {
    await seedRecord({ name: 'Alice' });
    await seedRecord({ name: 'Bob' });

    const { handle } = createHandle();
    const records = await handle.all();

    expect(records).toHaveLength(2);
  });

  it('includes buffered inserts', async () => {
    await seedRecord({ name: 'Alice' });
    const { handle } = createHandle();

    await handle.insert({ name: 'Bob' });
    const records = await handle.all();

    expect(records).toHaveLength(2);
    expect(records.map((r) => r.name)).toContain('Alice');
    expect(records.map((r) => r.name)).toContain('Bob');
  });

  it('applies buffered updates', async () => {
    const seeded = await seedRecord({ name: 'Alice', tier: 'basic' });
    const { handle } = createHandle();

    await handle.update(seeded.id, { tier: 'vip' });
    const records = await handle.all();

    expect(records).toHaveLength(1);
    expect(records[0]!.tier).toBe('vip');
  });

  it('excludes buffered deletes', async () => {
    const seeded = await seedRecord({ name: 'Alice' });
    await seedRecord({ name: 'Bob' });
    const { handle } = createHandle();

    await handle.delete(seeded.id);
    const records = await handle.all();

    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe('Bob');
  });

  it('returns empty array when all records deleted', async () => {
    const s1 = await seedRecord({ name: 'Alice' });
    const s2 = await seedRecord({ name: 'Bob' });
    const { handle } = createHandle();

    await handle.delete(s1.id);
    await handle.delete(s2.id);
    const records = await handle.all();

    expect(records).toHaveLength(0);
  });

  it('combines all overlay operations correctly', async () => {
    const alice = await seedRecord({ name: 'Alice', tier: 'basic' });
    const bob = await seedRecord({ name: 'Bob', tier: 'basic' });
    const { handle } = createHandle();

    // Update Alice
    await handle.update(alice.id, { tier: 'vip' });
    // Delete Bob
    await handle.delete(bob.id);
    // Insert Charlie
    await handle.insert({ name: 'Charlie', tier: 'basic' });

    const records = await handle.all();

    expect(records).toHaveLength(2);
    const names = records.map((r) => r.name);
    expect(names).toContain('Alice');
    expect(names).toContain('Charlie');
    expect(names).not.toContain('Bob');

    const aliceRecord = records.find((r) => r.name === 'Alice')!;
    expect(aliceRecord.tier).toBe('vip');
  });
});

// ── where() ──────────────────────────────────────────────────────

describe('TransactionBucketHandle where()', () => {
  it('filters records by field value', async () => {
    await seedRecord({ name: 'Alice', tier: 'vip' });
    await seedRecord({ name: 'Bob', tier: 'basic' });
    const { handle } = createHandle();

    const vips = await handle.where({ tier: 'vip' });

    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Alice');
  });

  it('includes buffered inserts that match the filter', async () => {
    const { handle } = createHandle();

    await handle.insert({ name: 'Alice', tier: 'vip' });
    await handle.insert({ name: 'Bob', tier: 'basic' });

    const vips = await handle.where({ tier: 'vip' });

    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Alice');
  });

  it('reflects buffered updates in filter results', async () => {
    const seeded = await seedRecord({ name: 'Alice', tier: 'basic' });
    const { handle } = createHandle();

    await handle.update(seeded.id, { tier: 'vip' });

    const vips = await handle.where({ tier: 'vip' });
    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Alice');

    const basics = await handle.where({ tier: 'basic' });
    expect(basics).toHaveLength(0);
  });

  it('excludes deleted records from results', async () => {
    const seeded = await seedRecord({ name: 'Alice', tier: 'vip' });
    const { handle } = createHandle();

    await handle.delete(seeded.id);

    const vips = await handle.where({ tier: 'vip' });
    expect(vips).toHaveLength(0);
  });

  it('supports multiple filter fields', async () => {
    await seedRecord({ name: 'Alice', tier: 'vip', score: 100 });
    await seedRecord({ name: 'Bob', tier: 'vip', score: 50 });
    const { handle } = createHandle();

    const results = await handle.where({ tier: 'vip', score: 100 });

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Alice');
  });
});

// ── findOne() ──────────────────────────────────────────────────────

describe('TransactionBucketHandle findOne()', () => {
  it('returns the first matching record', async () => {
    await seedRecord({ name: 'Alice', tier: 'vip' });
    const { handle } = createHandle();

    const found = await handle.findOne({ tier: 'vip' });

    expect(found).toBeDefined();
    expect(found!.name).toBe('Alice');
  });

  it('returns undefined when no record matches', async () => {
    await seedRecord({ name: 'Alice', tier: 'basic' });
    const { handle } = createHandle();

    const found = await handle.findOne({ tier: 'vip' });
    expect(found).toBeUndefined();
  });

  it('finds a buffered insert', async () => {
    const { handle } = createHandle();

    await handle.insert({ name: 'Alice', tier: 'vip' });

    const found = await handle.findOne({ tier: 'vip' });
    expect(found).toBeDefined();
    expect(found!.name).toBe('Alice');
  });

  it('does not find a deleted record', async () => {
    const seeded = await seedRecord({ name: 'Alice', tier: 'vip' });
    const { handle } = createHandle();

    await handle.delete(seeded.id);

    const found = await handle.findOne({ tier: 'vip' });
    expect(found).toBeUndefined();
  });
});

// ── count() ──────────────────────────────────────────────────────

describe('TransactionBucketHandle count()', () => {
  it('returns total count with overlay applied', async () => {
    await seedRecord({ name: 'Alice' });
    await seedRecord({ name: 'Bob' });
    const { handle } = createHandle();

    await handle.insert({ name: 'Charlie' });
    await handle.delete((await handle.findOne({ name: 'Bob' }))!.id);

    const count = await handle.count();
    expect(count).toBe(2); // Alice + Charlie (Bob deleted)
  });

  it('returns filtered count with overlay applied', async () => {
    await seedRecord({ name: 'Alice', tier: 'vip' });
    await seedRecord({ name: 'Bob', tier: 'basic' });
    const { handle } = createHandle();

    await handle.insert({ name: 'Charlie', tier: 'vip' });

    const vipCount = await handle.count({ tier: 'vip' });
    expect(vipCount).toBe(2);

    const basicCount = await handle.count({ tier: 'basic' });
    expect(basicCount).toBe(1);
  });

  it('returns 0 for empty store with no buffered operations', async () => {
    const { handle } = createHandle();
    const count = await handle.count();
    expect(count).toBe(0);
  });

  it('counts only buffered inserts when real store is empty', async () => {
    const { handle } = createHandle();

    await handle.insert({ name: 'Alice' });
    await handle.insert({ name: 'Bob' });

    const count = await handle.count();
    expect(count).toBe(2);
  });
});

// ── Edge cases ──────────────────────────────────────────────────

describe('TransactionBucketHandle edge cases', () => {
  it('insert then update then get returns final state', async () => {
    const { handle } = createHandle();

    const inserted = await handle.insert({ name: 'Alice', tier: 'basic', score: 0 });
    await handle.update(inserted.id, { tier: 'vip' });
    await handle.update(inserted.id, { score: 100 });

    const found = await handle.get(inserted.id);
    expect(found!.name).toBe('Alice');
    expect(found!.tier).toBe('vip');
    expect(found!.score).toBe(100);
  });

  it('insert then delete then get returns undefined', async () => {
    const { handle } = createHandle();

    const inserted = await handle.insert({ name: 'Alice' });
    await handle.delete(inserted.id);

    const found = await handle.get(inserted.id);
    expect(found).toBeUndefined();
  });

  it('insert then delete then all returns empty for that key', async () => {
    const { handle } = createHandle();

    const inserted = await handle.insert({ name: 'Temp' });
    await handle.delete(inserted.id);

    const records = await handle.all();
    expect(records).toHaveLength(0);
  });

  it('delete a real record then insert with same data still visible in all()', async () => {
    const seeded = await seedRecord({ name: 'Alice', tier: 'basic' });
    const { handle } = createHandle();

    await handle.delete(seeded.id);
    // Insert a new record (different key due to UUID generation)
    const newRecord = await handle.insert({ name: 'Alice', tier: 'basic' });

    const records = await handle.all();
    expect(records).toHaveLength(1);
    // The new record has a different ID
    expect(records[0]!.id).toBe(newRecord.id);
    expect(records[0]!.id).not.toBe(seeded.id);
  });

  it('update changes version but does not modify real store', async () => {
    const seeded = await seedRecord({ name: 'Alice', score: 0 });
    const { handle } = createHandle();

    const updated = await handle.update(seeded.id, { score: 100 });
    expect(updated._version).toBe(seeded._version + 1);

    // Real store still at original version
    const real = await GenServer.call(bucketRef, { type: 'get', key: seeded.id }) as StoreRecord;
    expect(real._version).toBe(seeded._version);
    expect(real.score).toBe(0);
  });
});
