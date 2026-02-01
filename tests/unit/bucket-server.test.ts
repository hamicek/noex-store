import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import {
  createBucketBehavior,
  type BucketRef,
  type BucketCallMsg,
  type BucketCallReply,
  type BucketSnapshot,
  type BucketInitialData,
  type CommitBatchOp,
  type CommitBatchResult,
  type UndoOp,
} from '../../src/core/bucket-server.js';
import type {
  BucketDefinition,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
  PaginatedResult,
  StoreRecord,
} from '../../src/types/index.js';
import { ValidationError } from '../../src/core/schema-validator.js';
import { UniqueConstraintError, TransactionConflictError } from '../../src/core/store.js';

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

// ── first / last ────────────────────────────────────────────────

describe('BucketServer first/last', () => {
  const numericDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      label: { type: 'string', required: true },
    },
    etsType: 'ordered_set',
  };

  let numBucketRef: BucketRef;

  beforeEach(async () => {
    const behavior = createBucketBehavior('items', numericDef, eventBusRef);
    numBucketRef = await GenServer.start(behavior) as BucketRef;
  });

  afterEach(async () => {
    if (GenServer.isRunning(numBucketRef)) {
      await GenServer.stop(numBucketRef);
    }
  });

  function numCall(msg: BucketCallMsg): Promise<BucketCallReply> {
    return GenServer.call(numBucketRef, msg);
  }

  it('first — empty bucket returns empty array', async () => {
    const result = await numCall({ type: 'first', n: 3 }) as StoreRecord[];
    expect(result).toEqual([]);
  });

  it('first(3) — fewer records than n returns all', async () => {
    await numCall({ type: 'insert', data: { label: 'a' } });
    await numCall({ type: 'insert', data: { label: 'b' } });

    const result = await numCall({ type: 'first', n: 3 }) as StoreRecord[];
    expect(result).toHaveLength(2);
  });

  it('first(3) — ordered_set returns first 3 sorted by key', async () => {
    for (let i = 0; i < 5; i++) {
      await numCall({ type: 'insert', data: { label: `item-${i}` } });
    }

    const result = await numCall({ type: 'first', n: 3 }) as StoreRecord[];
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe(1);
    expect(result[1]!.id).toBe(2);
    expect(result[2]!.id).toBe(3);
  });

  it('last(3) — ordered_set returns last 3 sorted by key', async () => {
    for (let i = 0; i < 5; i++) {
      await numCall({ type: 'insert', data: { label: `item-${i}` } });
    }

    const result = await numCall({ type: 'last', n: 3 }) as StoreRecord[];
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe(3);
    expect(result[1]!.id).toBe(4);
    expect(result[2]!.id).toBe(5);
  });

  it('last(10) — fewer records returns all', async () => {
    await numCall({ type: 'insert', data: { label: 'only' } });

    const result = await numCall({ type: 'last', n: 10 }) as StoreRecord[];
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('only');
  });

  it('first/last on set bucket uses insertion order', async () => {
    const setDef: BucketDefinition = {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        label: { type: 'string', required: true },
      },
      etsType: 'set',
    };
    const behavior = createBucketBehavior('set-items', setDef, eventBusRef);
    const setRef = await GenServer.start(behavior) as BucketRef;

    await GenServer.call(setRef, { type: 'insert', data: { label: 'x' } });
    await GenServer.call(setRef, { type: 'insert', data: { label: 'y' } });
    await GenServer.call(setRef, { type: 'insert', data: { label: 'z' } });

    const first = await GenServer.call(setRef, { type: 'first', n: 2 }) as StoreRecord[];
    expect(first).toHaveLength(2);
    expect(first[0]!.label).toBe('x');
    expect(first[1]!.label).toBe('y');

    const last = await GenServer.call(setRef, { type: 'last', n: 2 }) as StoreRecord[];
    expect(last).toHaveLength(2);
    expect(last[0]!.label).toBe('y');
    expect(last[1]!.label).toBe('z');

    await GenServer.stop(setRef);
  });
});

// ── paginate ────────────────────────────────────────────────────

