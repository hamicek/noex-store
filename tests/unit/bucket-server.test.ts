import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import {
  createBucketBehavior,
  type BucketRef,
  type BucketCallMsg,
  type BucketCallReply,
  type BucketSnapshot,
  type BucketInitialData,
} from '../../src/core/bucket-server.js';
import type {
  BucketDefinition,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
  StoreRecord,
} from '../../src/types/index.js';
import { ValidationError } from '../../src/core/schema-validator.js';
import { UniqueConstraintError } from '../../src/core/store.js';

// ── Helpers ──────────────────────────────────────────────────────

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

async function startBucket(
  bucketName: string,
  definition: BucketDefinition,
): Promise<BucketRef> {
  const behavior = createBucketBehavior(bucketName, definition, eventBusRef);
  return GenServer.start(behavior) as Promise<BucketRef>;
}

function call(msg: BucketCallMsg): Promise<BucketCallReply> {
  return GenServer.call(bucketRef, msg);
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
  bucketRef = await startBucket('users', usersDef);
});

afterEach(async () => {
  if (GenServer.isRunning(bucketRef)) {
    await GenServer.stop(bucketRef);
  }
  if (EventBus.isRunning(eventBusRef)) {
    await EventBus.stop(eventBusRef);
  }
});

// ── CRUD ────────────────────────────────────────────────────────

describe('BucketServer CRUD', () => {
  it('inserts a record and returns it with meta + generated fields', async () => {
    const result = await call({ type: 'insert', data: { name: 'Alice' } }) as StoreRecord;

    expect(result.id).toMatch(UUID_RE);
    expect(result.name).toBe('Alice');
    expect(result.tier).toBe('basic');
    expect(result._version).toBe(1);
    expect(typeof result._createdAt).toBe('number');
    expect(result._createdAt).toBe(result._updatedAt);
  });

  it('retrieves an inserted record by key', async () => {
    const inserted = await call({ type: 'insert', data: { name: 'Bob' } }) as StoreRecord;
    const fetched = await call({ type: 'get', key: inserted.id });

    expect(fetched).toEqual(inserted);
  });

  it('returns undefined for a non-existing key', async () => {
    const result = await call({ type: 'get', key: 'no-such-id' });
    expect(result).toBeUndefined();
  });

  it('updates a record and returns the new version', async () => {
    const inserted = await call({ type: 'insert', data: { name: 'Carol' } }) as StoreRecord;
    const updated = await call({
      type: 'update',
      key: inserted.id,
      changes: { name: 'Caroline', tier: 'vip' },
    }) as StoreRecord;

    expect(updated.id).toBe(inserted.id);
    expect(updated.name).toBe('Caroline');
    expect(updated.tier).toBe('vip');
    expect(updated._version).toBe(2);
    expect(updated._createdAt).toBe(inserted._createdAt);
    expect(updated._updatedAt).toBeGreaterThanOrEqual(inserted._updatedAt);
  });

  it('deletes a record (get returns undefined after)', async () => {
    const inserted = await call({ type: 'insert', data: { name: 'Dave' } }) as StoreRecord;
    await call({ type: 'delete', key: inserted.id });
    const result = await call({ type: 'get', key: inserted.id });

    expect(result).toBeUndefined();
  });

  it('throws on update of non-existing key', async () => {
    await expect(
      call({ type: 'update', key: 'ghost', changes: { name: 'Nope' } }),
    ).rejects.toThrow(/not found/i);
  });

  it('delete of non-existing key is a no-op', async () => {
    await expect(
      call({ type: 'delete', key: 'ghost' }),
    ).resolves.toBeUndefined();
  });

  it('clears all records', async () => {
    await call({ type: 'insert', data: { name: 'E1' } });
    await call({ type: 'insert', data: { name: 'E2' } });
    await call({ type: 'clear' });
    const all = await call({ type: 'all' }) as StoreRecord[];

    expect(all).toHaveLength(0);
  });
});

// ── Queries ─────────────────────────────────────────────────────

