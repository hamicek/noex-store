# Store API Reference

> The central entry point for creating and managing an in-memory store with schema-driven buckets, reactive queries, transactions, events, persistence, and TTL lifecycle.

## Overview

`Store` is the top-level class of `@hamicek/noex-store`. It manages the full lifecycle of the store — from initialization through bucket registration, querying, and graceful shutdown. Under the hood it orchestrates a supervision tree, an event bus, a persistence layer, and a TTL manager, all built on the noex actor model.

You create a store with `Store.start()`, define buckets with `defineBucket()`, and access bucket data through `BucketHandle` instances returned by `bucket()`.

## API

### `Store.start(options?): Promise<Store>`

Static factory method. Creates and initializes a new store instance.

Internally starts a supervisor, an event bus, an optional persistence layer, and the reactive query layer. If `ttlCheckIntervalMs > 0`, automatic TTL expiration checks begin immediately.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `options` | [`StoreOptions`](#storeoptions) | `undefined` | Optional configuration for the store |

**Returns:** `Promise<Store>` — a fully initialized store instance

**Example:**

```typescript
import { Store } from '@hamicek/noex-store';

// Minimal — auto-generated name, no persistence, 1 s TTL check interval
const store = await Store.start();

// With options
const store = await Store.start({
  name: 'my-app',
  ttlCheckIntervalMs: 5_000,
});
```

---

### `store.name: string`

Read-only property. Returns the name of the store, either the one passed in `StoreOptions` or an auto-generated `"store-1"`, `"store-2"`, etc.

**Example:**

```typescript
const store = await Store.start({ name: 'inventory' });
console.log(store.name); // "inventory"
```

---

### `store.defineBucket(name, definition): Promise<void>`

Registers a new bucket in the store. A bucket is a named, schema-validated collection of records.

Internally validates the definition (checks that `key` and `indexes` reference fields in the schema), starts a supervised `BucketServer` process, optionally restores persisted data, and registers TTL tracking if `ttl` is set.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | — | Unique name for the bucket |
| `definition` | [`BucketDefinition`](./schema.md) | — | Schema, key, indexes, TTL, and size configuration |

**Returns:** `Promise<void>`

**Throws:**

- `BucketAlreadyExistsError` — a bucket with the same name is already defined
- `Error` — the `key` field does not exist in the schema
- `Error` — an index field does not exist in the schema

**Example:**

```typescript
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 1 },
    email: { type: 'string', format: 'email', unique: true },
    role:  { type: 'string', enum: ['admin', 'member'], default: 'member' },
  },
  indexes: ['email', 'role'],
});
```

---

### `store.bucket(name): BucketHandle`

Returns a `BucketHandle` for the named bucket. The handle provides the full CRUD, querying, pagination, and aggregation API.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | — | Name of a previously defined bucket |

**Returns:** [`BucketHandle`](./bucket-handle.md) — fluent handle for data operations

**Throws:** `BucketNotDefinedError` — the bucket has not been defined

**Example:**

```typescript
const users = store.bucket('users');
const record = await users.insert({ name: 'Alice', email: 'alice@example.com' });
```

---

### `store.dropBucket(name): Promise<void>`

Removes a bucket from the store. Unregisters it from TTL tracking and persistence, terminates its supervised process, and clears its definition.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | — | Name of the bucket to remove |

**Returns:** `Promise<void>`

**Throws:** `BucketNotDefinedError` — the bucket has not been defined

**Example:**

```typescript
await store.dropBucket('sessions');
```

---

### `store.defineQuery(name, fn): void`

Registers a named reactive query. The query function receives a `QueryContext` and optional parameters, and must return a result asynchronously. It may only read data — mutations inside a query are not allowed.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | — | Unique name for the query |
| `fn` | `QueryFn<TParams, TResult>` | — | Async function `(ctx, params?) => Promise<TResult>` |

**Returns:** `void`

**Throws:** `QueryAlreadyDefinedError` — a query with the same name is already defined

**Example:**

```typescript
store.defineQuery('activeUsers', async (ctx) => {
  return ctx.bucket('users').where({ role: 'admin' });
});

store.defineQuery('userById', async (ctx, params: { id: string }) => {
  return ctx.bucket('users').get(params.id);
});
```

---

### `store.subscribe(queryName, callback): Promise<() => void>`

Subscribes to a reactive query without parameters. The callback fires immediately with the current result and again whenever the result changes (determined by deep equality).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `queryName` | `string` | — | Name of a defined query |
| `callback` | `(result: TResult) => void` | — | Called with the query result |

**Returns:** `Promise<() => void>` — unsubscribe function

**Throws:** `QueryNotDefinedError` — the query has not been defined

### `store.subscribe(queryName, params, callback): Promise<() => void>`

Subscribes to a reactive query with parameters.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `queryName` | `string` | — | Name of a defined query |
| `params` | `TParams` | — | Parameters passed to the query function |
| `callback` | `(result: TResult) => void` | — | Called with the query result |

**Returns:** `Promise<() => void>` — unsubscribe function

**Example:**

```typescript
// Without params
const unsub = await store.subscribe('activeUsers', (users) => {
  console.log('Active users:', users.length);
});

// With params
const unsub = await store.subscribe('userById', { id: '123' }, (user) => {
  console.log('User:', user?.name);
});

// Later: stop listening
unsub();
```

---

### `store.runQuery(queryName, params?): Promise<TResult>`

Runs a reactive query once and returns the result. Does not create a subscription.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `queryName` | `string` | — | Name of a defined query |
| `params` | `unknown` | `undefined` | Optional parameters |

**Returns:** `Promise<TResult>` — the query result

**Throws:** `QueryNotDefinedError` — the query has not been defined

**Example:**

```typescript
const admins = await store.runQuery<StoreRecord[]>('activeUsers');
```

---

### `store.transaction(fn): Promise<T>`

Executes an async function inside a transactional context. All mutations are buffered and applied atomically on success. If the function throws, all changes are discarded (automatic rollback).

The transaction callback receives a `TransactionContext` with its own `tx.bucket(name)` method that returns a `TransactionBucketHandle` — not a regular `BucketHandle`. Reads inside the transaction see uncommitted writes (read-your-own-writes).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `fn` | `(tx: TransactionContext) => Promise<T>` | — | Async function that performs transactional operations |

**Returns:** `Promise<T>` — the value returned by `fn`

**Throws:** `TransactionConflictError` — a record was modified by another operation between read and commit (optimistic locking via `_version`)

**Example:**

```typescript
const result = await store.transaction(async (tx) => {
  const users = tx.bucket('users');
  const orders = tx.bucket('orders');

  const user = await users.get('u1');
  await orders.insert({ userId: 'u1', total: 99 });
  await users.update('u1', { orderCount: (user?.orderCount ?? 0) + 1 });

  return 'done';
});
```

---

### `store.on(pattern, handler): Promise<() => Promise<void>>`

Registers an event handler for store events matching the given pattern. Uses the internal event bus with wildcard-capable pattern matching.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pattern` | `string` | — | Event topic pattern (supports `*` wildcards) |
| `handler` | `(message: T, topic: string) => void` | — | Callback receiving the event payload and the matched topic |

**Returns:** `Promise<() => Promise<void>>` — async unsubscribe function

**Patterns:**

| Pattern | Matches |
|---------|---------|
| `bucket.users.inserted` | Inserts in the `users` bucket |
| `bucket.users.*` | All events in the `users` bucket |
| `bucket.*.inserted` | All inserts across all buckets |
| `bucket.*.*` | All bucket events |

**Example:**

```typescript
const unsub = await store.on<BucketInsertedEvent>(
  'bucket.users.inserted',
  (event, topic) => {
    console.log(`New user: ${event.record.name}`);
  },
);

// Wildcard — all bucket events
await store.on('bucket.*.*', (event) => {
  console.log(`${event.type} in ${event.bucket}`);
});

// Stop listening
await unsub();
```

---

### `store.getStats(): Promise<StoreStats>`

Returns a snapshot of the store's current statistics, including bucket counts, record counts, index counts, query info, persistence status, and TTL configuration.

**Parameters:** none

**Returns:** `Promise<`[`StoreStats`](#storestats)`>`

**Example:**

```typescript
const stats = await store.getStats();
console.log(`Buckets: ${stats.buckets.count}`);
console.log(`Total records: ${stats.records.total}`);
console.log(`Active subscriptions: ${stats.queries.activeSubscriptions}`);
```

---

### `store.purgeTtl(): Promise<number>`

Manually triggers TTL expiration across all TTL-enabled buckets. Useful in tests or when immediate cleanup is needed instead of waiting for the automatic check interval.

**Parameters:** none

**Returns:** `Promise<number>` — total number of expired records removed

**Example:**

```typescript
const purged = await store.purgeTtl();
console.log(`Purged ${purged} expired records`);
```

---

### `store.settle(): Promise<void>`

Waits for all pending reactive query re-evaluations to complete. Useful in tests to ensure subscriptions have received their latest values after a mutation.

**Parameters:** none

**Returns:** `Promise<void>`

**Example:**

```typescript
await store.bucket('users').insert({ name: 'Bob', email: 'bob@example.com' });
await store.settle(); // all reactive queries have been re-evaluated
```

---

### `store.stop(): Promise<void>`

Gracefully shuts down the store. Stops the TTL manager, destroys all reactive queries, flushes persistence (ensuring data is saved), stops the supervisor and event bus, and clears all internal state.

**Parameters:** none

**Returns:** `Promise<void>`

**Example:**

```typescript
await store.stop();
```

## Types

### `StoreOptions`

Configuration object passed to `Store.start()`.

```typescript
interface StoreOptions {
  readonly name?: string;
  readonly persistence?: StorePersistenceConfig;
  readonly ttlCheckIntervalMs?: number;
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | `"store-1"` (auto-increment) | Name of the store, used as prefix for internal actor names |
| `persistence` | [`StorePersistenceConfig`](./persistence.md) | `undefined` | Enables persistence when set. Configures adapter, debounce, and error handling |
| `ttlCheckIntervalMs` | `number` | `1000` | Interval in ms for automatic TTL expiration checks. Set to `0` to disable automatic checks |

---

### `StoreStats`

Snapshot returned by `store.getStats()`.

```typescript
interface StoreStats {
  readonly name: string;
  readonly buckets: {
    readonly count: number;
    readonly names: readonly string[];
  };
  readonly records: {
    readonly total: number;
    readonly perBucket: Readonly<Record<string, number>>;
  };
  readonly indexes: {
    readonly total: number;
    readonly perBucket: Readonly<Record<string, number>>;
  };
  readonly queries: {
    readonly defined: number;
    readonly activeSubscriptions: number;
  };
  readonly persistence: {
    readonly enabled: boolean;
  };
  readonly ttl: {
    readonly enabled: boolean;
    readonly checkIntervalMs: number;
  };
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Store name |
| `buckets.count` | `number` | Number of defined buckets |
| `buckets.names` | `readonly string[]` | Names of all defined buckets |
| `records.total` | `number` | Total records across all buckets |
| `records.perBucket` | `Record<string, number>` | Record count keyed by bucket name |
| `indexes.total` | `number` | Total indexes across all buckets |
| `indexes.perBucket` | `Record<string, number>` | Index count keyed by bucket name |
| `queries.defined` | `number` | Number of registered queries |
| `queries.activeSubscriptions` | `number` | Number of active subscriptions |
| `persistence.enabled` | `boolean` | Whether persistence is configured |
| `ttl.enabled` | `boolean` | Whether automatic TTL checks are running |
| `ttl.checkIntervalMs` | `number` | Configured TTL check interval in ms |

## See Also

- [BucketHandle API](./bucket-handle.md) — CRUD, filtering, pagination, and aggregation on bucket data
- [Schema and Types](./schema.md) — `BucketDefinition`, field types, constraints, and validation
- [Reactive Queries](./reactive-queries.md) — `defineQuery()`, `subscribe()`, and dependency tracking in depth
- [Transactions](./transactions.md) — `TransactionContext`, atomicity, and optimistic locking
- [Events](./events.md) — event types, wildcard patterns, and handler registration
- [Persistence](./persistence.md) — `StorePersistenceConfig`, adapters, and snapshot lifecycle
- [TTL and Lifecycle](./ttl-lifecycle.md) — TTL syntax, `TtlManager`, and `maxSize` eviction
- [Errors](./errors.md) — complete catalog of error classes
- **Learn:** [First Store](../learn/02-getting-started/01-first-store.md) — step-by-step tutorial for creating your first store
- **Learn:** [Buckets and Schemas](../learn/02-getting-started/02-buckets-and-schemas.md) — understanding bucket definitions
- **Source:** [`src/core/store.ts`](../../src/core/store.ts)