describe('BucketServer paginate', () => {
  const paginateDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      label: { type: 'string', required: true },
    },
    etsType: 'ordered_set',
  };

  let pagRef: BucketRef;

  beforeEach(async () => {
    const behavior = createBucketBehavior('pag', paginateDef, eventBusRef);
    pagRef = await GenServer.start(behavior) as BucketRef;
  });

  afterEach(async () => {
    if (GenServer.isRunning(pagRef)) {
      await GenServer.stop(pagRef);
    }
  });

  function pagCall(msg: BucketCallMsg): Promise<BucketCallReply> {
    return GenServer.call(pagRef, msg);
  }

  async function seedN(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await pagCall({ type: 'insert', data: { label: `r-${i}` } });
    }
  }

  it('first page — returns records with hasMore and nextCursor', async () => {
    await seedN(5);

    const page = await pagCall({ type: 'paginate', limit: 2 }) as PaginatedResult;
    expect(page.records).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(2);
    expect(page.records[0]!.id).toBe(1);
    expect(page.records[1]!.id).toBe(2);
  });

  it('second page — continues from cursor', async () => {
    await seedN(5);

    const page1 = await pagCall({ type: 'paginate', limit: 2 }) as PaginatedResult;
    const page2 = await pagCall({ type: 'paginate', after: page1.nextCursor, limit: 2 }) as PaginatedResult;

    expect(page2.records).toHaveLength(2);
    expect(page2.records[0]!.id).toBe(3);
    expect(page2.records[1]!.id).toBe(4);
    expect(page2.hasMore).toBe(true);
  });

  it('last page — hasMore is false', async () => {
    await seedN(5);

    const page = await pagCall({ type: 'paginate', after: 4, limit: 10 }) as PaginatedResult;
    expect(page.records).toHaveLength(1);
    expect(page.records[0]!.id).toBe(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe(5);
  });

  it('after last key — empty result', async () => {
    await seedN(3);

    const page = await pagCall({ type: 'paginate', after: 3, limit: 10 }) as PaginatedResult;
    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it('nonexistent cursor — returns empty', async () => {
    await seedN(3);

    const page = await pagCall({ type: 'paginate', after: 999, limit: 10 }) as PaginatedResult;
    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('ordered_set — returns sorted by key', async () => {
    await seedN(5);

    const all: StoreRecord[] = [];
    let cursor: unknown;
    let hasMore = true;

    while (hasMore) {
      const page = await pagCall({
        type: 'paginate',
        ...(cursor !== undefined ? { after: cursor } : {}),
        limit: 2,
      }) as PaginatedResult;
      all.push(...page.records);
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }

    expect(all).toHaveLength(5);
    expect(all.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('empty bucket — returns empty result', async () => {
    const page = await pagCall({ type: 'paginate', limit: 10 }) as PaginatedResult;
    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });
});

// ── sum / avg / min / max ───────────────────────────────────────

describe('BucketServer aggregations', () => {
  const aggDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      name: { type: 'string', required: true },
      score: { type: 'number', default: 0 },
      tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
    },
    indexes: ['tier'],
  };

  let aggRef: BucketRef;

  beforeEach(async () => {
    const behavior = createBucketBehavior('agg', aggDef, eventBusRef);
    aggRef = await GenServer.start(behavior) as BucketRef;
  });

  afterEach(async () => {
    if (GenServer.isRunning(aggRef)) {
      await GenServer.stop(aggRef);
    }
  });

  function aggCall(msg: BucketCallMsg): Promise<BucketCallReply> {
    return GenServer.call(aggRef, msg);
  }

  async function seedAgg(): Promise<void> {
    await aggCall({ type: 'insert', data: { name: 'Alice', score: 10, tier: 'vip' } });
    await aggCall({ type: 'insert', data: { name: 'Bob', score: 20, tier: 'basic' } });
    await aggCall({ type: 'insert', data: { name: 'Carol', score: 30, tier: 'vip' } });
    await aggCall({ type: 'insert', data: { name: 'Dave', score: 40, tier: 'basic' } });
  }

  // sum
  it('sum — whole bucket', async () => {
    await seedAgg();
    const result = await aggCall({ type: 'sum', field: 'score' });
    expect(result).toBe(100);
  });

  it('sum — with filter', async () => {
    await seedAgg();
    const result = await aggCall({ type: 'sum', field: 'score', filter: { tier: 'vip' } });
    expect(result).toBe(40);
  });

  it('sum — skips non-numeric values', async () => {
    await aggCall({ type: 'insert', data: { name: 'Test', score: 10 } });
    // name field is non-numeric
    const result = await aggCall({ type: 'sum', field: 'name' });
    expect(result).toBe(0);
  });

  it('sum — empty result returns 0', async () => {
    const result = await aggCall({ type: 'sum', field: 'score' });
    expect(result).toBe(0);
  });

  // avg
  it('avg — basic', async () => {
    await seedAgg();
    const result = await aggCall({ type: 'avg', field: 'score' });
    expect(result).toBe(25);
  });

  it('avg — empty returns 0', async () => {
    const result = await aggCall({ type: 'avg', field: 'score' });
    expect(result).toBe(0);
  });

  it('avg — with non-numeric skips them', async () => {
    await aggCall({ type: 'insert', data: { name: 'Only', score: 10 } });
    // avg over 'name' — no numeric values
    const result = await aggCall({ type: 'avg', field: 'name' });
    expect(result).toBe(0);
  });

  // min
  it('min — basic', async () => {
    await seedAgg();
    const result = await aggCall({ type: 'min', field: 'score' });
    expect(result).toBe(10);
  });

  it('min — empty returns undefined', async () => {
    const result = await aggCall({ type: 'min', field: 'score' });
    expect(result).toBeUndefined();
  });

  // max
  it('max — basic', async () => {
    await seedAgg();
    const result = await aggCall({ type: 'max', field: 'score' });
    expect(result).toBe(40);
  });

  it('max — with filter', async () => {
    await seedAgg();
    const result = await aggCall({ type: 'max', field: 'score', filter: { tier: 'vip' } });
    expect(result).toBe(30);
  });
});

// ── _expiresAt on insert ─────────────────────────────────────────

describe('BucketServer _expiresAt', () => {
  const ttlDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      name: { type: 'string', required: true },
    },
    ttl: 5000,
  };

  it('sets _expiresAt automatically when bucket has TTL', async () => {
    const ref = await startBucket('ttl-bucket', ttlDef);
    const record = await GenServer.call(ref, {
      type: 'insert',
      data: { name: 'Alice' },
    }) as StoreRecord;

    expect(record._expiresAt).toBeDefined();
    expect(record._expiresAt).toBe(record._createdAt + 5000);

    await GenServer.stop(ref);
  });

  it('does not set _expiresAt when bucket has no TTL', async () => {
    const record = await call({ type: 'insert', data: { name: 'Bob' } }) as StoreRecord;

    expect((record as Record<string, unknown>)._expiresAt).toBeUndefined();
  });

  it('preserves per-record _expiresAt override', async () => {
    const ref = await startBucket('ttl-bucket', ttlDef);
    const customExpiry = Date.now() + 999999;
    const record = await GenServer.call(ref, {
      type: 'insert',
      data: { name: 'Custom', _expiresAt: customExpiry },
    }) as StoreRecord;

    expect(record._expiresAt).toBe(customExpiry);

    await GenServer.stop(ref);
  });

  it('works with TTL as string format', async () => {
    const stringTtlDef: BucketDefinition = {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        name: { type: 'string', required: true },
      },
      ttl: '1h',
    };
    const ref = await startBucket('ttl-str', stringTtlDef);
    const record = await GenServer.call(ref, {
      type: 'insert',
      data: { name: 'Hourly' },
    }) as StoreRecord;

    expect(record._expiresAt).toBe(record._createdAt + 3_600_000);

    await GenServer.stop(ref);
  });
});

// ── purgeExpired ─────────────────────────────────────────────────

describe('BucketServer purgeExpired', () => {
  const ttlDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      name: { type: 'string', required: true },
    },
    ttl: 50, // 50ms TTL for tests
  };

  it('returns 0 for empty bucket', async () => {
    const ref = await startBucket('purge-empty', ttlDef);
    const purged = await GenServer.call(ref, { type: 'purgeExpired' });

    expect(purged).toBe(0);

    await GenServer.stop(ref);
  });

  it('does not purge non-expired records', async () => {
    const ref = await startBucket('purge-fresh', ttlDef);
    await GenServer.call(ref, { type: 'insert', data: { name: 'Fresh' } });

    const purged = await GenServer.call(ref, { type: 'purgeExpired' });

    expect(purged).toBe(0);
    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(1);

    await GenServer.stop(ref);
  });

  it('purges expired records', async () => {
    const ref = await startBucket('purge-expired', ttlDef);
    await GenServer.call(ref, { type: 'insert', data: { name: 'Will expire' } });

    await delay(80);
    const purged = await GenServer.call(ref, { type: 'purgeExpired' });

    expect(purged).toBe(1);
    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(0);

    await GenServer.stop(ref);
  });

  it('purges only expired records (mixed)', async () => {
    const longTtlDef: BucketDefinition = {
      ...ttlDef,
      ttl: 10_000,
    };
    const ref = await startBucket('purge-mixed', longTtlDef);

    // Insert one with short custom _expiresAt
    await GenServer.call(ref, {
      type: 'insert',
      data: { name: 'Short', _expiresAt: Date.now() + 50 },
    });
    // Insert one with long TTL (default)
    await GenServer.call(ref, { type: 'insert', data: { name: 'Long' } });

    await delay(80);
    const purged = await GenServer.call(ref, { type: 'purgeExpired' });

    expect(purged).toBe(1);
    const remaining = await GenServer.call(ref, { type: 'all' }) as StoreRecord[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.name).toBe('Long');

    await GenServer.stop(ref);
  });

  it('does not purge records without _expiresAt', async () => {
    // Bucket without TTL — records have no _expiresAt
    await call({ type: 'insert', data: { name: 'Permanent' } });

    const purged = await call({ type: 'purgeExpired' });
    expect(purged).toBe(0);

    const count = await call({ type: 'count' });
    expect(count).toBe(1);
  });

  it('emits deleted events for purged records', async () => {
    const ref = await startBucket('purge-events', ttlDef);
    const events: BucketDeletedEvent[] = [];
    await EventBus.subscribe<BucketDeletedEvent>(
      eventBusRef,
      'bucket.purge-events.deleted',
      (msg) => { events.push(msg); },
    );

    const record = await GenServer.call(ref, {
      type: 'insert',
      data: { name: 'Event target' },
    }) as StoreRecord;

    await delay(80);
    await GenServer.call(ref, { type: 'purgeExpired' });
    await delay(50);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('deleted');
    expect(events[0]!.bucket).toBe('purge-events');
    expect(events[0]!.key).toBe(record.id);

    await GenServer.stop(ref);
  });

  it('updates indexes after purge', async () => {
    const indexedTtlDef: BucketDefinition = {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        name: { type: 'string', required: true },
      },
      indexes: ['name'],
      ttl: 50,
    };
    const ref = await startBucket('purge-idx', indexedTtlDef);

    await GenServer.call(ref, { type: 'insert', data: { name: 'Indexed' } });

    await delay(80);
    await GenServer.call(ref, { type: 'purgeExpired' });

    const found = await GenServer.call(ref, {
      type: 'where',
      filter: { name: 'Indexed' },
    }) as StoreRecord[];
    expect(found).toHaveLength(0);

    await GenServer.stop(ref);
  });
});