describe('BucketServer queries', () => {
  async function seedRecords(): Promise<StoreRecord[]> {
    const r1 = await call({ type: 'insert', data: { name: 'Alice', tier: 'vip' } }) as StoreRecord;
    const r2 = await call({ type: 'insert', data: { name: 'Bob' } }) as StoreRecord;
    const r3 = await call({ type: 'insert', data: { name: 'Carol' } }) as StoreRecord;
    return [r1, r2, r3];
  }

  it('all() returns every record', async () => {
    const seeded = await seedRecords();
    const all = await call({ type: 'all' }) as StoreRecord[];

    expect(all).toHaveLength(3);
    expect(all.map((r) => r.name)).toEqual(
      expect.arrayContaining(seeded.map((r) => r.name)),
    );
  });

  it('where() filters by simple equality', async () => {
    await seedRecords();
    const vips = await call({ type: 'where', filter: { tier: 'vip' } }) as StoreRecord[];

    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Alice');
  });

  it('where() returns empty array when no match', async () => {
    await seedRecords();
    const result = await call({ type: 'where', filter: { name: 'Nobody' } }) as StoreRecord[];

    expect(result).toEqual([]);
  });

  it('findOne() returns the first matching record', async () => {
    await seedRecords();
    const result = await call({ type: 'findOne', filter: { tier: 'basic' } }) as StoreRecord;

    expect(result).toBeDefined();
    expect(result.tier).toBe('basic');
  });

  it('findOne() returns undefined when no match', async () => {
    await seedRecords();
    const result = await call({ type: 'findOne', filter: { name: 'Nobody' } });

    expect(result).toBeUndefined();
  });

  it('count() without filter returns total count', async () => {
    await seedRecords();
    const count = await call({ type: 'count' });

    expect(count).toBe(3);
  });

  it('count() with filter returns filtered count', async () => {
    await seedRecords();
    const count = await call({ type: 'count', filter: { tier: 'basic' } });

    expect(count).toBe(2);
  });

  it('where() supports multi-field filter', async () => {
    await seedRecords();
    const result = await call({
      type: 'where',
      filter: { tier: 'basic', name: 'Bob' },
    }) as StoreRecord[];

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Bob');
  });
});

// ── Validation ──────────────────────────────────────────────────

