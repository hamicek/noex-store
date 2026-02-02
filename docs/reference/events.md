# Event System API Reference

> Subscribe to real-time data change notifications with wildcard pattern matching across all buckets.

## Overview

The event system notifies your code whenever records are inserted, updated, or deleted in any bucket. You register event handlers with `store.on()` using dot-delimited topic patterns that support `*` wildcards. Each handler receives the event payload and the matched topic string, and can be removed at any time by calling the returned unsubscribe function.

Events are published synchronously after each mutation but delivered asynchronously to handlers — the original operation completes before any handler runs. For transactions, events are deferred and published only after all buckets commit successfully.

## API

### `store.on(pattern, handler): Promise<() => Promise<void>>`

Registers an event handler for bucket events matching the given pattern.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pattern` | `string` | — | Dot-delimited topic pattern (supports `*` wildcards) |
| `handler` | `(event: T, topic: string) => void` | — | Callback receiving the event payload and the full topic string |

**Type Parameter:** `T` defaults to `BucketEvent`. Narrow it to a specific event type for type-safe access to event-specific fields.

**Returns:** `Promise<() => Promise<void>>` — an async unsubscribe function

**Example:**

```typescript
import type { BucketInsertedEvent, BucketEvent } from '@hamicek/noex-store';

// Typed handler — only insert events on a specific bucket
const unsub = await store.on<BucketInsertedEvent>(
  'bucket.users.inserted',
  (event, topic) => {
    console.log(`New user: ${event.record.name}`);
    // topic === 'bucket.users.inserted'
  },
);

// Broad handler — all events on all buckets
await store.on<BucketEvent>('bucket.*.*', (event, topic) => {
  console.log(`${event.type} in ${event.bucket}`);
});