// ── maxSize eviction ─────────────────────────────────────────────

describe('BucketServer maxSize eviction', () => {
  const maxSizeDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'number', generated: 'autoincrement' },
      name: { type: 'string', required: true },
    },
    maxSize: 3,
  };

  it('does not evict when under limit', async () => {
    const ref = await startBucket('max-under', maxSizeDef);

    await GenServer.call(ref, { type: 'insert', data: { name: 'A' } });
    await GenServer.call(ref, { type: 'insert', data: { name: 'B' } });

    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(2);

    await GenServer.stop(ref);
  });

  it('evicts oldest record when at capacity', async () => {
    const ref = await startBucket('max-evict', maxSizeDef);

    const r1 = await GenServer.call(ref, { type: 'insert', data: { name: 'First' } }) as StoreRecord;
    await GenServer.call(ref, { type: 'insert', data: { name: 'Second' } });
    await GenServer.call(ref, { type: 'insert', data: { name: 'Third' } });
    const r4 = await GenServer.call(ref, { type: 'insert', data: { name: 'Fourth' } }) as StoreRecord;

    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(3);

    const evicted = await GenServer.call(ref, { type: 'get', key: r1.id });
    expect(evicted).toBeUndefined();

    const newest = await GenServer.call(ref, { type: 'get', key: r4.id }) as StoreRecord;
    expect(newest.name).toBe('Fourth');

    await GenServer.stop(ref);
  });

  it('evicts record with lowest _createdAt', async () => {
    const ref = await startBucket('max-oldest', maxSizeDef);

    const r1 = await GenServer.call(ref, { type: 'insert', data: { name: 'Oldest' } }) as StoreRecord;
    await delay(5); // Ensure different _createdAt
    await GenServer.call(ref, { type: 'insert', data: { name: 'Middle' } });
    await delay(5);
    await GenServer.call(ref, { type: 'insert', data: { name: 'Newest' } });
    await delay(5);
    await GenServer.call(ref, { type: 'insert', data: { name: 'Overflow' } });

    const evicted = await GenServer.call(ref, { type: 'get', key: r1.id });
    expect(evicted).toBeUndefined();

    const all = await GenServer.call(ref, { type: 'all' }) as StoreRecord[];
    expect(all.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Middle', 'Newest', 'Overflow']),
    );

    await GenServer.stop(ref);
  });

  it('emits deleted event for evicted record', async () => {
    const ref = await startBucket('max-event', maxSizeDef);
    const events: BucketDeletedEvent[] = [];
    await EventBus.subscribe<BucketDeletedEvent>(
      eventBusRef,
      'bucket.max-event.deleted',
      (msg) => { events.push(msg); },
    );

    const r1 = await GenServer.call(ref, { type: 'insert', data: { name: 'First' } }) as StoreRecord;
    await GenServer.call(ref, { type: 'insert', data: { name: 'Second' } });
    await GenServer.call(ref, { type: 'insert', data: { name: 'Third' } });
    await GenServer.call(ref, { type: 'insert', data: { name: 'Trigger' } });

    await delay(50);

    // Should have at least 1 deleted event (the eviction)
    const evictionEvents = events.filter((e) => e.key === r1.id);
    expect(evictionEvents).toHaveLength(1);
    expect(evictionEvents[0]!.record.name).toBe('First');

    await GenServer.stop(ref);
  });

  it('eviction updates indexes', async () => {
    const indexedMaxDef: BucketDefinition = {
      ...maxSizeDef,
      indexes: ['name'],
    };
    const ref = await startBucket('max-idx', indexedMaxDef);

    await GenServer.call(ref, { type: 'insert', data: { name: 'Evicted' } });
    await GenServer.call(ref, { type: 'insert', data: { name: 'B' } });
    await GenServer.call(ref, { type: 'insert', data: { name: 'C' } });
    await GenServer.call(ref, { type: 'insert', data: { name: 'D' } });

    const found = await GenServer.call(ref, {
      type: 'where',
      filter: { name: 'Evicted' },
    }) as StoreRecord[];
    expect(found).toHaveLength(0);

    await GenServer.stop(ref);
  });

  it('maxSize: 1 — only last insert survives', async () => {
    const singleDef: BucketDefinition = {
      ...maxSizeDef,
      maxSize: 1,
    };
    const ref = await startBucket('max-one', singleDef);

    await GenServer.call(ref, { type: 'insert', data: { name: 'A' } });
    await GenServer.call(ref, { type: 'insert', data: { name: 'B' } });
    const r3 = await GenServer.call(ref, { type: 'insert', data: { name: 'C' } }) as StoreRecord;

    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(1);

    const all = await GenServer.call(ref, { type: 'all' }) as StoreRecord[];
    expect(all[0]!.name).toBe('C');
    expect(all[0]!.id).toBe(r3.id);

    await GenServer.stop(ref);
  });
});

