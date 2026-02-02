# Rules Bridge API Reference

> Forward store bucket events to an external event receiver with filtering, topic mapping, and data transformation.

## Overview

The rules bridge connects a noex-store instance to any system that implements a single `emit()` method — typically a `@hamicek/noex-rules` RuleEngine, but also loggers, message queues, or custom pipelines. It subscribes to all bucket events via `bucket.*.*`, applies optional filtering and transformation, and forwards matching events using fire-and-forget semantics. Receiver failures never propagate back to the store.

The bridge is intentionally one-directional: store events flow out to the receiver. For the reverse direction (rules writing back to the store), rule action handlers call store methods directly — no special API is needed.

## Import

```typescript
// From the main package
import { bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BridgeOptions } from '@hamicek/noex-store';

// From the dedicated entry point
import { bridgeStoreToRules } from '@hamicek/noex-store/bridge';
import type { EventReceiver, BridgeOptions } from '@hamicek/noex-store/bridge';
```

## API

### `bridgeStoreToRules(store, receiver, options?): Promise<() => Promise<void>>`

Subscribes to all bucket events on the store and forwards matching events to the receiver. Returns an async teardown function that unsubscribes from the event bus.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `store` | `Store` | — | The noex-store instance to bridge events from |
| `receiver` | `EventReceiver` | — | Any object with an `emit(topic, data)` method |
| `options` | `BridgeOptions` | `{}` | Optional filtering and transformation configuration |

**Returns:** `Promise<() => Promise<void>>` — an async teardown function. Calling it stops all event forwarding.

**Example:**

```typescript
import { Store, bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver } from '@hamicek/noex-store';

const store = await Store.start({ name: 'my-app' });

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:    { type: 'number', generated: 'autoincrement' },
    total: { type: 'number', required: true, min: 0 },
  },
});

const receiver: EventReceiver = {
  async emit(topic, data) {
    console.log(topic, data);
  },
};

const unbridge = await bridgeStoreToRules(store, receiver);

await store.bucket('orders').insert({ total: 100 });
// receiver.emit called with topic 'bucket.orders.inserted'

await unbridge();
// No further events are forwarded
```

---

## Event Flow Pipeline

When a bucket mutation occurs, the bridge processes it through this pipeline:

```text
BucketEvent arrives (via store.on('bucket.*.*'))
      │
      ├── filter(event) → false? → SKIP (event is silently dropped)
      │
      ├── filter(event) → true (or no filter defined)
      │
      ├── mapTopic(topic, event) → finalTopic (or original topic if no mapTopic)
      │
      ├── mapData(event) → finalData (or full BucketEvent if no mapData)
      │
      └── receiver.emit(finalTopic, finalData) — fire-and-forget
```

The order is always: **filter** first, then **mapTopic**, then **mapData**, then **emit**. If the filter rejects an event, the mapping functions are never called.

---

## Types

### `EventReceiver`

Minimal interface that the receiver must implement. Avoids a hard dependency on `@hamicek/noex-rules`.

```typescript
interface EventReceiver {
  emit(topic: string, data: Record<string, unknown>): Promise<unknown>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `emit` | `(topic: string, data: Record<string, unknown>) => Promise<unknown>` | Receives forwarded events. The return value is ignored by the bridge. |

Any object satisfying this interface qualifies:

- A `@hamicek/noex-rules` RuleEngine (primary use case)
- A custom logger or analytics pipeline
- A message queue adapter
- A test double

**Example — minimal receiver:**

```typescript
const receiver: EventReceiver = {
  async emit(topic, data) {
    console.log(`[event] ${topic}`, data);
  },
};
```

---

### `BridgeOptions`

All fields are optional. Omitting all options forwards every event with its original topic and the full `BucketEvent` as data.

```typescript
interface BridgeOptions {
  readonly filter?: (event: BucketEvent) => boolean;
  readonly mapTopic?: (topic: string, event: BucketEvent) => string;
  readonly mapData?: (event: BucketEvent) => Record<string, unknown>;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `filter` | `(event: BucketEvent) => boolean` | All events pass | Return `true` to forward the event, `false` to skip it |
| `mapTopic` | `(topic: string, event: BucketEvent) => string` | Identity (original topic) | Transform the topic string before forwarding |
| `mapData` | `(event: BucketEvent) => Record<string, unknown>` | Full `BucketEvent` as-is | Transform or reduce the event payload before forwarding |

---

### `filter`

Controls which events reach the receiver. The function receives the full `BucketEvent` and returns a boolean.

**Example — filter by bucket:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.bucket === 'orders',
});
```

**Example — filter by event type:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.type === 'inserted' || event.type === 'deleted',
});
```

