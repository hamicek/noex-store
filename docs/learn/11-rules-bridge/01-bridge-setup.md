# Bridge Setup

Your store tracks inventory levels, user actions, and order statuses. A separate rule engine evaluates business logic — "if stock drops below 10, flag for reorder" or "if a user places three orders in a minute, trigger fraud review." But the rule engine doesn't know when data changes. You could poll the store, but that's wasteful and introduces latency. You could duplicate the event wiring manually, but that ties you to specific topic formats and breaks when buckets change.

`bridgeStoreToRules()` solves this by subscribing to all bucket events and forwarding them to any system that implements a single `emit()` method. One function call, automatic cleanup, and full control over filtering and transformation. The bridge is intentionally one-way — store events flow out to the receiver — keeping the store's internal event loop isolated from downstream failures.

## What You'll Learn

- What the `EventReceiver` interface requires and why it's minimal
- How `bridgeStoreToRules()` subscribes to bucket events and forwards them
- How to filter events so only relevant mutations reach the receiver
- How to transform topics and event data before forwarding
- How the bridge handles receiver errors without affecting the store
- How to tear down the bridge cleanly with the returned unsubscribe function

## The EventReceiver Interface

The bridge doesn't depend on `@hamicek/noex-rules` directly. Instead, it targets a minimal interface:

```typescript
interface EventReceiver {
  emit(topic: string, data: Record<string, unknown>): Promise<unknown>;
}
```

Any object with an `emit` method that accepts a topic string and a data object qualifies. This means the bridge works with:

- A `@hamicek/noex-rules` RuleEngine (the primary use case)
- A custom logger or analytics pipeline
- A message queue adapter
- A test double

| Property | Type | Description |
|----------|------|-------------|
| `emit` | `(topic: string, data: Record<string, unknown>) => Promise<unknown>` | Receives forwarded events. Return value is ignored. |

The return type is `Promise<unknown>` — the bridge awaits nothing. It calls `emit` fire-and-forget, catching and swallowing any rejection. This is a deliberate design choice: a failing receiver must never block or crash the store's EventBus.

## How the Bridge Works

`bridgeStoreToRules()` takes a store, a receiver, and optional configuration. It subscribes to `bucket.*.*` — every mutation on every bucket — and forwards matching events to the receiver:

```text
  Store (EventBus)                    bridgeStoreToRules()              EventReceiver
  +------------------+               +------------------------+        +----------------+
  |                  |               |                        |        |                |
  | bucket.users.    | ─────────────>| 1. filter(event)?      |        |                |
  |   inserted       |               |    No  → skip          |        |                |
  |                  |               |    Yes → continue       |        |                |
  | bucket.orders.   | ─────────────>|                        |        |                |
  |   updated        |               | 2. mapTopic(topic)?    |        |                |
  |                  |               |    transform or pass    |        |                |
  | bucket.sessions. | ─────────────>|                        |        |                |
  |   deleted        |               | 3. mapData(event)?     |───────>| emit(topic,    |
  |                  |               |    transform or pass    |        |   data)        |
  +------------------+               |                        |        |                |
                                     | 4. receiver.emit()     |        |                |
                                     |    fire-and-forget     |        +----------------+
                                     +------------------------+
                                              |
                                     Returns: unsubscribe()
```

### Step by Step

1. The bridge calls `store.on('bucket.*.*', handler)`, subscribing to all bucket events
2. For each event, it checks the `filter` predicate (if provided). Events that don't pass are silently dropped
3. The topic is optionally transformed by `mapTopic`. Without it, the original topic (e.g., `bucket.users.inserted`) passes through
4. The event data is optionally transformed by `mapData`. Without it, the full `BucketEvent` object is forwarded
5. The bridge calls `receiver.emit(finalTopic, finalData)` and catches any rejection
6. The returned function, when called, unsubscribes from the EventBus — no more forwarding

## BridgeOptions

All three options are optional. Omitting them all forwards every event with its original topic and full event data:

```typescript
interface BridgeOptions {
  readonly filter?: (event: BucketEvent) => boolean;
  readonly mapTopic?: (topic: string, event: BucketEvent) => string;
  readonly mapData?: (event: BucketEvent) => Record<string, unknown>;
}
```

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `filter` | `(event: BucketEvent) => boolean` | All events pass | Return `true` to forward, `false` to skip |
| `mapTopic` | `(topic: string, event: BucketEvent) => string` | Identity (original topic) | Transform the topic string before forwarding |
| `mapData` | `(event: BucketEvent) => Record<string, unknown>` | Full BucketEvent as-is | Transform or reduce the event payload |

