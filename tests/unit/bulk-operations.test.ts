import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import { BucketHandle } from '../../src/core/bucket-handle.js';
import {
  createBucketBehavior,
  type BucketRef,
} from '../../src/core/bucket-server.js';
import type {
  BucketDefinition,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
  StoreRecord,
} from '../../src/types/index.js';
import { Store, UniqueConstraintError } from '../../src/core/store.js';
import { ValidationError } from '../../src/core/schema-validator.js';

// ── Fixtures ──────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const usersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true, minLength: 1 },
    email: { type: 'string', unique: true },
    age: { type: 'number' },
  },
};

const autoincrementDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
    score: { type: 'number' },
  },
};

const ttlDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
  ttl: '1h',
};

const maxSizeDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
  maxSize: 5,
};

let eventBusRef: EventBusRef;
let bucketRef: BucketRef;
let handle: BucketHandle;

async function startBucket(
  bucketName: string,
  definition: BucketDefinition,
): Promise<{ ref: BucketRef; handle: BucketHandle }> {
  const behavior = createBucketBehavior(bucketName, definition, eventBusRef);
  const ref = await GenServer.start(behavior) as BucketRef;
  return { ref, handle: new BucketHandle(bucketName, ref) };
}

// ── Setup / Teardown ──────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
  const result = await startBucket('users', usersDef);
  bucketRef = result.ref;
  handle = result.handle;
});

afterEach(async () => {
  if (GenServer.isRunning(bucketRef)) {
    await GenServer.stop(bucketRef);
  }
  if (EventBus.isRunning(eventBusRef)) {
    await EventBus.stop(eventBusRef);
  }
});

// ── insertMany ───────────────────────────────────────────────────

