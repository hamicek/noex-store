# Event System

Your store is humming along — records are inserted, updated, deleted. But nothing outside the bucket knows about it. A dashboard can't refresh when new data arrives. An audit trail has to poll for changes. A cache invalidation layer has to guess what changed. Without events, every consumer of your data is flying blind.

noex-store publishes an event for every mutation. You subscribe to specific events using topic patterns with wildcards, and the store delivers them asynchronously through its actor-based EventBus. No polling, no guessing, no missed changes.

## What You'll Learn

- What events the store publishes and what data each event carries
- How `store.on(pattern, handler)` subscribes to events
- How topic patterns and wildcards let you filter events precisely
- How to unsubscribe when you no longer need events
- How events flow from a bucket mutation to your handler
- How event timing differs between single operations and transactions

## Setup

All examples in this chapter use the following store:

```typescript
import { Store } from '@hamicek/noex-store';
import type {
  BucketEvent,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
} from '@hamicek/noex-store';

const store = await Store.start({ name: 'events-demo' });

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
    status: { type: 'string', enum: ['pending', 'paid', 'shipped', 'cancelled'], default: 'pending' },
  },
  indexes: ['userId', 'status'],
});

const users = store.bucket('users');
const orders = store.bucket('orders');
```

## Three Event Types

Every mutation in a bucket produces exactly one event. There are three types:

### `BucketInsertedEvent`

Published when a new record is created with `insert()`:

```typescript
interface BucketInsertedEvent {
  readonly type: 'inserted';
  readonly bucket: string;      // Name of the bucket
  readonly key: unknown;        // Primary key of the new record
  readonly record: StoreRecord; // The complete record with metadata
}
```

### `BucketUpdatedEvent`

Published when an existing record is modified with `update()`:

```typescript
interface BucketUpdatedEvent {
  readonly type: 'updated';
  readonly bucket: string;
  readonly key: unknown;
  readonly oldRecord: StoreRecord; // State before the update
  readonly newRecord: StoreRecord; // State after the update
}
```

The update event carries both the old and new state, so handlers can compare what changed without querying the bucket.

### `BucketDeletedEvent`

Published when a record is removed with `delete()`:

```typescript
interface BucketDeletedEvent {
  readonly type: 'deleted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord; // The record that was deleted
}
```

The deleted record is included in the event so handlers can act on it after it's gone from the bucket.

### Record Metadata in Events

Every record in an event includes automatic metadata fields:

| Field | Type | Description |
|-------|------|-------------|
| `_version` | `number` | Incremented on each update, starts at 1 |
| `_createdAt` | `number` | Unix millisecond timestamp of creation (immutable) |
| `_updatedAt` | `number` | Unix millisecond timestamp of last update |
| `_expiresAt` | `number?` | Unix millisecond timestamp when the record expires (TTL-enabled buckets) |

## Subscribing with `store.on()`

`store.on(pattern, handler)` registers a handler for events matching a topic pattern. It returns an async unsubscribe function:

```typescript
const unsub = await store.on<BucketInsertedEvent>(
  'bucket.users.inserted',
  (event) => {
    console.log(`New user: ${event.record.name} (${event.key})`);
  },
);

// Insert triggers the handler
await users.insert({ name: 'Alice', email: 'alice@example.com' });
// Console: New user: Alice (some-uuid)

// Stop listening
await unsub();
```

The handler receives two arguments:

| Argument | Type | Description |
|----------|------|-------------|
| `event` | `T` (generic) | The event object matching the pattern |
| `topic` | `string` | The full topic string (e.g., `'bucket.users.inserted'`) |

## Topic Patterns and Wildcards

Events are published to topics following the format `bucket.{bucketName}.{eventType}`. You can subscribe to exact topics or use `*` as a wildcard for any single segment:

| Pattern | Matches |
|---------|---------|
| `bucket.users.inserted` | Only insert events on the `users` bucket |
| `bucket.users.updated` | Only update events on the `users` bucket |
| `bucket.users.deleted` | Only delete events on the `users` bucket |
| `bucket.users.*` | All events (insert, update, delete) on `users` |
| `bucket.*.inserted` | Insert events on all buckets |
| `bucket.*.*` | All events on all buckets |

### Subscribing to All Events on One Bucket

```typescript
await store.on<BucketEvent>('bucket.users.*', (event, topic) => {
  console.log(`[${topic}] type=${event.type} key=${String(event.key)}`);
});

const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
// [bucket.users.inserted] type=inserted key=<uuid>

await users.update(alice.id, { role: 'admin' });
// [bucket.users.updated] type=updated key=<uuid>

await users.delete(alice.id);
// [bucket.users.deleted] type=deleted key=<uuid>
```

### Subscribing to One Event Type Across All Buckets

```typescript
await store.on<BucketInsertedEvent>('bucket.*.inserted', (event) => {
  console.log(`New record in ${event.bucket}: key=${String(event.key)}`);
});

await users.insert({ name: 'Bob', email: 'bob@example.com' });
// New record in users: key=<uuid>

await orders.insert({ userId: 'bob-id', total: 99.99 });
// New record in orders: key=1
```