## Setup

All examples in this chapter use the following store:

```typescript
import { Store } from '@hamicek/noex-store';
import { bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BridgeOptions } from '@hamicek/noex-store';
import type { BucketEvent } from '@hamicek/noex-store';

const store = await Store.start({ name: 'bridge-demo' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', required: true, format: 'email' },
    role:  { type: 'string', enum: ['admin', 'editor', 'viewer'], default: 'viewer' },
  },
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:     { type: 'number', generated: 'autoincrement' },
    userId: { type: 'string', required: true },
    total:  { type: 'number', required: true, min: 0 },
    status: { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
  },
  indexes: ['userId', 'status'],
});

const users = store.bucket('users');
const orders = store.bucket('orders');
```

## Basic Bridge — Forward Everything

The simplest usage forwards all events with no transformation:

```typescript
// A minimal receiver that logs events
const receiver: EventReceiver = {
  async emit(topic, data) {
    console.log(`[rules] ${topic}`, data);
  },
};

const unbridge = await bridgeStoreToRules(store, receiver);

await users.insert({ name: 'Alice', email: 'alice@example.com' });
// [rules] bucket.users.inserted { type: 'inserted', bucket: 'users', key: '...', record: {...} }

await orders.insert({ userId: 'alice-id', total: 99 });
// [rules] bucket.orders.inserted { type: 'inserted', bucket: 'orders', key: 1, record: {...} }

// Stop forwarding
await unbridge();
```

After calling `unbridge()`, no further events reach the receiver. The store continues operating normally.

## Filtering Events

Use `filter` to forward only specific events. The filter receives the full `BucketEvent` and returns `true` to forward or `false` to skip.

### Filter by Bucket

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.bucket === 'orders',
});

await users.insert({ name: 'Bob', email: 'bob@example.com' });
// Nothing forwarded — users bucket is filtered out

await orders.insert({ userId: 'bob-id', total: 200 });
// [rules] bucket.orders.inserted { ... }
```

### Filter by Event Type

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.type === 'inserted' || event.type === 'deleted',
});

const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
// Forwarded — inserted

await users.update(alice.id, { role: 'admin' });
// NOT forwarded — updates are filtered out

await users.delete(alice.id);
// Forwarded — deleted
```

### Combine Conditions

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) =>
    event.bucket === 'orders' && event.type === 'updated',
});
// Only forwards order updates — useful for tracking status changes
```

## Transforming Topics

Use `mapTopic` to change how the receiver sees topics. This is useful when the receiver expects a different naming convention:

```typescript
// Convert dot-separated topics to colon-separated
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (topic) => topic.replace(/\./g, ':'),
});

await users.insert({ name: 'Alice', email: 'alice@example.com' });
// receiver.emit('bucket:users:inserted', ...)
```

### Prefix for Multi-Store Environments

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (topic) => `store.primary.${topic}`,
});

// Topic becomes: store.primary.bucket.users.inserted
```

### Simplify Topics

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (_topic, event) => `${event.bucket}.${event.type}`,
});

// Topic becomes: users.inserted (drops the 'bucket.' prefix)
```

## Transforming Event Data

Use `mapData` to reshape the payload before forwarding. This is useful for stripping internal metadata, extracting specific fields, or adapting to the receiver's expected schema.

### Extract Only Key Fields

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapData: (event) => ({
    type: event.type,
    bucket: event.bucket,
    key: event.key as string,
  }),
});

await users.insert({ name: 'Alice', email: 'alice@example.com' });
// receiver.emit('bucket.users.inserted', { type: 'inserted', bucket: 'users', key: 'abc-123' })
// No record data — just the mutation type and key
```

### Forward Record Data Without Metadata

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapData: (event) => {
    if (event.type === 'updated') {
      const { _version, _createdAt, _updatedAt, ...newData } = event.newRecord;
      const { _version: _v, _createdAt: _c, _updatedAt: _u, ...oldData } = event.oldRecord;
      return { type: event.type, bucket: event.bucket, oldData, newData };
    }

    const record = event.type === 'inserted' ? event.record : event.record;
    const { _version, _createdAt, _updatedAt, ...data } = record;
    return { type: event.type, bucket: event.bucket, data };
  },
});
```

## Combining All Three Options

Filter, mapTopic, and mapData work together. The pipeline is: filter first, then mapTopic, then mapData:

```text
  BucketEvent arrives
        │
        ├── filter(event) → false? → SKIP
        │
        ├── filter(event) → true (or no filter)
        │
        ├── mapTopic(topic, event) → finalTopic
        │
        ├── mapData(event) → finalData
        │
        └── receiver.emit(finalTopic, finalData)
