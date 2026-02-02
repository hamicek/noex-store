# TTL and Lifecycle API Reference

> Time-to-live expiration, size-based eviction, and record metadata — automatic data lifecycle management for buckets.

## Overview

noex-store provides two mechanisms for limiting bucket data: **TTL** (time-to-live) automatically removes records after a configurable duration, and **maxSize** evicts the oldest records when a bucket exceeds its capacity limit. Both mechanisms emit standard `deleted` events, so reactive queries and event handlers respond to lifecycle removals the same way they respond to manual deletes.

Record metadata (`_version`, `_createdAt`, `_updatedAt`, `_expiresAt`) is maintained automatically by the store and drives both expiration and eviction decisions.

---

## TTL (Time-to-Live)

### Configuration

Set `ttl` on a `BucketDefinition` to enable automatic expiration:

```typescript
await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token: { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '30m', // Records expire after 30 minutes
});
```

The `ttl` property accepts two formats:

| Format | Type | Interpretation | Example |
|--------|------|----------------|---------|
| Number | `number` | Milliseconds (must be positive and finite) | `300000` |
| String | `string` | Human-readable duration with unit suffix | `"30m"` |

### Duration String Syntax

Strings follow the pattern `<value><unit>` where value can be an integer or decimal:

| Unit | Suffix | Multiplier | Examples |
|------|--------|------------|---------|
| Seconds | `s` | 1,000 ms | `"30s"`, `"2.5s"` |
| Minutes | `m` | 60,000 ms | `"5m"`, `"1.5m"` |
| Hours | `h` | 3,600,000 ms | `"1h"`, `"0.5h"` |
| Days | `d` | 86,400,000 ms | `"7d"`, `"90d"` |

Whitespace between the number and unit is allowed (`"30 m"` works).

**Invalid inputs** throw an `Error`:

```typescript
parseTtl(0);         // Error: TTL must be a positive finite number
parseTtl(-100);      // Error: TTL must be a positive finite number
parseTtl(Infinity);  // Error: TTL must be a positive finite number
parseTtl('');        // Error: Invalid TTL format
parseTtl('fast');    // Error: Invalid TTL format
parseTtl('10w');     // Error: Invalid TTL format (unsupported unit)
```

### How Expiration Works

1. **On insert** — if the bucket has a `ttl` and the record does not already have `_expiresAt`, the store sets `_expiresAt = _createdAt + ttlMs`.
2. **Automatic checks** — the `TtlManager` periodically scans all TTL-enabled buckets and removes records where `_expiresAt <= Date.now()`.
3. **Manual trigger** — call `store.purgeTtl()` to force an immediate expiration check.

Each purged record emits a `bucket.<name>.deleted` event, which triggers reactive query re-evaluation and persistence tracking.

### Per-Record Override

A record can override the bucket's default TTL by providing its own `_expiresAt` during insert:

```typescript
const sessions = store.bucket('sessions');

// Uses bucket TTL (30 minutes from now)
await sessions.insert({ userId: 'u1' });

// Custom expiration: 7 days from now
await sessions.insert({
  userId: 'u2',
  _expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
});
```

If `_expiresAt` is already set on the input data, the bucket's default TTL does not overwrite it.

---

## `parseTtl(ttl): number`

Exported utility function that converts a TTL value to milliseconds.

```typescript
import { parseTtl } from '@hamicek/noex-store';
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `ttl` | `number \| string` | TTL value — milliseconds (number) or duration string (`"30s"`, `"5m"`, `"1h"`, `"7d"`) |

**Returns:** `number` — the TTL in milliseconds.

**Throws:** `Error` — if the format is invalid or the value is not positive.

**Example:**

```typescript
parseTtl(5000);    // 5000
parseTtl('30s');   // 30000
parseTtl('5m');    // 300000
parseTtl('1h');    // 3600000
parseTtl('7d');    // 604800000
parseTtl('1.5h'); // 5400000
parseTtl('0.5d'); // 43200000
```

---

## Size Limits (`maxSize`)

### Configuration

Set `maxSize` on a `BucketDefinition` to cap the number of records:

```typescript
await store.defineBucket('recentLogs', {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    message: { type: 'string', required: true },
  },
  maxSize: 1000, // Keep at most 1000 records
});
```

### Eviction Behavior

When an `insert` would cause the record count to exceed `maxSize`, the **oldest** records (by `_createdAt` timestamp) are evicted before the new record is added:

1. Records are sorted by `_createdAt` ascending.
2. Enough records are removed to make room for the new one.
3. Each evicted record emits a `bucket.<name>.deleted` event.
4. The new record is then inserted normally.

```typescript
const logs = store.bucket('recentLogs');