### Global Listener — Everything

```typescript
await store.on<BucketEvent>('bucket.*.*', (event) => {
  console.log(`${event.bucket}.${event.type}`);
});
```

This catches every mutation in the store. Use it for cross-cutting concerns like logging or persistence.

## Discriminating Event Types

The `type` field is a string literal, so TypeScript narrows the union correctly:

```typescript
await store.on<BucketEvent>('bucket.users.*', (event) => {
  switch (event.type) {
    case 'inserted':
      // TypeScript knows: event is BucketInsertedEvent
      console.log('Created:', event.record.name);
      break;

    case 'updated':
      // TypeScript knows: event is BucketUpdatedEvent
      console.log('Changed:', event.oldRecord.name, '->', event.newRecord.name);
      break;

    case 'deleted':
      // TypeScript knows: event is BucketDeletedEvent
      console.log('Removed:', event.record.name);
      break;
  }
});
```

## Unsubscribing

Every `store.on()` call returns a cleanup function. Call it to stop receiving events:

```typescript
const events: BucketEvent[] = [];

const unsub = await store.on<BucketEvent>('bucket.users.*', (event) => {
  events.push(event);
});

await users.insert({ name: 'First', email: 'first@example.com' });
console.log(events.length); // 1

// Stop listening
await unsub();

await users.insert({ name: 'Second', email: 'second@example.com' });
console.log(events.length); // 1 — handler no longer called
```

Always unsubscribe when the listener's lifetime ends. Forgetting to unsubscribe creates a memory leak — the EventBus holds a reference to your handler indefinitely.

## How Events Flow Through the System

When you call `insert()`, `update()`, or `delete()`, the event is published after the operation succeeds inside the BucketServer:

```text
  users.insert({ name: 'Alice', email: 'alice@example.com' })
      |
      v
  BucketHandle                  BucketServer (GenServer)
  +------------+   call()     +---------------------------------+
  | insert()   | -----------> | handle_call('insert', data)     |
  |            |              |                                 |
  |            |              |  1. Validate against schema     |
  |            |              |  2. Generate key + metadata     |
  |            |              |  3. Update indexes              |
  |            |              |  4. Store in memory             |
  |            |              |  5. Publish event:              |
  |            |              |     topic: bucket.users.inserted |
  |            |              |     payload: { type, bucket,    |
  |            |              |       key, record }             |
  |            | <----------- |  6. Reply with record           |
  +------------+   reply      +---------------------------------+
      |
      v                       EventBus
  Caller gets                 +---------------------------+
  the record                  | Deliver to all matching   |
                              | subscribers:              |
                              |   bucket.users.inserted   |
                              |   bucket.users.*          |
                              |   bucket.*.inserted       |
                              |   bucket.*.*              |
                              +---------------------------+
```

Events are published synchronously inside the GenServer, but delivered to handlers asynchronously. This means:

1. The mutation is always committed before any handler runs
2. Handlers run outside the GenServer's message loop and cannot block future operations
3. Handler execution order among multiple subscribers is not guaranteed

## Events in Transactions

When mutations happen inside a transaction, events are deferred until all bucket commits succeed:

```typescript
await store.on<BucketEvent>('bucket.*.*', (event) => {
  console.log(`${event.bucket}.${event.type}`);
});

await store.transaction(async (tx) => {
  const txUsers = await tx.bucket('users');
  const txOrders = await tx.bucket('orders');

  const user = await txUsers.insert({ name: 'Carol', email: 'carol@example.com' });
  await txOrders.insert({ userId: user.id, total: 250 });

  // No events published yet — still inside the transaction
});

// After commit, both events are published:
// users.inserted
// orders.inserted
```

If the transaction fails and rolls back, no events are published at all. This guarantees that handlers never see partial or invalid state.

```text
  Transaction
  +-----------------------------------------------+
  |                                                 |
  |  1. Insert user   -> buffered, no event yet    |
  |  2. Insert order  -> buffered, no event yet    |
  |                                                 |
  |  Commit:                                        |
  |    Apply user insert   -> success              |
  |    Apply order insert  -> success              |
  |                                                 |
  |  All succeeded -> publish ALL events           |
  |                                                 |
  +-----------------------------------------------+
      |
      v
  EventBus receives:
    bucket.users.inserted
    bucket.orders.inserted
```

## Multiple Subscribers

You can register multiple handlers for the same pattern. Each receives its own copy of the event:

```typescript
// Handler 1: logging
await store.on<BucketEvent>('bucket.users.*', (event) => {
  console.log(`[LOG] ${event.type} on ${event.bucket}`);
});

// Handler 2: metrics
await store.on<BucketEvent>('bucket.users.*', (event) => {
  console.log(`[METRIC] user_${event.type}_total++`);
});

await users.insert({ name: 'Dave', email: 'dave@example.com' });
// [LOG] inserted on users
// [METRIC] user_inserted_total++
```

