# Persistence API Reference

> Automatic debounced snapshots of bucket state to pluggable storage adapters, with graceful restoration on restart.

## Overview

The persistence layer saves bucket data to durable storage so it survives process restarts. It listens to bucket mutation events, batches changes using a configurable debounce timer, and writes full bucket snapshots through a `StorageAdapter`. On startup, persisted snapshots are loaded before the bucket becomes available, restoring records, autoincrement counters, indexes, and unique constraints.

Persistence is opt-in at the store level and opt-out at the bucket level.

## Configuration

### `StoreOptions.persistence`

Pass a `StorePersistenceConfig` to `Store.start()` to enable persistence:

```typescript
import { Store } from '@hamicek/noex-store';
import { FileAdapter } from '@hamicek/noex';

const store = await Store.start({
  name: 'my-app',
  persistence: {
    adapter: new FileAdapter('./data'),
    debounceMs: 200,
    onError: (err) => console.error('Persistence error:', err.message),
  },
});
```

Without the `persistence` option, the store runs purely in-memory.

---

## Types

### `StorePersistenceConfig`

```typescript
interface StorePersistenceConfig {
  readonly adapter: StorageAdapter;
  readonly debounceMs?: number;
  readonly onError?: (error: Error) => void;
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `adapter` | `StorageAdapter` | *(required)* | Storage backend instance (`MemoryAdapter`, `FileAdapter`, or `SQLiteAdapter` from `@hamicek/noex`) |
| `debounceMs` | `number` | `100` | Milliseconds to wait before batching writes. Multiple mutations within this window produce a single adapter write per affected bucket. |
| `onError` | `(error: Error) => void` | `undefined` | Callback invoked on non-fatal persistence errors (load/save failures). The store continues operating in-memory. |

### `StorageAdapter`

The adapter interface from `@hamicek/noex` that all storage backends implement:

```typescript
interface StorageAdapter {
  save<T>(key: string, data: PersistedState<T>): Promise<void>;
  load<T>(key: string): Promise<PersistedState<T> | undefined>;
  close?(): Promise<void>;
}
```

| Method | Description |
|--------|-------------|
| `save(key, data)` | Persist data under the given key |
| `load(key)` | Load previously persisted data, or `undefined` if not found |
| `close()` | Optional cleanup (close file handles, database connections) |

### `PersistedState<T>`

The envelope format written to the adapter:

```typescript
interface PersistedState<T> {
  readonly state: T;
  readonly metadata: {
    readonly persistedAt: number;
    readonly serverId: string;
    readonly schemaVersion: number;
  };
}
```

| Field | Type | Description |
|-------|------|-------------|
| `state` | `T` | The bucket data (records and autoincrement counter) |
| `metadata.persistedAt` | `number` | Unix millisecond timestamp of the save |
| `metadata.serverId` | `string` | The store name |
| `metadata.schemaVersion` | `number` | Always `1` |

### `BucketSnapshot`

The internal bucket state captured during persistence:

```typescript
interface BucketSnapshot {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `records` | `ReadonlyArray<readonly [unknown, StoreRecord]>` | Array of `[key, record]` tuples — the full bucket contents |
| `autoincrementCounter` | `number` | Current autoincrement value for fields with `generated: 'autoincrement'` |

### `BucketInitialData`

The data returned by `loadBucket()` and passed to the bucket on creation:

```typescript
interface BucketInitialData {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}
```

Same structure as `BucketSnapshot`. On restore, records are inserted into the bucket's internal table, indexes are rebuilt, and unique constraints are re-established.

---

## Per-Bucket Opt-Out

When persistence is enabled on the store, all buckets are persistent by default. Set `persistent: false` in the `BucketDefinition` to exclude a bucket:

```typescript
// Persisted (default when store has persistence)
await store.defineBucket('users', {
  key: 'id',
  schema: { id: { type: 'string', generated: 'uuid' }, name: { type: 'string', required: true } },
});

// Not persisted
await store.defineBucket('sessionCache', {
  key: 'token',
  schema: { token: { type: 'string', required: true }, data: { type: 'object' } },
  persistent: false,
});
```

The `persistent` property on `BucketDefinition`:

| Value | Behavior |
|-------|----------|
| `true` (or omitted) | Bucket is loaded from adapter on creation and tracked for persistence |
| `false` | Bucket starts empty and mutations are not persisted |

A bucket is only persistent when **both** the store has a persistence config **and** `persistent !== false` on the bucket definition.

---

## Storage Key Format

Each bucket is stored under a namespaced key:

```
{storeName}:bucket:{bucketName}
```

**Example:** Store named `"my-app"` with a bucket named `"users"` produces the key `"my-app:bucket:users"`.

Using distinct store names prevents key collisions when multiple stores share the same adapter.

---

## Available Adapters

All adapters are imported from `@hamicek/noex`:

| Adapter | Constructor | Use Case |
|---------|-------------|----------|
| `MemoryAdapter` | `new MemoryAdapter()` | Tests, prototyping, ephemeral storage |
| `FileAdapter` | `new FileAdapter(directory)` | Single-process apps, simple deployments |
| `SQLiteAdapter` | `new SQLiteAdapter(dbPath)` | Production workloads, crash-safe writes |

```typescript
import { MemoryAdapter, FileAdapter, SQLiteAdapter } from '@hamicek/noex';
```

### Comparison

| Criterion | MemoryAdapter | FileAdapter | SQLiteAdapter |
|-----------|---------------|-------------|---------------|
| Survives process restart | No | Yes | Yes |
| Crash safety | N/A | Partial (last write may be lost) | Full (atomic writes) |
| Setup | Zero | Directory path | File path |

---

## StorePersistence Class

The `StorePersistence` class is exported from the main package and manages the full persistence lifecycle. It is instantiated internally by `Store.start()` when a `persistence` config is provided, but is also available for advanced use cases.

```typescript
import { StorePersistence } from '@hamicek/noex-store';
```

### `new StorePersistence(storeName, config)`

Creates a new persistence manager.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `storeName` | `string` | Store name, used to prefix storage keys |
| `config` | `StorePersistenceConfig` | Adapter, debounce, and error callback configuration |

**Example:**

```typescript
const persistence = new StorePersistence('my-app', {
  adapter: new MemoryAdapter(),
  debounceMs: 200,
});
```

---

### `persistence.start(eventBusRef): Promise<void>`

Subscribes to bucket events on the event bus. Must be called before any bucket mutations occur.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventBusRef` | `EventBusRef` | Reference to the store's event bus |

Internally subscribes to the pattern `bucket.*.*` to receive all insert, update, and delete events.

---

### `persistence.loadBucket(name): Promise<BucketInitialData | undefined>`

Loads a previously persisted bucket snapshot from the adapter.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Bucket name to load |

**Returns:** `Promise<BucketInitialData | undefined>` — the persisted records and autoincrement counter, or `undefined` if no data exists or an error occurs.

**Error handling:** Adapter failures are caught, passed to the `onError` callback, and the method returns `undefined`. The bucket proceeds with empty state (graceful degradation).

**Example:**

```typescript
const data = await persistence.loadBucket('users');
if (data) {
  console.log(`Restored ${data.records.length} records`);
}
```

---

### `persistence.registerBucket(name, ref): void`

Registers a bucket for persistence tracking. After registration, mutation events for this bucket trigger the debounce mechanism.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Bucket name |
| `ref` | `BucketRef` | GenServer reference to the bucket |

---

### `persistence.unregisterBucket(name): void`

Stops tracking a bucket. Removes its reference and clears it from the dirty set. Subsequent events for this bucket are ignored.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Bucket name to unregister |

Called internally when `store.dropBucket()` removes a bucket.

---

### `persistence.flush(): Promise<void>`

Immediately persists all dirty buckets without waiting for the debounce timer. If a debounce timer is active, it is cleared.

Does nothing if no buckets are dirty.

**Error handling:** Individual bucket save errors invoke `onError` but do not prevent other buckets from being persisted.

**Example:**

```typescript
await store.bucket('users').insert({ name: 'Alice' });
await persistence.flush(); // Force immediate write
```

---

### `persistence.stop(): Promise<void>`

Gracefully shuts down the persistence layer:

1. Stops listening to new events
2. Marks all registered buckets as dirty
3. Calls `flush()` to persist everything
4. Unsubscribes from the event bus
5. Calls `adapter.close()` if the adapter implements it

**Important:** `stop()` must be called while bucket GenServers are still alive, because `flush()` sends `getSnapshot` messages to them. This is why `Store.stop()` calls `persistence.stop()` before stopping the supervisor tree.

---

## Lifecycle

### Initialization

```
Store.start({ persistence: config })
  1. Create StorePersistence(name, config)
  2. persistence.start(eventBusRef)        -- subscribe to events
```

### Bucket Creation

```
store.defineBucket('users', definition)
  1. Check: isPersistent = persistence !== null && (definition.persistent ?? true)
  2. If persistent: initialData = await persistence.loadBucket('users')
  3. Create bucket GenServer with initialData
  4. If persistent: persistence.registerBucket('users', ref)
```

### Normal Operation

```
bucket.insert/update/delete
  → BucketServer applies mutation
  → EventBus publishes bucket.users.inserted/updated/deleted
  → StorePersistence receives event
  → Marks bucket as dirty
  → Starts debounce timer (if not already running)
  → Timer fires after debounceMs:
      → Get snapshot from BucketServer via GenServer.call
      → adapter.save(key, { state, metadata })
```

### Shutdown

```
store.stop()
  1. persistence.stop()
     a. Set isStopping = true (ignore new events)
     b. Mark all registered buckets as dirty
     c. flush() — persist everything
     d. Unsubscribe from EventBus
     e. adapter.close()
  2. Stop supervisor tree (BucketServers)
  3. Stop EventBus
```

---

## Debounce Mechanism

Multiple rapid mutations are batched into a single write per bucket:

```
t=0ms    insert into 'users'     → dirty={users}, start timer
t=10ms   update in 'users'       → dirty={users}, timer already running
t=30ms   insert into 'orders'    → dirty={users, orders}
t=100ms  timer fires             → persist 'users' and 'orders' in parallel
                                 → dirty={}, timer=null
```

- The first event in a quiet period starts the timer.
- Subsequent events add buckets to the dirty set; the timer is not reset.
- When the timer fires, all dirty buckets are snapshotted concurrently via `Promise.all`.
- An explicit `flush()` clears the timer and persists immediately.

### Tuning `debounceMs`

| Value | Trade-off |
|-------|-----------|
| `50` | Lower data-loss window, more frequent writes |
| `100` (default) | Balanced for most workloads |
| `500–1000` | Fewer writes, larger data-loss window on crash |

---

## Error Handling

### Non-Fatal Errors

Persistence errors never crash the store. The in-memory data layer continues serving requests regardless of adapter failures.

| Situation | Behavior |
|-----------|----------|
| `adapter.save()` fails | `onError` callback invoked, store continues. The bucket is re-persisted when the next mutation marks it dirty again. |
| `adapter.load()` fails | `onError` callback invoked, bucket starts empty |
| No `onError` provided | Errors silently ignored |

### Fatal Errors

| Situation | Behavior |
|-----------|----------|
| `adapter.close()` throws during `stop()` | Error propagated to `store.stop()` caller |

### Error Callback Pattern

```typescript
const store = await Store.start({
  name: 'my-app',
  persistence: {
    adapter,
    onError: (error) => {
      console.error('Persistence error:', error.message);
      // Send to monitoring, metrics, etc.
    },
  },
});
```

---

## Store Stats

`store.getStats()` reports whether persistence is enabled:

```typescript
const stats = await store.getStats();
console.log(stats.persistence.enabled); // true
```

The `persistence` section of `StoreStats`:

```typescript
{
  persistence: {
    enabled: boolean;  // true when store was created with a persistence config
  };
}
```

---

## See Also

- [Store API](./store.md) — `Store.start()` options and `store.stop()` lifecycle
- [Schema and Types](./schema.md) — `BucketDefinition.persistent` field
- [Event System](./events.md) — bucket events that trigger persistence
- [TTL and Lifecycle](./ttl-lifecycle.md) — TTL expiration and `maxSize` eviction interact with persistence
- [Errors](./errors.md) — complete error catalog
- **Learn:** [Persisting Data](../learn/08-persistence/01-persisting-data.md) — conceptual introduction with exercises
- **Learn:** [Recovery and Snapshots](../learn/08-persistence/02-recovery-and-snapshots.md) — restore flow and snapshot internals
- **Source:** [`src/persistence/store-persistence.ts`](../../src/persistence/store-persistence.ts)
- **Source:** [`src/types/schema.ts`](../../src/types/schema.ts) — `StorePersistenceConfig`