// Insert 1000 records...
for (let i = 0; i < 1000; i++) {
  await logs.insert({ message: `Log entry ${i}` });
}

// This insert evicts the oldest record (entry 0)
await logs.insert({ message: 'Log entry 1000' });

const count = await logs.count(); // 1000
```

Eviction only occurs on `insert`. Updates and other operations do not trigger eviction.

### Combined TTL + maxSize

Both mechanisms can be used together. They operate independently:

- **maxSize** evicts on insert when capacity is exceeded.
- **TTL** purges expired records on the periodic timer or manual `purgeTtl()` call.

```typescript
await store.defineBucket('cache', {
  key: 'id',
  schema: {
    id: { type: 'string', required: true },
    data: { type: 'object' },
  },
  ttl: '1h',      // Expire after 1 hour
  maxSize: 500,    // Never exceed 500 records
});
```

---

## TtlManager

The `TtlManager` class orchestrates periodic expiration checks across all TTL-enabled buckets. It is created internally by `Store.start()` and is also exported for advanced use cases.

```typescript
import { TtlManager } from '@hamicek/noex-store';
```

### `new TtlManager(checkIntervalMs?)`

Creates a new TTL manager.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `checkIntervalMs` | `number` | `1000` | Interval between automatic expiration checks, in milliseconds |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `bucketCount` | `number` | Number of currently registered TTL-enabled buckets |
| `enabled` | `boolean` | Whether automatic periodic checks are running |
| `checkIntervalMs` | `number` | The configured check interval in milliseconds |

### `ttlManager.registerBucket(name, ref, ttlMs): void`

Registers a bucket for periodic TTL checks.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Bucket name |
| `ref` | `BucketRef` | GenServer reference to the bucket |
| `ttlMs` | `number` | TTL duration in milliseconds |

If a bucket with the same name is already registered, the previous entry is overwritten.

### `ttlManager.unregisterBucket(name): void`

Removes a bucket from periodic TTL checks.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Bucket name to unregister |

### `ttlManager.start(): void`

Starts automatic periodic expiration checks. Idempotent — calling `start()` on an already-running manager is a no-op.

Uses `setTimeout` chaining (not `setInterval`) to prevent overlapping ticks when a purge cycle takes longer than the check interval.

### `ttlManager.stop(): void`

Stops automatic periodic checks and clears any pending timer. Idempotent — safe to call multiple times. Can be restarted with `start()`.

### `ttlManager.purge(): Promise<number>`

Manually triggers an expiration check on all registered buckets.

**Returns:** `Promise<number>` — the total number of purged records across all buckets.

Skips buckets whose GenServer has been stopped. Errors in one bucket do not prevent other buckets from being processed.

---

## Store Integration

### `StoreOptions.ttlCheckIntervalMs`

Controls the automatic TTL check interval at the store level:

```typescript
const store = await Store.start({
  name: 'my-app',
  ttlCheckIntervalMs: 5000, // Check every 5 seconds
});
```

| Value | Behavior |
|-------|----------|
| `> 0` (default: `1000`) | TtlManager starts automatically with the given interval |
| `0` | Automatic checks disabled; use `store.purgeTtl()` for manual control |

### `store.purgeTtl(): Promise<number>`

Manually triggers a TTL expiration check on all TTL-enabled buckets.

**Returns:** `Promise<number>` — the total number of purged records.

**Example:**

```typescript
const purged = await store.purgeTtl();
console.log(`Removed ${purged} expired records`);
```

### `store.defineBucket()` — TTL Registration

When a bucket definition includes `ttl`, the store automatically:

1. Parses the TTL value using `parseTtl()`.
2. Registers the bucket with the `TtlManager`.

### `store.dropBucket()` — TTL Unregistration

Dropping a bucket automatically unregisters it from the `TtlManager`.

### `store.stop()` — Shutdown

`store.stop()` calls `ttlManager.stop()` before tearing down the supervisor tree, ensuring no purge cycles run against stopped bucket servers.

### `store.getStats()` — TTL Status

The `StoreStats.ttl` section reports the TTL subsystem state:

```typescript
const stats = await store.getStats();
console.log(stats.ttl);
// { enabled: true, checkIntervalMs: 1000 }
```

```typescript
interface StoreStats {
  // ... other fields ...
  readonly ttl: {
    readonly enabled: boolean;       // Whether automatic checks are running
    readonly checkIntervalMs: number; // Configured check interval
  };
}
```

Per-bucket TTL status is available via `BucketStats`:

```typescript
interface BucketStats {
  readonly hasTtl: boolean;             // Whether bucket has TTL enabled
  readonly hasMaxSize: boolean;         // Whether bucket has maxSize limit
  readonly maxSize: number | undefined; // The maxSize value, if set
  // ... other fields ...
}
```

---

## Record Metadata

Every record in the store carries four metadata fields, maintained automatically by the `SchemaValidator`:

### `RecordMeta`

```typescript
interface RecordMeta {
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
  readonly _expiresAt?: number;
}
```

```typescript
type StoreRecord<T = Record<string, unknown>> = T & RecordMeta;
```

### Field Details

#### `_version`

| Aspect | Detail |
|--------|--------|
| Type | `number` |
| Set on insert | `1` |
| Set on update | Incremented by 1 (`existing._version + 1`) |
| Purpose | Optimistic locking in transactions — `TransactionConflictError` is thrown when a record's version changed between read and commit |

#### `_createdAt`

| Aspect | Detail |
|--------|--------|
| Type | `number` |
| Value | `Date.now()` at insertion time (Unix millisecond timestamp) |
| Immutable | Not changed on update |
| Purpose | Used by `maxSize` eviction (oldest by `_createdAt` are evicted first) |

#### `_updatedAt`

| Aspect | Detail |
|--------|--------|
| Type | `number` |
| Set on insert | Same as `_createdAt` |
| Set on update | `Date.now()` at update time |
| Purpose | Track when a record was last modified |

#### `_expiresAt`

| Aspect | Detail |
|--------|--------|
| Type | `number \| undefined` |
| Set on insert | `_createdAt + ttlMs` for TTL-enabled buckets; `undefined` for non-TTL buckets |
| Override | Can be set explicitly on insert to override the bucket default |
| Purpose | TtlManager purges records where `_expiresAt <= Date.now()` |

### Metadata in Updates

The `SchemaValidator.prepareUpdate()` method strips `_version`, `_createdAt`, and `_updatedAt` from user-provided changes — these fields cannot be modified directly:

```typescript
// These meta fields in the changes object are silently ignored:
await bucket.update(key, {
  name: 'New name',     // Applied
  _version: 999,        // Stripped — version is auto-incremented
  _createdAt: 0,        // Stripped — creation timestamp is immutable
  _updatedAt: 0,        // Stripped — set to Date.now() automatically
});
```

---

## Events

Both TTL expiration and maxSize eviction emit standard `bucket.<name>.deleted` events:

```typescript
const unsub = await store.on('bucket.sessions.deleted', (event) => {
  console.log('Record removed:', event.key);
  // Works the same whether the record was manually deleted,
  // expired by TTL, or evicted by maxSize
});
```

Event type for all deletions (manual, TTL, eviction):

```typescript
interface BucketDeletedEvent {
  readonly type: 'deleted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord;
}
```

These events also trigger:
- **Reactive query re-evaluation** — subscriptions recalculate when dependent records are purged or evicted
- **Persistence tracking** — the bucket is marked dirty and will be persisted after the debounce interval

---

## See Also

- [Store API](./store.md) — `Store.start()` options (`ttlCheckIntervalMs`), `store.purgeTtl()`, `store.getStats()`
- [Schema and Types](./schema.md) — `BucketDefinition.ttl`, `BucketDefinition.maxSize`, `RecordMeta`
- [BucketHandle API](./bucket-handle.md) — `insert()` and how `_expiresAt` is set
- [Event System](./events.md) — `bucket.<name>.deleted` events from purge and eviction
- [Persistence](./persistence.md) — how lifecycle events trigger persistence snapshots
- [Transactions](./transactions.md) — `_version` and optimistic locking
- [Utilities](./utilities.md) — `parseTtl()` function reference
- [Errors](./errors.md) — `TransactionConflictError` related to `_version`
- **Learn:** [TTL Expiration](../learn/09-ttl-lifecycle/01-ttl-expiration.md) — conceptual introduction with exercises
- **Learn:** [Size Limits and Eviction](../learn/09-ttl-lifecycle/02-size-limits-and-eviction.md) — maxSize eviction with exercises
- **Source:** [`src/lifecycle/ttl-manager.ts`](../../src/lifecycle/ttl-manager.ts)
- **Source:** [`src/utils/parse-ttl.ts`](../../src/utils/parse-ttl.ts)
- **Source:** [`src/types/record.ts`](../../src/types/record.ts)
- **Source:** [`src/core/bucket-server.ts`](../../src/core/bucket-server.ts) — `handlePurgeExpired()`, `evictOldest()`
