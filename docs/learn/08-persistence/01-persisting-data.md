# Persisting Data

Your store holds thousands of records — user sessions, configuration, cached API responses. The process restarts (deployment, crash, server reboot) and everything is gone. You rebuild from external sources, re-fetch APIs, and hope nothing was lost in the gap. Meanwhile, your users see empty dashboards and stale data until the system catches up.

noex-store persistence saves bucket state to durable storage automatically. Mutations trigger debounced snapshots written through a pluggable adapter. When the store restarts, it loads the last snapshot and resumes where it left off — indexes rebuilt, autoincrement counters restored, unique constraints enforced.

## What You'll Learn

- How to configure persistence with `StorePersistenceConfig`
- How storage adapters (`MemoryAdapter`, `FileAdapter`, `SQLiteAdapter`) work
- How debounced snapshots batch writes for efficiency
- How to opt individual buckets out of persistence
- How the persistence layer interacts with the event system
- How errors are handled without crashing the store

## Configuration

Persistence is an opt-in feature configured at store creation via the `persistence` option:

```typescript
import { Store } from '@hamicek/noex-store';
import { MemoryAdapter } from '@hamicek/noex';

const store = await Store.start({
  name: 'my-app',
  persistence: {
    adapter: new MemoryAdapter(),
    debounceMs: 100,
    onError: (err) => console.error('Persistence error:', err.message),
  },
});
```

### StorePersistenceConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `adapter` | `StorageAdapter` | *(required)* | Storage backend that handles load/save operations |
| `debounceMs` | `number` | `100` | Milliseconds to wait before batching writes |
| `onError` | `(error: Error) => void` | `undefined` | Callback for non-fatal persistence errors |

Without the `persistence` option, the store runs purely in-memory. Adding it later requires no code changes — the same bucket definitions and CRUD operations work identically.

## Storage Adapters

The adapter is the bridge between the store and durable storage. All adapters implement the same `StorageAdapter` interface from `@hamicek/noex`:

```typescript
interface StorageAdapter {
  save<T>(key: string, data: PersistedState<T>): Promise<void>;
  load<T>(key: string): Promise<PersistedState<T> | undefined>;
  close?(): Promise<void>;
}
```

### Available Adapters

| Adapter | Import | Use Case |
|---------|--------|----------|
| `MemoryAdapter` | `@hamicek/noex` | Tests, prototyping, ephemeral storage |
| `FileAdapter` | `@hamicek/noex` | Single-process apps, simple deployments |
| `SQLiteAdapter` | `@hamicek/noex` | Production workloads, concurrent access |

### MemoryAdapter

Stores data in a plain `Map`. Data is lost when the process exits, but survives store restarts within the same process — useful for testing persistence logic without touching the filesystem:

```typescript
import { MemoryAdapter } from '@hamicek/noex';

const adapter = new MemoryAdapter();

const store = await Store.start({
  name: 'test-store',
  persistence: { adapter },
});
```

### FileAdapter

Writes JSON files to a directory. Each bucket gets its own file:

```typescript
import { FileAdapter } from '@hamicek/noex';

const adapter = new FileAdapter('./data');

const store = await Store.start({
  name: 'my-app',
  persistence: { adapter },
});
```

### SQLiteAdapter

Uses SQLite for storage. Handles concurrent reads efficiently and provides crash-safe writes:

```typescript
import { SQLiteAdapter } from '@hamicek/noex';

const adapter = new SQLiteAdapter('./data/store.db');

const store = await Store.start({
  name: 'my-app',
  persistence: { adapter },
});
```

### Choosing an Adapter

| Criterion | MemoryAdapter | FileAdapter | SQLiteAdapter |
|-----------|---------------|-------------|---------------|
| **Survives process restart** | No | Yes | Yes |
| **Crash safety** | N/A | Partial (last write may be lost) | Full (atomic writes) |
| **Setup** | Zero | Directory path | File path |
| **Best for** | Tests | Simple apps | Production |

## How Debounced Snapshots Work

Persistence doesn't write to storage on every mutation. Instead, it batches changes using a debounce timer:

```text
  Mutation 1 (insert)     t=0ms
      |
      v
  Mark bucket dirty, start timer (100ms)
      |
  Mutation 2 (update)     t=30ms
      |
      v
  Bucket already dirty, timer still running
      |
  Mutation 3 (delete)     t=80ms
      |
      v
  Bucket already dirty, timer still running
      |
  Timer fires             t=100ms
      |
      v
  Snapshot bucket -> adapter.save()
  (one write for all three mutations)
```

### The Debounce Flow

1. A mutation (insert, update, delete) in a bucket triggers an event on the EventBus
2. `StorePersistence` receives the event and marks the bucket as "dirty"
3. If no debounce timer is running, one starts (default: 100ms)
4. When the timer fires, all dirty buckets are snapshotted in parallel
5. Each snapshot captures the full bucket state atomically via a GenServer call
6. The snapshot is written to the adapter

### Why Debounce?