```

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  // Only forward order mutations
  filter: (event) => event.bucket === 'orders',

  // Use simplified topic format
  mapTopic: (_topic, event) => `order.${event.type}`,

  // Send only business-relevant data
  mapData: (event) => ({
    orderId: event.key as number,
    type: event.type,
    ...(event.type === 'updated'
      ? { status: event.newRecord.status, total: event.newRecord.total }
      : event.type === 'inserted'
        ? { status: event.record.status, total: event.record.total }
        : { status: event.record.status }),
  }),
});

await orders.insert({ userId: 'alice-id', total: 150 });
// receiver.emit('order.inserted', { orderId: 1, type: 'inserted', status: 'pending', total: 150 })
```

## Error Resilience

The bridge uses fire-and-forget semantics. If the receiver throws or rejects, the error is caught and swallowed:

```typescript
const flakyReceiver: EventReceiver = {
  async emit() {
    throw new Error('Network timeout');
  },
};

const unbridge = await bridgeStoreToRules(store, flakyReceiver);

// This insert succeeds normally — the receiver's error doesn't propagate
const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
console.log(alice.name); // 'Alice'

// The store's EventBus, reactive queries, and persistence are unaffected
```

This is critical for production reliability. A slow or failing rule engine must never degrade the store's write performance or block its internal event processing.

## Teardown

The function returned by `bridgeStoreToRules()` unsubscribes from the EventBus:

```typescript
const unbridge = await bridgeStoreToRules(store, receiver);

// Events are forwarded...
await users.insert({ name: 'Alice', email: 'alice@example.com' });
// receiver.emit called

// Tear down the bridge
await unbridge();

// Events are no longer forwarded
await users.insert({ name: 'Bob', email: 'bob@example.com' });
// receiver.emit NOT called
```

Call `unbridge()` during application shutdown, when reconnecting to a different receiver, or when the bridge is no longer needed. The store continues operating normally after teardown.

## Complete Working Example

A bridge that forwards order status changes to a mock rule engine, with filtering, topic transformation, and clean shutdown:

```typescript
import { Store, bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'bridge-example' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true, format: 'email' },
    },
  });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:     { type: 'number', generated: 'autoincrement' },
      userId: { type: 'string', required: true },
      total:  { type: 'number', required: true, min: 0 },
      status: { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
    },
    indexes: ['userId', 'status'],
  });

  const users = store.bucket('users');
  const ordersBucket = store.bucket('orders');

  // Mock rule engine that collects received events
  const received: Array<{ topic: string; data: Record<string, unknown> }> = [];
  const ruleEngine: EventReceiver = {
    async emit(topic, data) {
      received.push({ topic, data });
    },
  };

  // Bridge only order events, with simplified topics and minimal data
  const unbridge = await bridgeStoreToRules(store, ruleEngine, {
    filter: (event) => event.bucket === 'orders',
    mapTopic: (_topic, event) => `order.${event.type}`,
    mapData: (event) => ({
      orderId: event.key as number,
      type: event.type,
    }),
  });

  // These user events are filtered out — rule engine doesn't see them
  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  const bob = await users.insert({ name: 'Bob', email: 'bob@example.com' });

  // These order events pass through the bridge
  const order1 = await ordersBucket.insert({ userId: alice.id as string, total: 100 });
  const order2 = await ordersBucket.insert({ userId: bob.id as string, total: 250 });
  await ordersBucket.update(order1.id, { status: 'paid' });
  await ordersBucket.update(order2.id, { status: 'paid' });
  await ordersBucket.update(order2.id, { status: 'shipped' });

  // Wait for async event delivery
  await new Promise((resolve) => setTimeout(resolve, 50));

  console.log(`Events received by rule engine: ${received.length}`);
  // Events received by rule engine: 5

  for (const { topic, data } of received) {
    console.log(`  ${topic} — orderId: ${data.orderId}`);
  }
  // order.inserted — orderId: 1
  // order.inserted — orderId: 2
  // order.updated — orderId: 1
  // order.updated — orderId: 2
  // order.updated — orderId: 2

  // Clean shutdown
  await unbridge();
  await store.stop();
}

main();
```