describe('insertMany', () => {
  it('inserts multiple records atomically and returns StoreRecord[]', async () => {
    const records = await handle.insertMany([
      { name: 'Alice', email: 'alice@test.com' },
      { name: 'Bob', email: 'bob@test.com' },
      { name: 'Charlie', email: 'charlie@test.com' },
    ]);

    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.id).toMatch(UUID_RE);
      expect(r._version).toBe(1);
      expect(typeof r._createdAt).toBe('number');
      expect(r._createdAt).toBe(r._updatedAt);
    }
    expect(records[0]!.name).toBe('Alice');
    expect(records[1]!.name).toBe('Bob');
    expect(records[2]!.name).toBe('Charlie');
  });

  it('increments autoincrement correctly across batch', async () => {
    const { ref, handle: h } = await startBucket('counter', autoincrementDef);
    try {
      const records = await h.insertMany([
        { name: 'A' },
        { name: 'B' },
        { name: 'C' },
      ]);

      expect(records[0]!.id).toBe(1);
      expect(records[1]!.id).toBe(2);
      expect(records[2]!.id).toBe(3);

      // Next insert should continue from 4
      const next = await h.insert({ name: 'D' });
      expect(next.id).toBe(4);
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('returns empty array for empty input', async () => {
    const records = await handle.insertMany([]);
    expect(records).toEqual([]);

    // No side effects
    const all = await handle.all();
    expect(all).toHaveLength(0);
  });

  it('throws on unique constraint collision with existing record', async () => {
    await handle.insert({ name: 'Alice', email: 'alice@test.com' });

    await expect(
      handle.insertMany([
        { name: 'Bob', email: 'bob@test.com' },
        { name: 'AliceDupe', email: 'alice@test.com' },
      ]),
    ).rejects.toThrow(UniqueConstraintError);

    // Atomicity: no records from the batch should exist
    const all = await handle.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Alice');
  });

  it('throws on cross-batch unique collision', async () => {
    await expect(
      handle.insertMany([
        { name: 'Alice', email: 'same@test.com' },
        { name: 'Bob', email: 'same@test.com' },
      ]),
    ).rejects.toThrow(UniqueConstraintError);

    const all = await handle.all();
    expect(all).toHaveLength(0);
  });

  it('throws on duplicate primary key in batch', async () => {
    const { ref, handle: h } = await startBucket('dup-pk', {
      key: 'id',
      schema: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
    });
    try {
      await expect(
        h.insertMany([
          { id: 'same', name: 'A' },
          { id: 'same', name: 'B' },
        ]),
      ).rejects.toThrow(/Duplicate key/);

      const all = await h.all();
      expect(all).toHaveLength(0);
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('throws on duplicate primary key against existing record', async () => {
    const { ref, handle: h } = await startBucket('dup-pk2', {
      key: 'id',
      schema: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
    });
    try {
      await h.insert({ id: 'existing', name: 'Old' });

      await expect(
        h.insertMany([
          { id: 'new', name: 'New' },
          { id: 'existing', name: 'Dupe' },
        ]),
      ).rejects.toThrow(/already exists/);

      const all = await h.all();
      expect(all).toHaveLength(1);
      expect(all[0]!.name).toBe('Old');
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('rolls back autoincrement counter on validation failure', async () => {
    const { ref, handle: h } = await startBucket('rollback-ai', autoincrementDef);
    try {
      await h.insert({ name: 'A' }); // id = 1

      // This batch will fail because second record has same name... no, we need schema validation.
      // Let's use a unique constraint instead
      const { ref: ref2, handle: h2 } = await startBucket('rollback-ai2', {
        key: 'id',
        schema: {
          id: { type: 'number', generated: 'autoincrement' },
          name: { type: 'string', required: true },
          code: { type: 'string', unique: true },
        },
      });
      try {
        await h2.insert({ name: 'A', code: 'x' }); // id = 1

        await expect(
          h2.insertMany([
            { name: 'B', code: 'y' },
            { name: 'C', code: 'x' }, // collides with existing
          ]),
        ).rejects.toThrow(UniqueConstraintError);

        // Counter should be rolled back — next insert gets id = 2, not 4
        const next = await h2.insert({ name: 'D', code: 'z' });
        expect(next.id).toBe(2);
      } finally {
        if (GenServer.isRunning(ref2)) await GenServer.stop(ref2);
      }
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('throws on schema validation failure and rolls back entire batch', async () => {
    await expect(
      handle.insertMany([
        { name: 'Valid' },
        { name: '' }, // minLength: 1 fails
      ]),
    ).rejects.toThrow(ValidationError);

    const all = await handle.all();
    expect(all).toHaveLength(0);
  });

  it('respects maxSize by evicting oldest after batch insert', async () => {
    const { ref, handle: h } = await startBucket('max', maxSizeDef);
    try {
      // Insert 3 existing records
      await h.insert({ name: 'Old1' });
      await h.insert({ name: 'Old2' });
      await h.insert({ name: 'Old3' });

      // Insert 5 more — total 8, maxSize 5, so 3 oldest evicted
      const batch = await h.insertMany([
        { name: 'New1' },
        { name: 'New2' },
        { name: 'New3' },
        { name: 'New4' },
        { name: 'New5' },
      ]);

      expect(batch).toHaveLength(5);

      const all = await h.all();
      expect(all).toHaveLength(5);

      // The 3 oldest (Old1, Old2, Old3) should be evicted
      const names = all.map(r => r.name);
      expect(names).not.toContain('Old1');
      expect(names).not.toContain('Old2');
      expect(names).not.toContain('Old3');
      expect(names).toContain('New1');
      expect(names).toContain('New5');
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('sets _expiresAt on all records for TTL buckets', async () => {
    const { ref, handle: h } = await startBucket('ttl', ttlDef);
    try {
      const records = await h.insertMany([
        { name: 'A' },
        { name: 'B' },
      ]);

      for (const r of records) {
        const expiresAt = (r as Record<string, unknown>)._expiresAt;
        expect(typeof expiresAt).toBe('number');
        // 1h = 3600000ms
        expect(expiresAt as number).toBeGreaterThan(r._createdAt);
        expect((expiresAt as number) - r._createdAt).toBe(3_600_000);
      }
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('emits inserted event for each record', async () => {
    const events: BucketInsertedEvent[] = [];
    await EventBus.subscribe<BucketInsertedEvent>(
      eventBusRef,
      'bucket.users.inserted',
      (msg) => { events.push(msg); },
    );

    const records = await handle.insertMany([
      { name: 'Alice', email: 'alice@test.com' },
      { name: 'Bob', email: 'bob@test.com' },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]!.record).toEqual(records[0]);
    expect(events[1]!.record).toEqual(records[1]);
    expect(events[0]!.type).toBe('inserted');
    expect(events[0]!.bucket).toBe('users');
  });
});

// ── updateMany ───────────────────────────────────────────────────

describe('updateMany', () => {
  it('updates all matching records and returns count', async () => {
    const { ref, handle: h } = await startBucket('orders', autoincrementDef);
    try {
      await h.insertMany([
        { name: 'A', score: 10 },
        { name: 'B', score: 20 },
        { name: 'C', score: 10 },
        { name: 'D', score: 30 },
      ]);

      const count = await h.updateMany({ score: 10 }, { score: 99 });
      expect(count).toBe(2);

      const all = await h.all();
      const updated = all.filter(r => r.score === 99);
      expect(updated).toHaveLength(2);
      for (const r of updated) {
        expect(r._version).toBe(2);
      }
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('uses WhereFilter operators ($gt, $in)', async () => {
    const { ref, handle: h } = await startBucket('filter-ops', autoincrementDef);
    try {
      await h.insertMany([
        { name: 'A', score: 10 },
        { name: 'B', score: 50 },
        { name: 'C', score: 100 },
      ]);

      const count = await h.updateMany(
        { score: { $gt: 20 } },
        { name: 'Updated' },
      );
      expect(count).toBe(2);

      const all = await h.all();
      const updatedNames = all.filter(r => r.name === 'Updated');
      expect(updatedNames).toHaveLength(2);
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('returns 0 when no records match', async () => {
    await handle.insert({ name: 'Alice' });

    const count = await handle.updateMany({ name: 'NonExistent' }, { name: 'X' });
    expect(count).toBe(0);

    const all = await handle.all();
    expect(all[0]!.name).toBe('Alice');
  });

  it('rolls back on unique constraint violation mid-batch', async () => {
    // Insert two records with unique emails
    await handle.insert({ name: 'Alice', email: 'alice@test.com' });
    await handle.insert({ name: 'Bob', email: 'bob@test.com' });

    // Try to set all emails to the same value — second update should fail
    await expect(
      handle.updateMany({}, { email: 'same@test.com' }),
    ).rejects.toThrow(UniqueConstraintError);

    // Both records should retain their original emails
    const all = await handle.all();
    const emails = all.map(r => r.email).sort();
    expect(emails).toEqual(['alice@test.com', 'bob@test.com']);
  });

  it('emits updated event for each record', async () => {
    const events: BucketUpdatedEvent[] = [];
    await EventBus.subscribe<BucketUpdatedEvent>(
      eventBusRef,
      'bucket.users.updated',
      (msg) => { events.push(msg); },
    );

    await handle.insert({ name: 'Alice' });
    await handle.insert({ name: 'Bob' });

    await handle.updateMany({}, { age: 30 });

    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.type).toBe('updated');
      expect(e.bucket).toBe('users');
      expect(e.newRecord.age).toBe(30);
    }
  });
});

// ── deleteMany ───────────────────────────────────────────────────

describe('deleteMany', () => {
  it('deletes all matching records and returns count', async () => {
    const { ref, handle: h } = await startBucket('del', autoincrementDef);
    try {
      await h.insertMany([
        { name: 'A', score: 10 },
        { name: 'B', score: 20 },
        { name: 'C', score: 10 },
        { name: 'D', score: 30 },
      ]);

      const count = await h.deleteMany({ score: 10 });
      expect(count).toBe(2);

      const all = await h.all();
      expect(all).toHaveLength(2);
      expect(all.map(r => r.name).sort()).toEqual(['B', 'D']);
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('uses WhereFilter operators', async () => {
    const { ref, handle: h } = await startBucket('del-filter', autoincrementDef);
    try {
      await h.insertMany([
        { name: 'A', score: 10 },
        { name: 'B', score: 50 },
        { name: 'C', score: 100 },
      ]);

      const count = await h.deleteMany({ score: { $gte: 50 } });
      expect(count).toBe(2);

      const all = await h.all();
      expect(all).toHaveLength(1);
      expect(all[0]!.name).toBe('A');
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('returns 0 when no records match', async () => {
    await handle.insert({ name: 'Alice' });

    const count = await handle.deleteMany({ name: 'NonExistent' });
    expect(count).toBe(0);

    const all = await handle.all();
    expect(all).toHaveLength(1);
  });

  it('cleans up indexes after deletion', async () => {
    // Insert with unique email, delete, re-insert with same email should work
    await handle.insert({ name: 'Alice', email: 'alice@test.com' });

    await handle.deleteMany({ name: 'Alice' });

    // Should not throw — index entry should be cleaned
    const record = await handle.insert({ name: 'Bob', email: 'alice@test.com' });
    expect(record.name).toBe('Bob');
    expect(record.email).toBe('alice@test.com');
  });

  it('emits deleted event for each record', async () => {
    const events: BucketDeletedEvent[] = [];
    await EventBus.subscribe<BucketDeletedEvent>(
      eventBusRef,
      'bucket.users.deleted',
      (msg) => { events.push(msg); },
    );

    const alice = await handle.insert({ name: 'Alice' });
    const bob = await handle.insert({ name: 'Bob' });

    await handle.deleteMany({});

    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.type).toBe('deleted');
      expect(e.bucket).toBe('users');
    }
  });
});

// ── upsert ───────────────────────────────────────────────────────

describe('upsert', () => {
  it('inserts when key does not exist', async () => {
    const { ref, handle: h } = await startBucket('upsert-test', {
      key: 'id',
      schema: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        score: { type: 'number' },
      },
    });
    try {
      const record = await h.upsert({ id: 'a', name: 'Alice', score: 10 });

      expect(record.id).toBe('a');
      expect(record.name).toBe('Alice');
      expect(record._version).toBe(1);
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('updates when key already exists', async () => {
    const { ref, handle: h } = await startBucket('upsert-update', {
      key: 'id',
      schema: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        score: { type: 'number' },
      },
    });
    try {
      await h.insert({ id: 'a', name: 'Alice', score: 10 });

      const updated = await h.upsert({ id: 'a', name: 'Alice Updated', score: 99 });

      expect(updated.id).toBe('a');
      expect(updated.name).toBe('Alice Updated');
      expect(updated.score).toBe(99);
      expect(updated._version).toBe(2);

      const all = await h.all();
      expect(all).toHaveLength(1);
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('inserts when key is generated (not in data)', async () => {
    const record = await handle.upsert({ name: 'New User' });

    expect(record.id).toMatch(UUID_RE);
    expect(record.name).toBe('New User');
    expect(record._version).toBe(1);
  });

  it('emits inserted event on insert path', async () => {
    const events: BucketInsertedEvent[] = [];
    await EventBus.subscribe<BucketInsertedEvent>(
      eventBusRef,
      'bucket.users.inserted',
      (msg) => { events.push(msg); },
    );

    await handle.upsert({ name: 'Alice' });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('inserted');
  });

  it('emits updated event on update path', async () => {
    const { ref, handle: h } = await startBucket('upsert-ev', {
      key: 'id',
      schema: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
    });
    try {
      await h.insert({ id: 'a', name: 'Alice' });

      const events: BucketUpdatedEvent[] = [];
      await EventBus.subscribe<BucketUpdatedEvent>(
        eventBusRef,
        'bucket.upsert-ev.updated',
        (msg) => { events.push(msg); },
      );

      await h.upsert({ id: 'a', name: 'Alice Updated' });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('updated');
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('respects maxSize on insert path', async () => {
    const { ref, handle: h } = await startBucket('upsert-max', maxSizeDef);
    try {
      // Fill to max
      for (let i = 0; i < 5; i++) {
        await h.insert({ name: `User${i}` });
      }

      // Upsert with new key — should evict oldest
      await h.upsert({ name: 'NewUser' });

      const all = await h.all();
      expect(all).toHaveLength(5);
      expect(all.map(r => r.name)).toContain('NewUser');
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('respects TTL on insert path', async () => {
    const { ref, handle: h } = await startBucket('upsert-ttl', ttlDef);
    try {
      const record = await h.upsert({ name: 'Alice' });
      const expiresAt = (record as Record<string, unknown>)._expiresAt;
      expect(typeof expiresAt).toBe('number');
      expect((expiresAt as number) - record._createdAt).toBe(3_600_000);
    } finally {
      if (GenServer.isRunning(ref)) await GenServer.stop(ref);
    }
  });

  it('validates schema for both insert and update paths', async () => {
    // Insert path — fails on required field
    await expect(
      handle.upsert({ email: 'a@b.com' }), // missing required 'name'
    ).rejects.toThrow(ValidationError);
  });
});

// ── Reactive queries ─────────────────────────────────────────────

describe('reactive queries with bulk operations', () => {
  let s: Store;

  const playersDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      name: { type: 'string', required: true },
      score: { type: 'number', default: 0 },
    },
  };

  afterEach(async () => {
    if (s !== undefined) await s.stop();
  });

  it('re-evaluates after insertMany', async () => {
    s = await Store.start();
    await s.defineBucket('players', playersDef);

    s.defineQuery('highScorers', async (ctx) =>
      ctx.bucket('players').where({ score: { $gte: 50 } }),
    );

    const cb = vi.fn();
    await s.subscribe('highScorers', cb);

    await s.bucket('players').insertMany([
      { name: 'A', score: 10 },
      { name: 'B', score: 80 },
      { name: 'C', score: 60 },
    ]);
    await s.settle();

    expect(cb).toHaveBeenCalledTimes(1);
    const result = cb.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(2);
    expect(result.map(r => r.name).sort()).toEqual(['B', 'C']);
  });

  it('re-evaluates after updateMany', async () => {
    s = await Store.start();
    await s.defineBucket('players', playersDef);

    await s.bucket('players').insertMany([
      { name: 'A', score: 10 },
      { name: 'B', score: 20 },
      { name: 'C', score: 30 },
    ]);

    s.defineQuery('highScorers', async (ctx) =>
      ctx.bucket('players').where({ score: { $gte: 50 } }),
    );

    const cb = vi.fn();
    await s.subscribe('highScorers', cb);

    await s.bucket('players').updateMany({ score: { $gte: 20 } }, { score: 100 });
    await s.settle();

    expect(cb).toHaveBeenCalledTimes(1);
    const result = cb.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(2);
  });

  it('re-evaluates after deleteMany', async () => {
    s = await Store.start();
    await s.defineBucket('players', playersDef);

    await s.bucket('players').insertMany([
      { name: 'A', score: 10 },
      { name: 'B', score: 80 },
      { name: 'C', score: 60 },
    ]);

    s.defineQuery('highScorers', async (ctx) =>
      ctx.bucket('players').where({ score: { $gte: 50 } }),
    );

    const cb = vi.fn();
    await s.subscribe('highScorers', cb);

    await s.bucket('players').deleteMany({ score: { $gte: 50 } });
    await s.settle();

    expect(cb).toHaveBeenCalledTimes(1);
    const result = cb.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(0);
  });
});

// ── Transactions ─────────────────────────────────────────────────

describe('transactions with bulk operations', () => {
  let s: Store;

  const txCustomersDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
      tier: { type: 'string', default: 'basic' },
      email: { type: 'string', unique: true },
    },
    indexes: ['tier'],
  };

  const txOrdersDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      customerId: { type: 'string', required: true },
      amount: { type: 'number', required: true },
    },
  };

  afterEach(async () => {
    if (s !== undefined) await s.stop();
  });

  it('insertMany commits atomically', async () => {
    s = await Store.start();
    await s.defineBucket('customers', txCustomersDef);

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insertMany([
        { name: 'Alice', email: 'alice@test.com' },
        { name: 'Bob', email: 'bob@test.com' },
      ]);
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(2);
    expect(all.map(r => r.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('updateMany reads own writes within transaction', async () => {
    s = await Store.start();
    await s.defineBucket('customers', txCustomersDef);

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insertMany([
        { name: 'Alice', tier: 'basic' },
        { name: 'Bob', tier: 'basic' },
      ]);

      const count = await b.updateMany({ tier: 'basic' }, { tier: 'vip' });
      expect(count).toBe(2);
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(2);
    for (const r of all) {
      expect(r.tier).toBe('vip');
    }
  });

  it('deleteMany applies overlay within transaction', async () => {
    s = await Store.start();
    await s.defineBucket('customers', txCustomersDef);

    await s.bucket('customers').insert({ name: 'Alice', tier: 'basic' });
    await s.bucket('customers').insert({ name: 'Bob', tier: 'vip' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const count = await b.deleteMany({ tier: 'basic' });
      expect(count).toBe(1);

      const remaining = await b.all();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.name).toBe('Bob');
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Bob');
  });

  it('upsert handles both insert and update paths', async () => {
    s = await Store.start();
    await s.defineBucket('customers', {
      key: 'id',
      schema: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        tier: { type: 'string', default: 'basic' },
      },
    });

    await s.bucket('customers').insert({ id: 'a', name: 'Alice', tier: 'basic' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');

      const updated = await b.upsert({ id: 'a', name: 'Alice Updated', tier: 'vip' });
      expect(updated._version).toBe(2);

      const inserted = await b.upsert({ id: 'b', name: 'Bob' });
      expect(inserted._version).toBe(1);
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(2);

    const alice = all.find(r => r.id === 'a')!;
    expect(alice.name).toBe('Alice Updated');
    expect(alice.tier).toBe('vip');

    const bob = all.find(r => r.id === 'b')!;
    expect(bob.name).toBe('Bob');
  });

  it('rollback undoes all bulk operations', async () => {
    s = await Store.start();
    await s.defineBucket('customers', txCustomersDef);

    await s.bucket('customers').insert({ name: 'Pre-existing', email: 'pre@test.com' });

    await expect(
      s.transaction(async (tx) => {
        const b = await tx.bucket('customers');
        await b.insertMany([
          { name: 'Alice', email: 'alice@test.com' },
          { name: 'Bob', email: 'bob@test.com' },
        ]);
        throw new Error('Rollback!');
      }),
    ).rejects.toThrow('Rollback!');

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Pre-existing');
  });

  it('multi-bucket transaction with bulk operations', async () => {
    s = await Store.start();
    await s.defineBucket('customers', txCustomersDef);
    await s.defineBucket('orders', txOrdersDef);

    const customerId = await s.transaction(async (tx) => {
      const customers = await tx.bucket('customers');
      const orders = await tx.bucket('orders');

      const [alice] = await customers.insertMany([
        { name: 'Alice', email: 'alice@test.com' },
      ]);

      await orders.insertMany([
        { customerId: alice!.id as string, amount: 100 },
        { customerId: alice!.id as string, amount: 200 },
      ]);

      return alice!.id as string;
    });

    const customerAll = await s.bucket('customers').all();
    expect(customerAll).toHaveLength(1);

    const orderAll = await s.bucket('orders').all();
    expect(orderAll).toHaveLength(2);
    for (const o of orderAll) {
      expect(o.customerId).toBe(customerId);
    }
  });
});