| Without Debounce | With Debounce (100ms) |
|------------------|-----------------------|
| 100 inserts = 100 adapter writes | 100 inserts in <100ms = 1 adapter write |
| High I/O pressure on storage | Minimal I/O overhead |
| Each write captures incremental state | Each write captures complete state |

### Tuning debounceMs

```typescript
// Low latency: persist quickly, more writes
persistence: { adapter, debounceMs: 50 }

// Default balance
persistence: { adapter, debounceMs: 100 }

// High throughput: batch more, fewer writes
persistence: { adapter, debounceMs: 1000 }
```

Lower values reduce the window for data loss on crash. Higher values reduce I/O at the cost of a larger potential loss window. The default of 100ms is a good starting point for most workloads.

## Per-Bucket Opt-Out

When persistence is configured on the store, all buckets are persistent by default. You can exclude specific buckets using `persistent: false` in the bucket definition:

```typescript
const store = await Store.start({
  name: 'my-app',
  persistence: { adapter: new MemoryAdapter() },
});

// This bucket is persisted (default: persistent: true)
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

// This bucket is NOT persisted
await store.defineBucket('sessionCache', {
  key: 'token',
  schema: {
    token:     { type: 'string', required: true },
    userId:    { type: 'string', required: true },
    expiresAt: { type: 'number', required: true },
  },
  persistent: false,
});
```

After a restart:
- `users` bucket — data restored from the adapter
- `sessionCache` bucket — starts empty, data was not saved

### When to Opt Out

| Scenario | Persist? | Reason |
|----------|----------|--------|
| User accounts, orders, configuration | Yes | Core data that must survive restarts |
| Session tokens, request caches | No | Ephemeral data that should be rebuilt |
| Rate-limit counters | No | Short-lived, TTL-managed |
| Derived/computed data | No | Can be recomputed from source buckets |

## Error Handling

Persistence errors are non-fatal. The store continues operating in-memory even when the adapter fails:

```typescript
const store = await Store.start({
  name: 'my-app',
  persistence: {
    adapter,
    onError: (err) => {
      console.error(`Persistence failed: ${err.message}`);
      // Log to monitoring, alert ops team, etc.
    },
  },
});
```

### Error Behavior

| Situation | Behavior |
|-----------|----------|
| `adapter.save()` fails | Error reported via `onError`, store continues, retry on next debounce cycle |
| `adapter.load()` fails | Error reported via `onError`, bucket starts empty (graceful degradation) |
| No `onError` callback | Errors silently swallowed, store continues |
| Adapter throws during `close()` | Error propagated to `store.stop()` |

The store never crashes due to a persistence error. This design prioritizes availability — the in-memory data layer keeps serving requests even when the storage backend is temporarily unavailable.

## Persistence and Events

The persistence layer subscribes to the EventBus with the pattern `bucket.*.*`. Every insert, update, and delete event triggers the debounce mechanism:

```text
  BucketServer
      |
      | emit('bucket.users.inserted', { ... })
      |
      v
  EventBus ──> StorePersistence.#onBucketChange('users')
      |              |
      |              v
      |        Mark 'users' dirty, start/extend timer
      |
      ──> QueryManager (reactive queries)
      |
      ──> Your event handlers (store.on)
```

Events flow to all subscribers simultaneously. The persistence layer receives the same events as your application code — no special priority or ordering.

## Complete Working Example

A user management system with persistence and per-bucket opt-out:

```typescript
import { Store } from '@hamicek/noex-store';
import { MemoryAdapter } from '@hamicek/noex';

async function main() {
  const adapter = new MemoryAdapter();

  // --- First run: create and populate ---

  const store1 = await Store.start({
    name: 'user-app',
    persistence: {
      adapter,
      debounceMs: 100,
      onError: (err) => console.error(`[persistence] ${err.message}`),
    },
  });

  await store1.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true, format: 'email', unique: true },
      role:  { type: 'string', enum: ['user', 'admin'], default: 'user' },
    },
    indexes: ['email', 'role'],
  });

  await store1.defineBucket('cache', {
    key: 'key',
    schema: {
      key:   { type: 'string', required: true },
      value: { type: 'string', required: true },
    },
    persistent: false, // Ephemeral — not saved
  });

  const alice = await store1.bucket('users').insert({
    name: 'Alice', email: 'alice@example.com', role: 'admin',
  });
  const bob = await store1.bucket('users').insert({
    name: 'Bob', email: 'bob@example.com',
  });

  await store1.bucket('cache').insert({ key: 'theme', value: 'dark' });

  console.log(`Store 1: ${await store1.bucket('users').count()} users`);
  console.log(`Store 1: ${await store1.bucket('cache').count()} cache entries`);

  await store1.stop(); // Flushes all dirty buckets before shutdown

  // --- Second run: restart and verify ---

  const store2 = await Store.start({
    name: 'user-app',
    persistence: { adapter },
  });

  await store2.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true, format: 'email', unique: true },
      role:  { type: 'string', enum: ['user', 'admin'], default: 'user' },
    },
    indexes: ['email', 'role'],
  });

  await store2.defineBucket('cache', {
    key: 'key',
    schema: {
      key:   { type: 'string', required: true },
      value: { type: 'string', required: true },
    },
    persistent: false,
  });

  // Users survived the restart
  console.log(`\nStore 2: ${await store2.bucket('users').count()} users`); // 2

  // Cache did not survive (persistent: false)
  console.log(`Store 2: ${await store2.bucket('cache').count()} cache entries`); // 0

  // Data is intact
  const restoredAlice = await store2.bucket('users').get(alice.id);
  console.log(`Alice: ${restoredAlice?.name}, role=${restoredAlice?.role}`);

  // Indexes work after restore
  const admins = await store2.bucket('users').where({ role: 'admin' });
  console.log(`Admins: ${admins.length}`); // 1

  // Unique constraints work after restore
  try {
    await store2.bucket('users').insert({
      name: 'Fake', email: 'alice@example.com',
    });
  } catch (err) {
    console.log(`Unique constraint: ${(err as Error).message}`);
  }

  await store2.stop();
}

main();
```