describe('BucketServer validation', () => {
  it('rejects insert with missing required field', async () => {
    await expect(
      call({ type: 'insert', data: {} }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects insert with invalid enum value', async () => {
    await expect(
      call({ type: 'insert', data: { name: 'Test', tier: 'premium' } }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects insert with invalid format', async () => {
    await expect(
      call({ type: 'insert', data: { name: 'Test', email: 'bad' } }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects update with values violating schema', async () => {
    const inserted = await call({ type: 'insert', data: { name: 'Valid' } }) as StoreRecord;

    await expect(
      call({ type: 'update', key: inserted.id, changes: { name: '' } }),
    ).rejects.toThrow(ValidationError);
  });
});

// ── EventBus integration ────────────────────────────────────────

describe('BucketServer events', () => {
  it('publishes bucket.<name>.inserted on insert', async () => {
    const events: BucketInsertedEvent[] = [];
    await EventBus.subscribe<BucketInsertedEvent>(
      eventBusRef,
      'bucket.users.inserted',
      (msg) => { events.push(msg); },
    );

    const record = await call({ type: 'insert', data: { name: 'Eve' } }) as StoreRecord;

    // EventBus.publish is fire-and-forget (cast), wait for delivery
    await delay(50);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('inserted');
    expect(events[0]!.bucket).toBe('users');
    expect(events[0]!.key).toBe(record.id);
    expect(events[0]!.record).toEqual(record);
  });

  it('publishes bucket.<name>.updated on update', async () => {
    const events: BucketUpdatedEvent[] = [];
    await EventBus.subscribe<BucketUpdatedEvent>(
      eventBusRef,
      'bucket.users.updated',
      (msg) => { events.push(msg); },
    );

    const inserted = await call({ type: 'insert', data: { name: 'Frank' } }) as StoreRecord;
    const updated = await call({
      type: 'update',
      key: inserted.id,
      changes: { name: 'Frankie' },
    }) as StoreRecord;

    await delay(50);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('updated');
    expect(events[0]!.bucket).toBe('users');
    expect(events[0]!.oldRecord).toEqual(inserted);
    expect(events[0]!.newRecord).toEqual(updated);
  });

  it('publishes bucket.<name>.deleted on delete', async () => {
    const events: BucketDeletedEvent[] = [];
    await EventBus.subscribe<BucketDeletedEvent>(
      eventBusRef,
      'bucket.users.deleted',
      (msg) => { events.push(msg); },
    );

    const inserted = await call({ type: 'insert', data: { name: 'Grace' } }) as StoreRecord;
    await call({ type: 'delete', key: inserted.id });

    await delay(50);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('deleted');
    expect(events[0]!.bucket).toBe('users');
    expect(events[0]!.key).toBe(inserted.id);
    expect(events[0]!.record).toEqual(inserted);
  });

  it('does not publish deleted event when key does not exist', async () => {
    const events: BucketDeletedEvent[] = [];
    await EventBus.subscribe<BucketDeletedEvent>(
      eventBusRef,
      'bucket.users.deleted',
      (msg) => { events.push(msg); },
    );

    await call({ type: 'delete', key: 'no-such-key' });

    await delay(50);

    expect(events).toHaveLength(0);
  });

  it('matches wildcard subscription on bucket.*', async () => {
    const events: unknown[] = [];
    await EventBus.subscribe(
      eventBusRef,
      'bucket.users.*',
      (msg) => { events.push(msg); },
    );

    const record = await call({ type: 'insert', data: { name: 'Hank' } }) as StoreRecord;
    await call({ type: 'update', key: record.id, changes: { name: 'Henry' } });
    await call({ type: 'delete', key: record.id });

    await delay(50);

    expect(events).toHaveLength(3);
  });
});

// ── Autoincrement bucket ────────────────────────────────────────

describe('BucketServer with autoincrement key', () => {
  let autoBucketRef: BucketRef;

  const autoDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      label: { type: 'string', required: true },
    },
  };

  beforeEach(async () => {
    const behavior = createBucketBehavior('items', autoDef, eventBusRef);
    autoBucketRef = await GenServer.start(behavior) as BucketRef;
  });

  afterEach(async () => {
    if (GenServer.isRunning(autoBucketRef)) {
      await GenServer.stop(autoBucketRef);
    }
  });

  it('generates sequential autoincrement keys', async () => {
    const r1 = await GenServer.call(autoBucketRef, {
      type: 'insert' as const,
      data: { label: 'first' },
    }) as StoreRecord;

    const r2 = await GenServer.call(autoBucketRef, {
      type: 'insert' as const,
      data: { label: 'second' },
    }) as StoreRecord;

    expect(r1.id).toBe(1);
    expect(r2.id).toBe(2);
  });

  it('can retrieve by numeric key', async () => {
    await GenServer.call(autoBucketRef, {
      type: 'insert' as const,
      data: { label: 'test' },
    });

    const result = await GenServer.call(autoBucketRef, {
      type: 'get' as const,
      key: 1,
    }) as StoreRecord;

    expect(result.label).toBe('test');
  });
});

// ── getSnapshot ──────────────────────────────────────────────────

describe('BucketServer getSnapshot', () => {
  it('returns empty snapshot for empty bucket', async () => {
    const snapshot = await call({ type: 'getSnapshot' }) as BucketSnapshot;

    expect(snapshot.records).toEqual([]);
    expect(snapshot.autoincrementCounter).toBe(0);
  });

  it('returns records and counter after insert', async () => {
    const record = await call({ type: 'insert', data: { name: 'Alice' } }) as StoreRecord;
    const snapshot = await call({ type: 'getSnapshot' }) as BucketSnapshot;

    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]![0]).toBe(record.id);
    expect(snapshot.records[0]![1]).toEqual(record);
    expect(snapshot.autoincrementCounter).toBe(1);
  });

  it('reflects current state after insert, update, and delete', async () => {
    const r1 = await call({ type: 'insert', data: { name: 'Alice' } }) as StoreRecord;
    const r2 = await call({ type: 'insert', data: { name: 'Bob' } }) as StoreRecord;
    await call({ type: 'update', key: r1.id, changes: { name: 'Alicia' } });
    await call({ type: 'delete', key: r2.id });

    const snapshot = await call({ type: 'getSnapshot' }) as BucketSnapshot;

    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]![1].name).toBe('Alicia');
  });

  it('tracks correct counter after multiple inserts', async () => {
    let autoBucketRef: BucketRef;
    const autoDef: BucketDefinition = {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        label: { type: 'string', required: true },
      },
    };
    const behavior = createBucketBehavior('items', autoDef, eventBusRef);
    autoBucketRef = await GenServer.start(behavior) as BucketRef;

    await GenServer.call(autoBucketRef, { type: 'insert', data: { label: 'a' } });
    await GenServer.call(autoBucketRef, { type: 'insert', data: { label: 'b' } });
    await GenServer.call(autoBucketRef, { type: 'insert', data: { label: 'c' } });

    const snapshot = await GenServer.call(autoBucketRef, { type: 'getSnapshot' }) as BucketSnapshot;

    expect(snapshot.records).toHaveLength(3);
    expect(snapshot.autoincrementCounter).toBe(3);

    await GenServer.stop(autoBucketRef);
  });
});