**Example — compound filter:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) =>
    event.bucket === 'orders' && event.type === 'updated',
});
```

---

### `mapTopic`

Transforms the topic string before forwarding. Receives the original topic and the event. If omitted, the original topic (e.g., `bucket.orders.inserted`) passes through unchanged.

**Example — dot to colon separator:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (topic) => topic.replaceAll('.', ':'),
});
// 'bucket.orders.inserted' → 'bucket:orders:inserted'
```

**Example — add prefix:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (topic) => `store.primary.${topic}`,
});
// 'bucket.orders.inserted' → 'store.primary.bucket.orders.inserted'
```

**Example — simplified topic from event data:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (_topic, event) => `${event.bucket}.${event.type}`,
});
// 'bucket.orders.inserted' → 'orders.inserted'
```

---

### `mapData`

Transforms the event payload before forwarding. Receives the full `BucketEvent` and must return a `Record<string, unknown>`. If omitted, the entire `BucketEvent` object is forwarded.

**Example — extract key fields only:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapData: (event) => ({
    bucket: event.bucket,
    eventType: event.type,
    key: event.key as string,
  }),
});
```

**Example — combine all three options:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.bucket === 'orders' && event.type === 'inserted',
  mapTopic: (_topic, event) => `order.${event.type}`,
  mapData: (event) => ({
    orderId: event.key as number,
    type: event.type,
  }),
});
```

---

## Error Handling

The bridge uses fire-and-forget semantics. Calling `receiver.emit()` returns a promise, but the bridge does not await it. Any rejection is caught and silently swallowed:

```typescript
// Internally:
receiver.emit(finalTopic, finalData).catch(() => {});
```

This is a deliberate design choice:

- A failing or slow receiver **never** blocks the store's EventBus
- A failing receiver **never** causes a store mutation to fail
- A failing receiver **never** prevents other event handlers from executing

The store remains fully operational regardless of receiver health.

**Example — resilient to receiver errors:**

```typescript
const flakyReceiver: EventReceiver = {
  async emit() {
    throw new Error('Network timeout');
  },
};

const unbridge = await bridgeStoreToRules(store, flakyReceiver);

// Store operations succeed normally despite receiver errors
const record = await store.bucket('orders').insert({ total: 100 });
console.log(record); // { id: 1, total: 100, ... }
```

---

## Teardown

The function returned by `bridgeStoreToRules()` unsubscribes the bridge handler from the store's EventBus. It is asynchronous and should be awaited.

```typescript
const unbridge = await bridgeStoreToRules(store, receiver);

// Events are forwarded...
await store.bucket('orders').insert({ total: 100 });

// Stop forwarding
await unbridge();

// Events are no longer forwarded
await store.bucket('orders').insert({ total: 200 });
// receiver.emit is NOT called
```

Call `unbridge()` during application shutdown, when reconnecting to a different receiver, or when the bridge is no longer needed. The store continues operating normally after teardown.

Forgetting to call `unbridge()` keeps the handler registered on the event bus. It will be cleaned up when `store.stop()` is called.

---

## Bidirectional Integration

The bridge handles **store → receiver** (one-way). For **receiver → store** (the reverse), action handlers in the rule engine call store methods directly:

```text
┌───────────┐   bridge (events)    ┌──────────────┐
│           │ ──────────────────── │              │
│   Store   │                      │ Rule Engine  │
│           │ ◄────────────────── │              │
└───────────┘   actions (direct    └──────────────┘
                 store method calls)
```

The store never references the rule engine. Rule action handlers hold a reference to the store (or bucket handles) and call `insert`, `update`, `delete` directly. No special bridge API exists for this direction.

**Preventing infinite loops:** When rule actions write back to the store, those writes produce new events. Guard against infinite recursion by:

1. **Filtering by bucket** — Forward only "source" buckets through the bridge; rule actions write to "target" buckets that the bridge ignores
2. **Filtering by content** — Use guard conditions in rule handlers to only react to specific state transitions
3. **Separate bridge instances** — Use multiple bridges with different filters for different domains

**Example — safe feedback loop:**

```typescript
// Only forward order events to the rule engine
const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  filter: (event) => event.bucket === 'orders',
});

// Rule action writes to 'loyalty' bucket — this event is NOT forwarded
// because the filter blocks non-order events. No infinite loop.
```

---

## See Also

- [Events](./events.md) — event types, wildcard patterns, and `store.on()` that the bridge uses internally
- [Store API](./store.md) — `Store.start()` and `store.on()` method signatures
- [Transactions](./transactions.md) — using transactions inside rule action handlers for atomic multi-bucket updates
- **Learn:** [Bridge Setup](../learn/11-rules-bridge/01-bridge-setup.md) — step-by-step tutorial with exercises
- **Learn:** [Store-Driven Rules](../learn/11-rules-bridge/02-store-driven-rules.md) — bidirectional integration patterns and loop prevention
- **Source:** [`src/bridge/rules-bridge.ts`](../../src/bridge/rules-bridge.ts)
