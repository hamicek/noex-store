import { describe, it, expect, afterEach } from 'vitest';
import { Store } from '../../src/core/store.js';
import { bridgeStoreToRules, type EventReceiver } from '../../src/bridge/rules-bridge.js';
import type { BucketDefinition, BucketEvent } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    tier: { type: 'string', default: 'basic' },
  },
  indexes: ['tier'],
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    product: { type: 'string', required: true },
    amount: { type: 'number', default: 0 },
  },
};

// ── Helpers ──────────────────────────────────────────────────────

interface CapturedEvent {
  readonly topic: string;
  readonly data: Record<string, unknown>;
}

function createCapturingReceiver(): EventReceiver & { readonly events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    async emit(topic: string, data: Record<string, unknown>) {
      events.push({ topic, data });
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

describe('Rules Bridge — integration', () => {
  it('forwards insert event from real store to receiver', async () => {
    store = await Store.start({ name: 'bridge-insert', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver);

    await store.bucket('customers').insert({ name: 'Jan' });
    await store.settle();

    expect(receiver.events).toHaveLength(1);
    expect(receiver.events[0]!.topic).toBe('bucket.customers.inserted');

    const data = receiver.events[0]!.data as Record<string, unknown>;
    expect(data.type).toBe('inserted');
    expect(data.bucket).toBe('customers');
    expect((data.record as Record<string, unknown>).name).toBe('Jan');
  });

  it('forwards update event from real store to receiver', async () => {
    store = await Store.start({ name: 'bridge-update', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const record = await store.bucket('customers').insert({ name: 'Jan' });
    const id = (record as Record<string, unknown>).id;

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver);

    await store.bucket('customers').update(id, { name: 'Eva' });
    await store.settle();

    expect(receiver.events).toHaveLength(1);
    expect(receiver.events[0]!.topic).toBe('bucket.customers.updated');

    const data = receiver.events[0]!.data as Record<string, unknown>;
    expect(data.type).toBe('updated');
    expect((data.oldRecord as Record<string, unknown>).name).toBe('Jan');
    expect((data.newRecord as Record<string, unknown>).name).toBe('Eva');
  });

  it('forwards delete event from real store to receiver', async () => {
    store = await Store.start({ name: 'bridge-delete', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const record = await store.bucket('customers').insert({ name: 'Jan' });
    const id = (record as Record<string, unknown>).id;

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver);

    await store.bucket('customers').delete(id);
    await store.settle();

    expect(receiver.events).toHaveLength(1);
    expect(receiver.events[0]!.topic).toBe('bucket.customers.deleted');

    const data = receiver.events[0]!.data as Record<string, unknown>;
    expect(data.type).toBe('deleted');
    expect((data.record as Record<string, unknown>).name).toBe('Jan');
  });

  it('forwards events from multiple buckets', async () => {
    store = await Store.start({ name: 'bridge-multi', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);
    await store.defineBucket('orders', ordersDef);

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver);

    await store.bucket('customers').insert({ name: 'Jan' });
    await store.bucket('orders').insert({ product: 'Widget', amount: 42 });
    await store.settle();

    expect(receiver.events).toHaveLength(2);

    const topics = receiver.events.map((e) => e.topic);
    expect(topics).toContain('bucket.customers.inserted');
    expect(topics).toContain('bucket.orders.inserted');
  });

  it('filters events — only selected bucket passes through', async () => {
    store = await Store.start({ name: 'bridge-filter', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);
    await store.defineBucket('orders', ordersDef);

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver, {
      filter: (event: BucketEvent) => event.bucket === 'orders',
    });

    await store.bucket('customers').insert({ name: 'Jan' });
    await store.bucket('orders').insert({ product: 'Widget' });
    await store.settle();

    expect(receiver.events).toHaveLength(1);
    expect(receiver.events[0]!.topic).toBe('bucket.orders.inserted');
  });

  it('filters events — only selected event type passes through', async () => {
    store = await Store.start({ name: 'bridge-filter-type', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const record = await store.bucket('customers').insert({ name: 'Jan' });
    const id = (record as Record<string, unknown>).id;

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver, {
      filter: (event: BucketEvent) => event.type === 'deleted',
    });

    await store.bucket('customers').insert({ name: 'Eva' });
    await store.bucket('customers').update(id, { name: 'Petr' });
    await store.bucket('customers').delete(id);
    await store.settle();

    expect(receiver.events).toHaveLength(1);
    expect(receiver.events[0]!.topic).toBe('bucket.customers.deleted');
  });

  it('transforms topics with custom mapTopic', async () => {
    store = await Store.start({ name: 'bridge-map-topic', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver, {
      mapTopic: (topic) => topic.replaceAll('.', ':'),
    });

    await store.bucket('customers').insert({ name: 'Jan' });
    await store.settle();

    expect(receiver.events).toHaveLength(1);
    expect(receiver.events[0]!.topic).toBe('bucket:customers:inserted');
  });

  it('transforms data with custom mapData', async () => {
    store = await Store.start({ name: 'bridge-map-data', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver, {
      mapData: (event) => ({ bucket: event.bucket, eventType: event.type }),
    });

    await store.bucket('customers').insert({ name: 'Jan' });
    await store.settle();

    expect(receiver.events).toHaveLength(1);
    expect(receiver.events[0]!.data).toEqual({ bucket: 'customers', eventType: 'inserted' });
  });

  it('stops forwarding after unbridge is called', async () => {
    store = await Store.start({ name: 'bridge-unsub', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const receiver = createCapturingReceiver();
    const unbridge = await bridgeStoreToRules(store, receiver);

    await store.bucket('customers').insert({ name: 'Jan' });
    await store.settle();

    expect(receiver.events).toHaveLength(1);

    await unbridge();

    await store.bucket('customers').insert({ name: 'Eva' });
    await store.settle();

    // No new events after unbridge
    expect(receiver.events).toHaveLength(1);
  });

  it('receiver error does not affect store operations', async () => {
    store = await Store.start({ name: 'bridge-error', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const failingReceiver: EventReceiver = {
      async emit() {
        throw new Error('receiver failure');
      },
    };

    await bridgeStoreToRules(store, failingReceiver);

    // Store operations should succeed despite receiver errors
    const record = await store.bucket('customers').insert({ name: 'Jan' });
    await store.settle();

    expect(record).toBeDefined();
    expect((record as Record<string, unknown>).name).toBe('Jan');

    // Store is still fully operational
    const all = await store.bucket('customers').all();
    expect(all).toHaveLength(1);
  });

  it('handles rapid sequential mutations', async () => {
    store = await Store.start({ name: 'bridge-rapid', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver);

    const insertCount = 20;
    for (let i = 0; i < insertCount; i++) {
      await store.bucket('customers').insert({ name: `customer-${i}` });
    }
    await store.settle();

    expect(receiver.events).toHaveLength(insertCount);
    for (const event of receiver.events) {
      expect(event.topic).toBe('bucket.customers.inserted');
    }
  });

  it('combines filter, mapTopic, and mapData in a single bridge', async () => {
    store = await Store.start({ name: 'bridge-combined', ttlCheckIntervalMs: 0 });
    await store.defineBucket('customers', customersDef);
    await store.defineBucket('orders', ordersDef);

    const receiver = createCapturingReceiver();
    await bridgeStoreToRules(store, receiver, {
      filter: (event) => event.bucket === 'customers' && event.type === 'inserted',
      mapTopic: (topic) => `store/${topic.replaceAll('.', '/')}`,
      mapData: (event) => ({
        source: event.bucket,
        key: event.key,
      }),
    });

    await store.bucket('customers').insert({ name: 'Jan' });
    await store.bucket('orders').insert({ product: 'Widget' }); // filtered out

    const jan = await store.bucket('customers').insert({ name: 'Eva' });
    const janId = (jan as Record<string, unknown>).id;
    await store.bucket('customers').update(janId, { tier: 'vip' }); // filtered out (not 'inserted')
    await store.settle();

    expect(receiver.events).toHaveLength(2);
    expect(receiver.events[0]!.topic).toBe('store/bucket/customers/inserted');
    expect(receiver.events[0]!.data).toHaveProperty('source', 'customers');
    expect(receiver.events[0]!.data).toHaveProperty('key');
    expect(receiver.events[1]!.topic).toBe('store/bucket/customers/inserted');
  });
});