## Exercise

You're building a notification system. The store has `users` and `tickets` buckets. A rule engine should receive events only when:

- A new ticket is created (inserted)
- A ticket's `priority` changes from any value to `'critical'`

The rule engine expects topics in the format `notifications:{eventType}` and data containing only `{ ticketId, userId, priority }`.

Given this setup:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

await store.defineBucket('tickets', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    userId:   { type: 'string', required: true },
    title:    { type: 'string', required: true },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  },
});

const ruleEngine: EventReceiver = {
  async emit(topic, data) {
    console.log(`[rule] ${topic}`, data);
  },
};
```

1. Write a `filter` function that passes only ticket inserts and updates where priority changed to `'critical'`
2. Write a `mapTopic` function that produces `notifications:created` or `notifications:escalated`
3. Write a `mapData` function that returns `{ ticketId, userId, priority }`
4. Call `bridgeStoreToRules` with all three options
5. Test by inserting a ticket, updating it to `'critical'`, and updating a user (should be filtered out)

<details>
<summary>Solution</summary>

```typescript
import { bridgeStoreToRules } from '@hamicek/noex-store';
import type { BucketEvent } from '@hamicek/noex-store';

const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  filter: (event: BucketEvent) => {
    if (event.bucket !== 'tickets') return false;
    if (event.type === 'inserted') return true;
    if (event.type === 'updated') {
      return event.newRecord.priority === 'critical'
        && event.oldRecord.priority !== 'critical';
    }
    return false;
  },

  mapTopic: (_topic, event) => {
    const action = event.type === 'inserted' ? 'created' : 'escalated';
    return `notifications:${action}`;
  },

  mapData: (event) => {
    const record = event.type === 'updated' ? event.newRecord : event.record;
    return {
      ticketId: event.key as number,
      userId: record.userId as string,
      priority: record.priority as string,
    };
  },
});

const ticketsBucket = store.bucket('tickets');
const usersBucket = store.bucket('users');

// Insert a ticket — passes filter (inserted + tickets bucket)
await ticketsBucket.insert({ userId: 'user-1', title: 'Login broken', priority: 'medium' });
// [rule] notifications:created { ticketId: 1, userId: 'user-1', priority: 'medium' }

// Update to critical — passes filter (priority changed to critical)
await ticketsBucket.update(1, { priority: 'critical' });
// [rule] notifications:escalated { ticketId: 1, userId: 'user-1', priority: 'critical' }

// Update to high — does NOT pass filter (priority is not critical)
await ticketsBucket.update(1, { priority: 'high' });
// Nothing — filtered out

// Insert a user — does NOT pass filter (wrong bucket)
await usersBucket.insert({ name: 'Alice' });
// Nothing — filtered out

await unbridge();
```

The filter uses discriminated union narrowing: when `event.type === 'updated'`, TypeScript knows the event has `oldRecord` and `newRecord`. The `mapTopic` function maps `inserted` to `created` and `updated` to `escalated`. The `mapData` function picks the right record (`newRecord` for updates, `record` for inserts) and extracts only the fields the rule engine needs.

</details>

## Summary

- **`EventReceiver`** is a minimal interface with a single `emit(topic, data)` method — no dependency on `@hamicek/noex-rules`
- **`bridgeStoreToRules(store, receiver, options?)`** subscribes to `bucket.*.*` and forwards matching events to the receiver
- The bridge returns an **async teardown function** that unsubscribes from the EventBus when called
- **`filter`** controls which events reach the receiver — return `true` to forward, `false` to skip
- **`mapTopic`** transforms the topic string before forwarding — useful for adapting to the receiver's naming convention
- **`mapData`** transforms or reduces the event payload — strip metadata, extract fields, or reshape for the receiver's schema
- The processing pipeline is: **filter** (skip or continue) → **mapTopic** (transform topic) → **mapData** (transform data) → **emit**
- Receiver errors are **caught and swallowed** — a failing or slow receiver never blocks or crashes the store's EventBus
- The bridge is **one-way**: store events flow to the receiver, but the receiver cannot push events back through the bridge

## API Reference

- [Rules Bridge](../../reference/bridge.md) — `bridgeStoreToRules()`, `BridgeOptions`, `EventReceiver`

---

Next: [Store-Driven Rules](./02-store-driven-rules.md)