## Exercise

You're building a feature-flag system. The store has two buckets: `flags` (persistent) stores feature flag definitions, and `evaluationCache` (non-persistent) stores recent flag evaluation results for performance.

```typescript
const store = await Store.start({
  name: 'feature-flags',
  persistence: { adapter: new MemoryAdapter() },
});

await store.defineBucket('flags', {
  key: 'name',
  schema: {
    name:        { type: 'string', required: true },
    enabled:     { type: 'boolean', required: true },
    description: { type: 'string' },
    percentage:  { type: 'number', min: 0, max: 100, default: 100 },
  },
  indexes: ['enabled'],
});
```

1. Define the `evaluationCache` bucket with fields `flagName` (string, key), `userId` (string, required), `result` (boolean, required), and `evaluatedAt` (number, required). It should not be persisted.
2. Insert three feature flags: `dark-mode` (enabled, 100%), `new-checkout` (enabled, 50%), and `beta-api` (disabled).
3. Stop and restart the store with the same adapter. After the restart, which bucket has data and which is empty?
4. After the restart, can you query flags by `enabled: true`? Why?

<details>
<summary>Solution</summary>

1. The `evaluationCache` bucket definition:

```typescript
await store.defineBucket('evaluationCache', {
  key: 'flagName',
  schema: {
    flagName:    { type: 'string', required: true },
    userId:      { type: 'string', required: true },
    result:      { type: 'boolean', required: true },
    evaluatedAt: { type: 'number', required: true },
  },
  persistent: false,
});
```

2. Insert the flags:

```typescript
const flags = store.bucket('flags');

await flags.insert({ name: 'dark-mode', enabled: true, description: 'Dark theme', percentage: 100 });
await flags.insert({ name: 'new-checkout', enabled: true, description: 'Redesigned checkout', percentage: 50 });
await flags.insert({ name: 'beta-api', enabled: false, description: 'Beta API endpoints' });
```

3. After restart, `flags` has 3 records (persisted) and `evaluationCache` has 0 records (not persisted):

```typescript
await store.stop();

// Restart with same adapter
const store2 = await Store.start({
  name: 'feature-flags',
  persistence: { adapter },
});

// Re-define both buckets with the same schemas
await store2.defineBucket('flags', { /* same definition */ });
await store2.defineBucket('evaluationCache', { /* same definition, persistent: false */ });

console.log(await store2.bucket('flags').count());           // 3
console.log(await store2.bucket('evaluationCache').count()); // 0
```

4. Yes, you can query `flags` by `enabled: true` after restart. The `indexes: ['enabled']` definition causes the index to be rebuilt from the restored records during `defineBucket()`. The restored records are fed into `IndexManager.addRecord()` one by one, so the index is fully functional:

```typescript
const enabledFlags = await store2.bucket('flags').where({ enabled: true });
console.log(enabledFlags.length); // 2 (dark-mode, new-checkout)
```

</details>

## Summary

- **`StorePersistenceConfig`** has three properties: `adapter` (required), `debounceMs` (default 100), and `onError` (optional callback)
- **Storage adapters** implement a simple `save`/`load`/`close` interface — use `MemoryAdapter` for tests, `FileAdapter` for simple apps, `SQLiteAdapter` for production
- **Debounced snapshots** batch multiple mutations into a single write per bucket — 100 rapid inserts result in one adapter call, not 100
- The snapshot captures the **full bucket state** atomically via a GenServer call — records and the autoincrement counter
- **Per-bucket opt-out**: set `persistent: false` on ephemeral buckets (caches, sessions, derived data) to skip persistence
- **Errors are non-fatal**: the store continues operating in-memory when the adapter fails; errors are reported via the `onError` callback
- Persistence subscribes to the **EventBus** — the same events that drive reactive queries and your event handlers also trigger persistence
- **`store.stop()`** flushes all dirty buckets before shutting down, ensuring no data is lost on graceful shutdown

---

Next: [Recovery and Snapshots](./02-recovery-and-snapshots.md)