// ── commitBatch ─────────────────────────────────────────────────

describe('BucketServer commitBatch', () => {
  const uniqueDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
      email: { type: 'string', unique: true },
      score: { type: 'number', default: 0 },
    },
    indexes: ['email'],
  };

  let txRef: BucketRef;

  beforeEach(async () => {
    const behavior = createBucketBehavior('tx-test', uniqueDef, eventBusRef);
    txRef = await GenServer.start(behavior) as BucketRef;
  });

  afterEach(async () => {
    if (GenServer.isRunning(txRef)) {
      await GenServer.stop(txRef);
    }
  });

  function txCall(msg: BucketCallMsg): Promise<BucketCallReply> {
    return GenServer.call(txRef, msg);
  }

  const now = Date.now();

  function makeRecord(overrides: Record<string, unknown> = {}): StoreRecord {
    return {
      id: 'r1',
      name: 'Alice',
      score: 0,
      _version: 1,
      _createdAt: now,
      _updatedAt: now,
      ...overrides,
    } as StoreRecord;
  }

  it('empty batch — returns empty events and undoOps', async () => {
    const result = await txCall({
      type: 'commitBatch',
      operations: [],
    }) as CommitBatchResult;

    expect(result.events).toEqual([]);
    expect(result.undoOps).toEqual([]);
  });

  it('single insert — record in table, returns inserted event + undo_insert', async () => {
    const record = makeRecord({ id: 'new-1', email: 'a@x.cz' });
    const ops: CommitBatchOp[] = [
      { type: 'insert', key: 'new-1', record },
    ];

    const result = await txCall({
      type: 'commitBatch',
      operations: ops,
    }) as CommitBatchResult;

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('inserted');
    expect(result.events[0]!.bucket).toBe('tx-test');
    expect(result.undoOps).toHaveLength(1);
    expect(result.undoOps[0]!.type).toBe('undo_insert');

    // Record actually in table
    const fetched = await txCall({ type: 'get', key: 'new-1' });
    expect(fetched).toEqual(record);
  });

  it('single update — record updated, returns updated event + undo_update', async () => {
    const inserted = await txCall({ type: 'insert', data: { name: 'Alice', score: 10 } }) as StoreRecord;
    const newRecord = { ...inserted, name: 'Alicia', score: 20, _version: 2, _updatedAt: Date.now() } as StoreRecord;

    const result = await txCall({
      type: 'commitBatch',
      operations: [
        { type: 'update', key: inserted.id, newRecord, expectedVersion: 1 },
      ],
    }) as CommitBatchResult;

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('updated');
    expect(result.undoOps).toHaveLength(1);
    expect(result.undoOps[0]!.type).toBe('undo_update');

    const fetched = await txCall({ type: 'get', key: inserted.id }) as StoreRecord;
    expect(fetched.name).toBe('Alicia');
    expect(fetched.score).toBe(20);
  });

  it('single delete — record removed, returns deleted event + undo_delete', async () => {
    const inserted = await txCall({ type: 'insert', data: { name: 'Bob' } }) as StoreRecord;

    const result = await txCall({
      type: 'commitBatch',
      operations: [
        { type: 'delete', key: inserted.id, expectedVersion: 1 },
      ],
    }) as CommitBatchResult;

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('deleted');
    expect(result.undoOps).toHaveLength(1);
    expect(result.undoOps[0]!.type).toBe('undo_delete');

    const fetched = await txCall({ type: 'get', key: inserted.id });
    expect(fetched).toBeUndefined();
  });

  it('multiple inserts — all records in table', async () => {
    const r1 = makeRecord({ id: 'a', name: 'A', email: 'a@x.cz' });
    const r2 = makeRecord({ id: 'b', name: 'B', email: 'b@x.cz' });
    const ops: CommitBatchOp[] = [
      { type: 'insert', key: 'a', record: r1 },
      { type: 'insert', key: 'b', record: r2 },
    ];

    const result = await txCall({
      type: 'commitBatch',
      operations: ops,
    }) as CommitBatchResult;

    expect(result.events).toHaveLength(2);
    expect(result.undoOps).toHaveLength(2);

    const all = await txCall({ type: 'all' }) as StoreRecord[];
    expect(all).toHaveLength(2);
  });

  it('insert + update on different records — both applied', async () => {
    const existing = await txCall({ type: 'insert', data: { name: 'Old', score: 5 } }) as StoreRecord;
    const newInsert = makeRecord({ id: 'fresh', name: 'Fresh', email: 'f@x.cz' });
    const updatedRecord = { ...existing, score: 99, _version: 2, _updatedAt: Date.now() } as StoreRecord;

    const result = await txCall({
      type: 'commitBatch',
      operations: [
        { type: 'insert', key: 'fresh', record: newInsert },
        { type: 'update', key: existing.id, newRecord: updatedRecord, expectedVersion: 1 },
      ],
    }) as CommitBatchResult;

    expect(result.events).toHaveLength(2);

    const fetched = await txCall({ type: 'get', key: existing.id }) as StoreRecord;
    expect(fetched.score).toBe(99);
    const fresh = await txCall({ type: 'get', key: 'fresh' });
    expect(fresh).toEqual(newInsert);
  });

  it('version mismatch on update → throws TransactionConflictError, no changes applied', async () => {
    const inserted = await txCall({ type: 'insert', data: { name: 'Alice' } }) as StoreRecord;
    const newRecord = { ...inserted, name: 'Alicia', _version: 2 } as StoreRecord;

    await expect(txCall({
      type: 'commitBatch',
      operations: [
        { type: 'update', key: inserted.id, newRecord, expectedVersion: 999 },
      ],
    })).rejects.toThrow(TransactionConflictError);

    // Original record unchanged
    const fetched = await txCall({ type: 'get', key: inserted.id }) as StoreRecord;
    expect(fetched.name).toBe('Alice');
  });

  it('version mismatch on delete → throws TransactionConflictError, no changes applied', async () => {
    const inserted = await txCall({ type: 'insert', data: { name: 'Bob' } }) as StoreRecord;

    await expect(txCall({
      type: 'commitBatch',
      operations: [
        { type: 'delete', key: inserted.id, expectedVersion: 999 },
      ],
    })).rejects.toThrow(TransactionConflictError);

    // Record still exists
    const fetched = await txCall({ type: 'get', key: inserted.id });
    expect(fetched).toBeDefined();
  });

  it('unique constraint violation on insert → throws, no changes applied', async () => {
    await txCall({ type: 'insert', data: { name: 'Alice', email: 'a@x.cz' } });
    const r2 = makeRecord({ id: 'dup', name: 'Dup', email: 'a@x.cz' });

    await expect(txCall({
      type: 'commitBatch',
      operations: [{ type: 'insert', key: 'dup', record: r2 }],
    })).rejects.toThrow(UniqueConstraintError);

    expect(await txCall({ type: 'get', key: 'dup' })).toBeUndefined();
  });

  it('unique constraint violation on update → throws, no changes applied', async () => {
    const r1 = await txCall({ type: 'insert', data: { name: 'A', email: 'a@x.cz' } }) as StoreRecord;
    const r2 = await txCall({ type: 'insert', data: { name: 'B', email: 'b@x.cz' } }) as StoreRecord;

    const newRecord = { ...r2, email: 'a@x.cz', _version: 2 } as StoreRecord;

    await expect(txCall({
      type: 'commitBatch',
      operations: [
        { type: 'update', key: r2.id, newRecord, expectedVersion: 1 },
      ],
    })).rejects.toThrow(UniqueConstraintError);

    // r2 unchanged
    const fetched = await txCall({ type: 'get', key: r2.id }) as StoreRecord;
    expect(fetched.email).toBe('b@x.cz');
  });

  it('insert with existing key → throws TransactionConflictError', async () => {
    const existing = await txCall({ type: 'insert', data: { name: 'Eve' } }) as StoreRecord;
    const duplicate = makeRecord({ id: existing.id, name: 'Fake' });

    await expect(txCall({
      type: 'commitBatch',
      operations: [{ type: 'insert', key: existing.id, record: duplicate }],
    })).rejects.toThrow(TransactionConflictError);
  });

  it('update of non-existing record → throws TransactionConflictError', async () => {
    const newRecord = makeRecord({ id: 'ghost', name: 'Ghost' });

    await expect(txCall({
      type: 'commitBatch',
      operations: [
        { type: 'update', key: 'ghost', newRecord, expectedVersion: 1 },
      ],
    })).rejects.toThrow(TransactionConflictError);
  });

  it('delete of non-existing record → idempotent, no event', async () => {
    const result = await txCall({
      type: 'commitBatch',
      operations: [
        { type: 'delete', key: 'ghost', expectedVersion: 1 },
      ],
    }) as CommitBatchResult;

    expect(result.events).toEqual([]);
    expect(result.undoOps).toEqual([]);
  });

  it('autoincrementUpdate — counter updated', async () => {
    await txCall({ type: 'commitBatch', operations: [], autoincrementUpdate: 42 });

    const counter = await txCall({ type: 'getAutoincrementCounter' });
    expect(counter).toBe(42);
  });

  it('autoincrementUpdate lower than current — ignored', async () => {
    // Insert increments counter to 1
    await txCall({ type: 'insert', data: { name: 'X' } });

    await txCall({ type: 'commitBatch', operations: [], autoincrementUpdate: 0 });

    const counter = await txCall({ type: 'getAutoincrementCounter' });
    expect(counter).toBe(1);
  });

  it('commitBatch does NOT publish events on EventBus', async () => {
    const events: unknown[] = [];
    await EventBus.subscribe(eventBusRef, 'bucket.tx-test.*', (msg) => { events.push(msg); });

    const record = makeRecord({ id: 'silent', email: 'silent@x.cz' });
    await txCall({
      type: 'commitBatch',
      operations: [{ type: 'insert', key: 'silent', record }],
    });

    await delay(50);
    expect(events).toHaveLength(0);
  });

  it('indexes updated after commitBatch — lookup works', async () => {
    const record = makeRecord({ id: 'idx-test', email: 'idx@x.cz' });

    await txCall({
      type: 'commitBatch',
      operations: [{ type: 'insert', key: 'idx-test', record }],
    });

    const found = await txCall({ type: 'where', filter: { email: 'idx@x.cz' } }) as StoreRecord[];
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('idx-test');
  });

  it('atomicity — failed validation leaves state unchanged for batch with valid + invalid ops', async () => {
    const existing = await txCall({ type: 'insert', data: { name: 'Alice', score: 0 } }) as StoreRecord;
    const validInsert = makeRecord({ id: 'valid', name: 'Valid', email: 'v@x.cz' });
    const badUpdate = { ...existing, name: 'Updated', _version: 2 } as StoreRecord;

    // First op is valid insert, second op has wrong expected version
    await expect(txCall({
      type: 'commitBatch',
      operations: [
        { type: 'insert', key: 'valid', record: validInsert },
        { type: 'update', key: existing.id, newRecord: badUpdate, expectedVersion: 999 },
      ],
    })).rejects.toThrow(TransactionConflictError);

    // Neither op should have been applied (Phase 1 validation catches it)
    expect(await txCall({ type: 'get', key: 'valid' })).toBeUndefined();
    const fetched = await txCall({ type: 'get', key: existing.id }) as StoreRecord;
    expect(fetched.name).toBe('Alice');
  });
});