## Complete Working Example

A notification service that watches for user changes and order updates:

```typescript
import { Store } from '@hamicek/noex-store';
import type {
  BucketEvent,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
} from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'event-system-demo' });

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

  // --- Subscribe to events ---

  // 1. Log all user mutations
  const unsubUsers = await store.on<BucketEvent>('bucket.users.*', (event, topic) => {
    console.log(`[users] ${event.type} — topic: ${topic}`);
  });

  // 2. React to specific order events
  const unsubOrderInsert = await store.on<BucketInsertedEvent>(
    'bucket.orders.inserted',
    (event) => {
      console.log(`[orders] New order #${event.key} — total: $${event.record.total}`);
    },
  );

  const unsubOrderUpdate = await store.on<BucketUpdatedEvent>(
    'bucket.orders.updated',
    (event) => {
      const { oldRecord, newRecord } = event;
      if (oldRecord.status !== newRecord.status) {
        console.log(
          `[orders] Order #${event.key} status: ${oldRecord.status} -> ${newRecord.status}`,
        );
      }
    },
  );

  // 3. Global listener for metrics
  let mutationCount = 0;
  const unsubGlobal = await store.on<BucketEvent>('bucket.*.*', () => {
    mutationCount++;
  });

  // --- Perform operations ---

  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  // [users] inserted — topic: bucket.users.inserted

  await users.update(alice.id, { name: 'Alice Smith' });
  // [users] updated — topic: bucket.users.updated

  const order = await ordersBucket.insert({ userId: alice.id, total: 150 });
  // [orders] New order #1 — total: $150

  await ordersBucket.update(order.id, { status: 'paid' });
  // [orders] Order #1 status: pending -> paid

  await ordersBucket.update(order.id, { status: 'shipped' });
  // [orders] Order #1 status: paid -> shipped

  console.log(`\nTotal mutations: ${mutationCount}`); // 5

  // --- Cleanup ---
  await unsubUsers();
  await unsubOrderInsert();
  await unsubOrderUpdate();
  await unsubGlobal();

  await store.stop();
}

main();
```

## Exercise

Given the following store setup:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('products', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true },
    price:    { type: 'number', required: true, min: 0 },
    category: { type: 'string', enum: ['electronics', 'clothing', 'food'] },
    active:   { type: 'boolean', default: true },
  },
});

const products = store.bucket('products');
```

Write code that:

1. Subscribes to all events on the `products` bucket and collects them into an array
2. Subscribes only to `deleted` events and logs the name of each deleted product
3. Inserts two products, updates one's price, and deletes the other
4. After all operations, logs the total number of collected events and their types
5. Unsubscribes both handlers

<details>
<summary>Solution</summary>

```typescript
import type { BucketEvent, BucketDeletedEvent } from '@hamicek/noex-store';

// 1. Collect all product events
const events: BucketEvent[] = [];
const unsubAll = await store.on<BucketEvent>('bucket.products.*', (event) => {
  events.push(event);
});

// 2. Log deleted product names
const unsubDeleted = await store.on<BucketDeletedEvent>(
  'bucket.products.deleted',
  (event) => {
    console.log(`Deleted product: ${event.record.name}`);
  },
);

// 3. Perform operations
const laptop = await products.insert({ name: 'Laptop', price: 999, category: 'electronics' });
const shirt = await products.insert({ name: 'T-Shirt', price: 25, category: 'clothing' });

await products.update(laptop.id, { price: 899 });
await products.delete(shirt.id);
// Console: Deleted product: T-Shirt

// Wait for async event delivery
await new Promise((resolve) => setTimeout(resolve, 50));

// 4. Log results
console.log(`Total events: ${events.length}`); // 4
console.log(`Types: ${events.map((e) => e.type).join(', ')}`);
// Types: inserted, inserted, updated, deleted

// 5. Unsubscribe
await unsubAll();
await unsubDeleted();
```

</details>

## Summary

- The store publishes three event types: **`inserted`**, **`updated`**, and **`deleted`** — one per mutation
- **`BucketInsertedEvent`** carries the new record; **`BucketUpdatedEvent`** carries both old and new; **`BucketDeletedEvent`** carries the removed record
- **`store.on(pattern, handler)`** subscribes to events matching a topic pattern and returns an async unsubscribe function
- Topics follow the format **`bucket.{name}.{type}`** — use `*` as a wildcard to match any segment
- **`bucket.users.*`** catches all events on one bucket; **`bucket.*.inserted`** catches one event type across all buckets; **`bucket.*.*`** catches everything
- Events are published after the mutation succeeds — handlers never see uncommitted data
- In transactions, events are deferred until all commits succeed — a failed transaction publishes nothing
- Multiple handlers can subscribe to the same pattern independently
- Always call the unsubscribe function when a listener's lifetime ends to prevent memory leaks

---

Next: [Event Patterns](./02-event-patterns.md)
