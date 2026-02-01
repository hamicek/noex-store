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
  PaginatedResult,
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

// ── Utility ─────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