// ── rollbackBatch ────────────────────────────────────────────────

describe('BucketServer rollbackBatch', () => {
  const txDef: BucketDefinition = {
    key: 'id',
    schema: {
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
      email: { type: 'string', unique: true },
      score: { type: 'number', default: 0 },
    },
    indexes: ['email'],
  };

  let txRef: BucketRef;

  beforeEach(async () => {
    const behavior = createBucketBehavior('rb-test', txDef, eventBusRef);
    txRef = await GenServer.start(behavior) as BucketRef;
  });

  afterEach(async () => {
    if (GenServer.isRunning(txRef)) {
      await GenServer.stop(txRef);
    }
  });

  function txCall(msg: BucketCallMsg): Promise<BucketCallReply> {
    return GenServer.call(txRef, msg);
  }

  const now = Date.now();

  it('undo_insert — record removed from table', async () => {
    const record = {
      id: 'ins-1', name: 'A', score: 0, email: 'a@x.cz',
      _version: 1, _createdAt: now, _updatedAt: now,
    } as StoreRecord;

    // Commit an insert
    const result = await txCall({
      type: 'commitBatch',
      operations: [{ type: 'insert', key: 'ins-1', record }],
    }) as CommitBatchResult;

    // Rollback
    await txCall({ type: 'rollbackBatch', undoOps: result.undoOps });

    expect(await txCall({ type: 'get', key: 'ins-1' })).toBeUndefined();
  });

  it('undo_update — old record restored', async () => {
    const inserted = await txCall({ type: 'insert', data: { name: 'Alice', score: 10 } }) as StoreRecord;
    const newRecord = { ...inserted, name: 'Alicia', score: 99, _version: 2, _updatedAt: Date.now() } as StoreRecord;

    const result = await txCall({
      type: 'commitBatch',
      operations: [
        { type: 'update', key: inserted.id, newRecord, expectedVersion: 1 },
      ],
    }) as CommitBatchResult;

    await txCall({ type: 'rollbackBatch', undoOps: result.undoOps });

    const fetched = await txCall({ type: 'get', key: inserted.id }) as StoreRecord;
    expect(fetched.name).toBe('Alice');
    expect(fetched.score).toBe(10);
    expect(fetched._version).toBe(1);
  });

  it('undo_delete — record re-inserted', async () => {
    const inserted = await txCall({ type: 'insert', data: { name: 'Bob', email: 'bob@x.cz' } }) as StoreRecord;

    const result = await txCall({
      type: 'commitBatch',
      operations: [
        { type: 'delete', key: inserted.id, expectedVersion: 1 },
      ],
    }) as CommitBatchResult;

    await txCall({ type: 'rollbackBatch', undoOps: result.undoOps });

    const fetched = await txCall({ type: 'get', key: inserted.id }) as StoreRecord;
    expect(fetched).toBeDefined();
    expect(fetched.name).toBe('Bob');
  });

  it('multiple undo ops — state identical to before commitBatch', async () => {
    const r1 = await txCall({ type: 'insert', data: { name: 'A', score: 10, email: 'a@x.cz' } }) as StoreRecord;
    const r2 = await txCall({ type: 'insert', data: { name: 'B', score: 20, email: 'b@x.cz' } }) as StoreRecord;

    const now2 = Date.now();
    const newR1 = { ...r1, score: 99, _version: 2, _updatedAt: now2 } as StoreRecord;
    const newInsert = {
      id: 'new-1', name: 'New', score: 0, email: 'new@x.cz',
      _version: 1, _createdAt: now2, _updatedAt: now2,
    } as StoreRecord;

    const result = await txCall({
      type: 'commitBatch',
      operations: [
        { type: 'update', key: r1.id, newRecord: newR1, expectedVersion: 1 },
        { type: 'delete', key: r2.id, expectedVersion: 1 },
        { type: 'insert', key: 'new-1', record: newInsert },
      ],
    }) as CommitBatchResult;

    // Rollback
    await txCall({ type: 'rollbackBatch', undoOps: result.undoOps });

    // State should be exactly as before commitBatch
    const fetchedR1 = await txCall({ type: 'get', key: r1.id }) as StoreRecord;
    expect(fetchedR1.score).toBe(10);
    expect(fetchedR1._version).toBe(1);

    const fetchedR2 = await txCall({ type: 'get', key: r2.id }) as StoreRecord;
    expect(fetchedR2).toBeDefined();
    expect(fetchedR2.name).toBe('B');

    expect(await txCall({ type: 'get', key: 'new-1' })).toBeUndefined();
  });

  it('undo_update restores indexes — lookup returns correct result', async () => {
    const inserted = await txCall({ type: 'insert', data: { name: 'A', email: 'old@x.cz' } }) as StoreRecord;
    const newRecord = { ...inserted, email: 'new@x.cz', _version: 2, _updatedAt: Date.now() } as StoreRecord;

    const result = await txCall({
      type: 'commitBatch',
      operations: [
        { type: 'update', key: inserted.id, newRecord, expectedVersion: 1 },
      ],
    }) as CommitBatchResult;

    await txCall({ type: 'rollbackBatch', undoOps: result.undoOps });

    // Old email should be in index again
    const byOld = await txCall({ type: 'where', filter: { email: 'old@x.cz' } }) as StoreRecord[];
    expect(byOld).toHaveLength(1);

    // New email should be gone
    const byNew = await txCall({ type: 'where', filter: { email: 'new@x.cz' } }) as StoreRecord[];
    expect(byNew).toHaveLength(0);
  });

  it('rollbackBatch does NOT publish events on EventBus', async () => {
    const events: unknown[] = [];
    await EventBus.subscribe(eventBusRef, 'bucket.rb-test.*', (msg) => { events.push(msg); });

    const inserted = await txCall({ type: 'insert', data: { name: 'X' } }) as StoreRecord;
    // Clear insert event
    await delay(50);
    events.length = 0;

    const result = await txCall({
      type: 'commitBatch',
      operations: [
        { type: 'delete', key: inserted.id, expectedVersion: 1 },
      ],
    }) as CommitBatchResult;

    await txCall({ type: 'rollbackBatch', undoOps: result.undoOps });

    await delay(50);
    // No events from commitBatch or rollbackBatch
    expect(events).toHaveLength(0);
  });
});

// ── getAutoincrementCounter ──────────────────────────────────────

describe('BucketServer getAutoincrementCounter', () => {
  it('returns 0 for fresh bucket', async () => {
    const counter = await call({ type: 'getAutoincrementCounter' });
    expect(counter).toBe(0);
  });

  it('returns incremented counter after insert', async () => {
    await call({ type: 'insert', data: { name: 'Alice' } });
    const counter = await call({ type: 'getAutoincrementCounter' });
    expect(counter).toBe(1);
  });

  it('returns correct counter after multiple inserts', async () => {
    await call({ type: 'insert', data: { name: 'A' } });
    await call({ type: 'insert', data: { name: 'B' } });
    await call({ type: 'insert', data: { name: 'C' } });
    const counter = await call({ type: 'getAutoincrementCounter' });
    expect(counter).toBe(3);
  });
});

// ── Utility ─────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
