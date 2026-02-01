import { describe, it, expect, afterEach } from 'vitest';
import { Store, BucketAlreadyExistsError, BucketNotDefinedError } from '../../src/core/store.js';
import { ValidationError } from '../../src/core/schema-validator.js';
import type {
  BucketDefinition,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
  BucketEvent,
  StoreRecord,
} from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const usersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true, minLength: 1 },
    tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
    email: { type: 'string', format: 'email' },
    createdAt: { type: 'date', generated: 'timestamp' },
  },
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    product: { type: 'string', required: true },
    quantity: { type: 'number', required: true, min: 1 },
    status: { type: 'string', enum: ['pending', 'shipped', 'delivered'], default: 'pending' },
  },
};

// ── Helpers ───────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ── Tests ─────────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────

describe('Store lifecycle', () => {
  it('starts and stops without error', async () => {
    store = await Store.start();
    expect(store.name).toMatch(/^store-\d+$/);
    await store.stop();
    store = undefined!;
  });

  it('accepts a custom name', async () => {
    store = await Store.start({ name: 'my-store' });
    expect(store.name).toBe('my-store');
  });

  it('can stop immediately after start with no buckets', async () => {
    store = await Store.start();
    await store.stop();
    store = undefined!;
  });
});

// ── defineBucket ──────────────────────────────────────────────────

describe('Store.defineBucket', () => {
  it('defines a bucket successfully', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    const handle = store.bucket('users');
    expect(handle.name).toBe('users');
  });

  it('throws BucketAlreadyExistsError on duplicate', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    await expect(
      store.defineBucket('users', usersDef),
    ).rejects.toThrow(BucketAlreadyExistsError);
  });

  it('rejects definition where key field is not in schema', async () => {
    store = await Store.start();

    await expect(
      store.defineBucket('bad', {
        key: 'missing',
        schema: { name: { type: 'string' } },
      }),
    ).rejects.toThrow(/key field "missing" does not exist/i);
  });

  it('rejects definition where index field is not in schema', async () => {
    store = await Store.start();

    await expect(
      store.defineBucket('bad', {
        key: 'id',
        schema: { id: { type: 'string', generated: 'uuid' } },
        indexes: ['ghost'],
      }),
    ).rejects.toThrow(/index field "ghost" does not exist/i);
  });
});

// ── bucket() ──────────────────────────────────────────────────────

describe('Store.bucket', () => {
  it('throws BucketNotDefinedError for unknown bucket', async () => {
    store = await Store.start();

    expect(() => store.bucket('unknown')).toThrow(BucketNotDefinedError);
  });

  it('returns a new handle instance on each call', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    const h1 = store.bucket('users');
    const h2 = store.bucket('users');

    expect(h1).not.toBe(h2);
    expect(h1.name).toBe(h2.name);
  });
});

// ── Full CRUD lifecycle ──────────────────────────────────────────

describe('Store CRUD lifecycle', () => {
  it('insert → get → update → get → delete → get', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    const users = store.bucket('users');

    // Insert
    const inserted = await users.insert({ name: 'Alice' });
    expect(inserted.id).toMatch(UUID_RE);
    expect(inserted.name).toBe('Alice');
    expect(inserted.tier).toBe('basic');
    expect(inserted._version).toBe(1);
    expect(typeof inserted._createdAt).toBe('number');
    expect(typeof inserted.createdAt).toBe('number');

    // Get
    const fetched = await users.get(inserted.id);
    expect(fetched).toEqual(inserted);

    // Update
    const updated = await users.update(inserted.id, { name: 'Alice Cooper', tier: 'vip' });
    expect(updated.id).toBe(inserted.id);
    expect(updated.name).toBe('Alice Cooper');
    expect(updated.tier).toBe('vip');
    expect(updated._version).toBe(2);
    expect(updated._createdAt).toBe(inserted._createdAt);
    expect(updated._updatedAt).toBeGreaterThanOrEqual(inserted._updatedAt);

    // Get after update
    const refetched = await users.get(inserted.id);
    expect(refetched).toEqual(updated);

    // Delete
    await users.delete(inserted.id);

    // Get after delete
    const gone = await users.get(inserted.id);
    expect(gone).toBeUndefined();
  });
});

// ── Schema enforcement ───────────────────────────────────────────

describe('Store schema enforcement', () => {
  it('rejects insert with missing required field', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    await expect(
      store.bucket('users').insert({}),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects insert with invalid enum value', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    await expect(
      store.bucket('users').insert({ name: 'Test', tier: 'premium' }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects insert with invalid format', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    await expect(
      store.bucket('users').insert({ name: 'Test', email: 'not-an-email' }),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts insert with valid format', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    const record = await store.bucket('users').insert({
      name: 'Test',
      email: 'test@example.com',
    });
    expect(record.email).toBe('test@example.com');
  });

  it('rejects update violating constraints', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    const record = await store.bucket('users').insert({ name: 'Valid' });

    await expect(
      store.bucket('users').update(record.id, { name: '' }),
    ).rejects.toThrow(ValidationError);
  });
});

// ── Event flow ───────────────────────────────────────────────────