// Stop listening
await unsub();
```

---

## Topic Format

Every bucket event is published to a topic with the format:

```
bucket.<bucketName>.<eventType>
```

Where `<eventType>` is one of `inserted`, `updated`, or `deleted`.

**Examples:**

| Topic | Meaning |
|-------|---------|
| `bucket.users.inserted` | A record was inserted into the `users` bucket |
| `bucket.orders.updated` | A record was updated in the `orders` bucket |
| `bucket.sessions.deleted` | A record was deleted from the `sessions` bucket |

---

## Wildcard Patterns

The `*` wildcard matches exactly one segment between dots. There is no recursive `**` wildcard. Matching is literal and case-sensitive.

| Pattern | Matches | Example topics |
|---------|---------|----------------|
| `bucket.users.inserted` | Only inserts in `users` | `bucket.users.inserted` |
| `bucket.users.*` | All events in `users` | `bucket.users.inserted`, `bucket.users.updated`, `bucket.users.deleted` |
| `bucket.*.inserted` | All inserts across all buckets | `bucket.users.inserted`, `bucket.orders.inserted` |
| `bucket.*.*` | All bucket events | Any `bucket.<name>.<type>` topic |

**Rules:**

- Each `*` matches exactly one segment (delimited by `.`)
- A topic has exactly three segments: `bucket`, the bucket name, and the event type
- Literal segments must match exactly (case-sensitive)

---

## Event Types

### `BucketInsertedEvent`

Published when a new record is inserted into a bucket.

```typescript
interface BucketInsertedEvent {
  readonly type: 'inserted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'inserted'` | Discriminant — always `'inserted'` |
| `bucket` | `string` | Name of the bucket |
| `key` | `unknown` | Primary key of the inserted record |
| `record` | `StoreRecord` | The full inserted record (including generated fields and metadata) |

---

### `BucketUpdatedEvent`

Published when an existing record is updated.

```typescript
interface BucketUpdatedEvent {
  readonly type: 'updated';
  readonly bucket: string;
  readonly key: unknown;
  readonly oldRecord: StoreRecord;
  readonly newRecord: StoreRecord;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'updated'` | Discriminant — always `'updated'` |
| `bucket` | `string` | Name of the bucket |
| `key` | `unknown` | Primary key of the updated record |
| `oldRecord` | `StoreRecord` | The record before the update |
| `newRecord` | `StoreRecord` | The record after the update |

**Note:** `oldRecord` and `newRecord` include metadata fields. Compare `_version` to see how many updates occurred, or compare individual fields to detect what changed.

---

### `BucketDeletedEvent`

Published when a record is deleted — either explicitly, by TTL expiration, or by `maxSize` eviction.

```typescript
interface BucketDeletedEvent {
  readonly type: 'deleted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'deleted'` | Discriminant — always `'deleted'` |
| `bucket` | `string` | Name of the bucket |
| `key` | `unknown` | Primary key of the deleted record |
| `record` | `StoreRecord` | The record that was deleted (snapshot at time of deletion) |

---

### `BucketEvent`

Union of all event types. Use as the type parameter when you want to handle all events generically.

```typescript
type BucketEvent = BucketInsertedEvent | BucketUpdatedEvent | BucketDeletedEvent;
```

Discriminate on the `type` field:

```typescript
await store.on<BucketEvent>('bucket.*.*', (event) => {
  switch (event.type) {
    case 'inserted':
      console.log('New record:', event.record);
      break;
    case 'updated':
      console.log('Changed:', event.oldRecord, '→', event.newRecord);
      break;
    case 'deleted':
      console.log('Removed:', event.record);
      break;
  }
});
```

---

### `BucketEventType`

String literal union of event type discriminants.

```typescript
type BucketEventType = 'inserted' | 'updated' | 'deleted';
```

---

## Event Emission

### Single Operations

For individual `insert`, `update`, and `delete` calls on a `BucketHandle`, the event is published synchronously after the mutation is applied to the store. The handler runs asynchronously — the mutation returns to the caller before any handler executes.

```typescript
const users = store.bucket('users');

await store.on<BucketInsertedEvent>('bucket.users.inserted', (event) => {
  // This runs after insert() has already returned
  console.log('Inserted:', event.record.name);
});

const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
// alice is already available here — the handler runs asynchronously
```

### Transaction Events

Inside a transaction, no events are published. Events are collected during the commit phase and published only after **all** buckets have committed successfully.

```typescript
const events: BucketEvent[] = [];
await store.on<BucketEvent>('bucket.*.*', (event) => {
  events.push(event);
});

await store.transaction(async (tx) => {
  const customers = await tx.bucket('customers');
  const orders = await tx.bucket('orders');

  await customers.insert({ name: 'Jan', email: 'jan@example.com' });
  await orders.insert({ customerId: 'c1', amount: 100, items: ['widget'] });
  // events.length === 0 — no events published yet
});

// After commit completes, both events are published
```

If a transaction is rolled back (the callback throws or a commit conflict occurs), **no events are published**.

### TTL Expiration

When records expire due to TTL, a `deleted` event is published for each expired record. These events are identical to manual delete events — the `type` field is `'deleted'` and the `record` field contains the expired record.

### MaxSize Eviction

When a bucket reaches its `maxSize` limit and evicts the oldest records, a `deleted` event is published for each evicted record.

---

## Event Delivery

### Ordering

- **Single operations:** Each mutation publishes exactly one event. Events from sequential operations are published in the order the operations complete.
- **Transactions:** Events are published in the order they were collected during commit — bucket by bucket, operation by operation within each bucket.
- **Multiple subscribers:** Subscriber invocation order is not guaranteed. Do not rely on one subscriber executing before another.

### Error Isolation

Handler errors are isolated from the operation that triggered the event and from other handlers:

- A handler throwing an error does **not** roll back or affect the original mutation.
- A handler throwing an error does **not** prevent other handlers from receiving the event.
- Handler errors should be caught and logged within the handler.

```typescript
await store.on<BucketEvent>('bucket.*.*', async (event) => {
  try {
    await auditLog.insert({
      action: event.type,
      bucket: event.bucket,
      key: event.key,
    });
  } catch (err) {
    console.error('Audit log failed:', err);
    // The original operation already succeeded — log and continue
  }
});
```

---

## Unsubscribe

The function returned by `store.on()` removes the handler from the event bus. It is asynchronous and should be awaited.

```typescript
const unsub = await store.on('bucket.users.*', (event) => {
  console.log(event.type);
});

// Later: remove the handler
await unsub();
```

Forgetting to unsubscribe creates a memory leak — handlers are held by the event bus indefinitely until `store.stop()` is called.

---

## Common Patterns

### Audit Logging

```typescript
const auditLog = store.bucket('auditLog');

await store.on<BucketEvent>('bucket.*.*', async (event) => {
  if (event.bucket === 'auditLog') return; // prevent infinite recursion

  await auditLog.insert({
    action: event.type,
    bucket: event.bucket,
    key: String(event.key),
    timestamp: Date.now(),
  });
});
```

### Change Detection

```typescript
await store.on<BucketUpdatedEvent>('bucket.products.updated', (event) => {
  if (event.oldRecord.price !== event.newRecord.price) {
    console.log(
      `Price changed: ${event.oldRecord.price} → ${event.newRecord.price}`,
    );
  }
});
```

### Cascading Deletes

```typescript
await store.on<BucketDeletedEvent>('bucket.customers.deleted', async (event) => {
  const orders = store.bucket('orders');
  const customerOrders = await orders.where({ customerId: event.key });
  for (const order of customerOrders) {
    await orders.delete(order.id);
  }
});
```

> **Warning:** Cascading deletes produce additional `deleted` events. Guard against infinite recursion when handlers write back to buckets that trigger the same handler.

---

## Reactive Query Integration

The store internally subscribes to `bucket.*.*` to drive reactive query re-evaluation. When any bucket event occurs, the query manager checks which subscriptions depend on the affected bucket and key, and schedules re-evaluation. This is transparent to user code — you do not need to connect events to queries manually.

---

## Types

### Exported Types

All event types are publicly exported from the main package:

```typescript
import type {
  BucketEventType,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
  BucketEvent,
} from '@hamicek/noex-store';
```

### `StoreRecord` Metadata in Events

Every record in an event includes automatic metadata fields:

| Field | Type | Description |
|-------|------|-------------|
| `_version` | `number` | Record version, starts at 1, incremented on each update |
| `_createdAt` | `number` | Unix millisecond timestamp of creation |
| `_updatedAt` | `number` | Unix millisecond timestamp of last modification |
| `_expiresAt` | `number \| undefined` | Unix millisecond timestamp of expiration (TTL-enabled buckets only) |

For `BucketUpdatedEvent`, both `oldRecord` and `newRecord` carry their respective metadata values — compare them to see how the record evolved.

## See Also

- [Store API](./store.md) — `store.on()` method signature and store lifecycle
- [Transactions](./transactions.md) — deferred event emission after atomic commit
- [TTL and Lifecycle](./ttl-lifecycle.md) — TTL expiration and `maxSize` eviction that produce `deleted` events
- [Schema and Types](./schema.md) — `StoreRecord` structure and metadata fields
- [Rules Bridge](./bridge.md) — forwarding store events to noex-rules
- [Errors](./errors.md) — complete error catalog
- **Learn:** [Event System](../learn/06-events/01-event-system.md) — conceptual introduction to events
- **Learn:** [Event Patterns](../learn/06-events/02-event-patterns.md) — hands-on examples and exercises
- **Source:** [`src/types/events.ts`](../../src/types/events.ts)
- **Source:** [`src/core/bucket-server.ts`](../../src/core/bucket-server.ts)