// ── initialData restore ──────────────────────────────────────────

describe('BucketServer initialData restore', () => {
  const now = Date.now();

  const sampleRecords: ReadonlyArray<readonly [unknown, StoreRecord]> = [
    ['id-1', { id: 'id-1', name: 'Alice', tier: 'vip', _version: 1, _createdAt: now, _updatedAt: now } as StoreRecord],
    ['id-2', { id: 'id-2', name: 'Bob', tier: 'basic', _version: 1, _createdAt: now, _updatedAt: now } as StoreRecord],
  ];

  async function startWithInitialData(
    bucketName: string,
    definition: BucketDefinition,
    initialData: BucketInitialData,
  ): Promise<BucketRef> {
    const behavior = createBucketBehavior(bucketName, definition, eventBusRef, initialData);
    return GenServer.start(behavior) as Promise<BucketRef>;
  }

  it('restores records from initialData', async () => {
    const ref = await startWithInitialData('users', usersDef, {
      records: sampleRecords,
      autoincrementCounter: 0,
    });

    const r1 = await GenServer.call(ref, { type: 'get', key: 'id-1' }) as StoreRecord;
    const r2 = await GenServer.call(ref, { type: 'get', key: 'id-2' }) as StoreRecord;

    expect(r1.name).toBe('Alice');
    expect(r2.name).toBe('Bob');

    const all = await GenServer.call(ref, { type: 'all' }) as StoreRecord[];
    expect(all).toHaveLength(2);

    await GenServer.stop(ref);
  });

  it('continues autoincrement counter from restored value', async () => {
    const autoDef: BucketDefinition = {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        label: { type: 'string', required: true },
      },
    };

    const ref = await startWithInitialData('items', autoDef, {
      records: [
        [1, { id: 1, label: 'first', _version: 1, _createdAt: now, _updatedAt: now } as StoreRecord],
        [2, { id: 2, label: 'second', _version: 1, _createdAt: now, _updatedAt: now } as StoreRecord],
        [3, { id: 3, label: 'third', _version: 1, _createdAt: now, _updatedAt: now } as StoreRecord],
      ],
      autoincrementCounter: 3,
    });

    const newRecord = await GenServer.call(ref, {
      type: 'insert',
      data: { label: 'fourth' },
    }) as StoreRecord;

    expect(newRecord.id).toBe(4);

    await GenServer.stop(ref);
  });

  it('rebuilds indexes from initialData — where() works', async () => {
    const indexedDef: BucketDefinition = {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
        tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
      },
      indexes: ['tier'],
    };

    const ref = await startWithInitialData('users', indexedDef, {
      records: sampleRecords,
      autoincrementCounter: 0,
    });

    const vips = await GenServer.call(ref, {
      type: 'where',
      filter: { tier: 'vip' },
    }) as StoreRecord[];

    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Alice');

    await GenServer.stop(ref);
  });

  it('rebuilds unique indexes — duplicate insert throws UniqueConstraintError', async () => {
    const uniqueDef: BucketDefinition = {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
        email: { type: 'string', unique: true },
      },
    };

    const ref = await startWithInitialData('users', uniqueDef, {
      records: [
        ['id-1', { id: 'id-1', name: 'Alice', email: 'alice@test.cz', _version: 1, _createdAt: now, _updatedAt: now } as StoreRecord],
      ],
      autoincrementCounter: 0,
    });

    await expect(
      GenServer.call(ref, {
        type: 'insert',
        data: { name: 'Fake Alice', email: 'alice@test.cz' },
      }),
    ).rejects.toThrow(UniqueConstraintError);

    await GenServer.stop(ref);
  });

  it('handles empty initialData gracefully', async () => {
    const ref = await startWithInitialData('users', usersDef, {
      records: [],
      autoincrementCounter: 0,
    });

    const all = await GenServer.call(ref, { type: 'all' }) as StoreRecord[];
    expect(all).toHaveLength(0);

    const count = await GenServer.call(ref, { type: 'count' }) as number;
    expect(count).toBe(0);

    await GenServer.stop(ref);
  });
});

// ── Utility ─────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