describe('Store events', () => {
  it('receives inserted event via store.on()', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    const events: BucketInsertedEvent[] = [];
    await store.on<BucketInsertedEvent>('bucket.users.inserted', (msg) => {
      events.push(msg);
    });

    const record = await store.bucket('users').insert({ name: 'Eve' });
    await delay(50);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('inserted');
    expect(events[0]!.bucket).toBe('users');
    expect(events[0]!.record).toEqual(record);
  });

  it('receives updated event via store.on()', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    const events: BucketUpdatedEvent[] = [];
    await store.on<BucketUpdatedEvent>('bucket.users.updated', (msg) => {
      events.push(msg);
    });

    const record = await store.bucket('users').insert({ name: 'Frank' });
    const updated = await store.bucket('users').update(record.id, { name: 'Frankie' });
    await delay(50);

    expect(events).toHaveLength(1);
    expect(events[0]!.oldRecord).toEqual(record);
    expect(events[0]!.newRecord).toEqual(updated);
  });

  it('receives deleted event via store.on()', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    const events: BucketDeletedEvent[] = [];
    await store.on<BucketDeletedEvent>('bucket.users.deleted', (msg) => {
      events.push(msg);
    });

    const record = await store.bucket('users').insert({ name: 'Grace' });
    await store.bucket('users').delete(record.id);
    await delay(50);

    expect(events).toHaveLength(1);
    expect(events[0]!.record).toEqual(record);
  });

  it('wildcard subscription catches all bucket events', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    const events: BucketEvent[] = [];
    await store.on<BucketEvent>('bucket.users.*', (msg) => {
      events.push(msg);
    });

    const record = await store.bucket('users').insert({ name: 'Hank' });
    await store.bucket('users').update(record.id, { name: 'Henry' });
    await store.bucket('users').delete(record.id);
    await delay(50);

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(['inserted', 'updated', 'deleted']);
  });

  it('unsubscribe stops event delivery', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);

    const events: BucketInsertedEvent[] = [];
    const unsub = await store.on<BucketInsertedEvent>('bucket.users.inserted', (msg) => {
      events.push(msg);
    });

    await store.bucket('users').insert({ name: 'First' });
    await delay(50);
    expect(events).toHaveLength(1);

    await unsub();

    await store.bucket('users').insert({ name: 'Second' });
    await delay(50);
    expect(events).toHaveLength(1);
  });
});

// ── Multiple independent buckets ─────────────────────────────────

describe('Store multiple buckets', () => {
  it('operates independent buckets without interference', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    await store.defineBucket('orders', ordersDef);

    const user = await store.bucket('users').insert({ name: 'Alice' });
    const order = await store.bucket('orders').insert({ product: 'Widget', quantity: 3 });

    expect(user.id).toMatch(UUID_RE);
    expect(order.id).toBe(1);
    expect(order.status).toBe('pending');

    expect(await store.bucket('users').count()).toBe(1);
    expect(await store.bucket('orders').count()).toBe(1);

    await store.bucket('users').delete(user.id);
    expect(await store.bucket('users').count()).toBe(0);
    expect(await store.bucket('orders').count()).toBe(1);
  });

  it('events are scoped per bucket', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    await store.defineBucket('orders', ordersDef);

    const userEvents: BucketEvent[] = [];
    const orderEvents: BucketEvent[] = [];

    await store.on<BucketEvent>('bucket.users.*', (msg) => { userEvents.push(msg); });
    await store.on<BucketEvent>('bucket.orders.*', (msg) => { orderEvents.push(msg); });

    await store.bucket('users').insert({ name: 'Alice' });
    await store.bucket('orders').insert({ product: 'Widget', quantity: 1 });
    await delay(50);

    expect(userEvents).toHaveLength(1);
    expect(orderEvents).toHaveLength(1);
    expect(userEvents[0]!.bucket).toBe('users');
    expect(orderEvents[0]!.bucket).toBe('orders');
  });
});

// ── Query operations ─────────────────────────────────────────────

describe('Store queries', () => {
  async function seedUsers(s: Store): Promise<StoreRecord[]> {
    const bucket = s.bucket('users');
    const r1 = await bucket.insert({ name: 'Alice', tier: 'vip' });
    const r2 = await bucket.insert({ name: 'Bob' });
    const r3 = await bucket.insert({ name: 'Carol' });
    return [r1, r2, r3];
  }

  it('all() returns every record', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    const seeded = await seedUsers(store);

    const all = await store.bucket('users').all();
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.name)).toEqual(
      expect.arrayContaining(seeded.map((r) => r.name)),
    );
  });

  it('where() filters by equality', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    await seedUsers(store);

    const vips = await store.bucket('users').where({ tier: 'vip' });
    expect(vips).toHaveLength(1);
    expect(vips[0]!.name).toBe('Alice');
  });

  it('where() returns empty for no match', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    await seedUsers(store);

    const result = await store.bucket('users').where({ name: 'Nobody' });
    expect(result).toEqual([]);
  });

  it('findOne() returns the first match', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    await seedUsers(store);

    const result = await store.bucket('users').findOne({ tier: 'basic' });
    expect(result).toBeDefined();
    expect(result!.tier).toBe('basic');
  });

  it('findOne() returns undefined for no match', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    await seedUsers(store);

    const result = await store.bucket('users').findOne({ name: 'Nobody' });
    expect(result).toBeUndefined();
  });

  it('count() without filter returns total', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    await seedUsers(store);

    expect(await store.bucket('users').count()).toBe(3);
  });

  it('count() with filter returns filtered total', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    await seedUsers(store);

    expect(await store.bucket('users').count({ tier: 'basic' })).toBe(2);
  });

  it('clear() removes all records', async () => {
    store = await Store.start();
    await store.defineBucket('users', usersDef);
    await seedUsers(store);

    await store.bucket('users').clear();
    expect(await store.bucket('users').count()).toBe(0);
  });
});
