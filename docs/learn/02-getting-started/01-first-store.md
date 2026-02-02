# Your First Store

You've seen what noex-store offers at a high level. Now it's time to write real code. In this chapter you'll install the library, start a store, inspect its state, and shut it down cleanly. By the end, you'll have a running store ready for buckets.

## What You'll Learn

- How to install `@hamicek/noex-store` and its peer dependency
- How to start a store with `Store.start()` and configure it with `StoreOptions`
- The full lifecycle of a store: start, run, stop
- How to inspect a running store with `getStats()`
- How to wait for asynchronous work to settle before assertions or shutdown

## Installation

noex-store is built on the `@hamicek/noex` actor framework. Install both:

```bash
npm install @hamicek/noex-store @hamicek/noex
```

`@hamicek/noex` provides the GenServer, Supervisor, and EventBus primitives that the store uses internally. You'll also import persistence adapters from it when you enable persistence later.

## Starting a Store

A store is created with the async factory method `Store.start()`:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start();
```

That's it. The store is running. Under the hood, `start()` does the following:

```text
  Store.start(options?)
        │
        ├── 1. Create EventBus (for change notifications)
        ├── 2. Create Supervisor (for bucket actor management)
        ├── 3. Initialize Persistence (if configured)
        ├── 4. Create TtlManager (for record expiration)
        ├── 5. Wire reactive query layer to EventBus
        │
        ▼
  Store instance (ready for defineBucket, transaction, …)
```

The constructor is private — you always use `Store.start()`. This ensures all async initialization (event bus, supervisor, persistence loading) completes before you get a store reference.

## StoreOptions

`Store.start()` accepts an optional configuration object:

```typescript
const store = await Store.start({
  name: 'my-app',
  ttlCheckIntervalMs: 5000,
});
```

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `name` | `string` | `'store-1'`, `'store-2'`, … | Human-readable identifier. Appears in error messages and stats. |
| `persistence` | `StorePersistenceConfig` | `undefined` | Enable persistence with a storage adapter (covered in a later chapter). |
| `ttlCheckIntervalMs` | `number` | `1000` | How often (in ms) the TTL manager checks for expired records. Set to `0` to disable automatic checks. |

### Store Name

When you omit the name, the store auto-generates one (`store-1`, `store-2`, etc.). This is fine for tests. In production, always provide a name — it makes debugging and logging much easier:

```typescript
// Test — auto-generated name is fine
const store = await Store.start();

// Production — explicit name
const store = await Store.start({ name: 'order-service' });
```

The name is read-only after creation:

```typescript
console.log(store.name); // 'order-service'
```

### TTL Check Interval

The TTL manager periodically scans TTL-enabled buckets and purges expired records. The default interval is 1000 ms. For high-throughput scenarios, you might increase it to reduce overhead:

```typescript
// Check every 5 seconds instead of every second
const store = await Store.start({ ttlCheckIntervalMs: 5000 });
```

Set to `0` to disable automatic TTL checks entirely. You can still trigger manual purges with `store.purgeTtl()`:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

// Later, when you want to purge explicitly:
const purged = await store.purgeTtl();
console.log(`Purged ${purged} expired records`);
```

## Store Lifecycle

A store has three phases:

```text
  ┌──────────────────────────────────────────────────────────────┐
  │                      STORE LIFECYCLE                          │
  │                                                               │
  │   Store.start()                                               │
  │        │                                                      │
  │        ▼                                                      │
  │   ┌─────────────────────────────────────────────────────┐    │
  │   │                    RUNNING                           │    │
  │   │                                                      │    │
  │   │  defineBucket() ──── add collections                 │    │
  │   │  bucket()       ──── get handle for CRUD             │    │
  │   │  transaction()  ──── atomic multi-bucket writes      │    │
  │   │  on()           ──── subscribe to events             │    │
  │   │  defineQuery()  ──── register reactive queries       │    │
  │   │  subscribe()    ──── listen to query results         │    │
  │   │  dropBucket()   ──── remove a collection             │    │
  │   │  getStats()     ──── inspect store state             │    │
  │   │  purgeTtl()     ──── manually expire records         │    │
  │   │  settle()       ──── wait for pending work           │    │
  │   │                                                      │    │
  │   └──────────────────────────┬───────────────────────────┘    │
  │                              │                                │
  │                     store.stop()                              │
  │                              │                                │
  │                              ▼                                │
  │   ┌─────────────────────────────────────────────────────┐    │
  │   │                    STOPPED                           │    │
  │   │                                                      │    │
  │   │  TTL manager stopped                                 │    │
  │   │  Reactive queries destroyed                          │    │
  │   │  Persistence flushed to storage                      │    │
  │   │  All bucket actors terminated                        │    │
  │   │  EventBus shut down                                  │    │
  │   └─────────────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────────────┘
```

### Starting

`Store.start()` is the only way to create a store. It returns a `Promise<Store>` because initialization involves starting actors and (optionally) loading persisted data:

```typescript
const store = await Store.start({ name: 'my-app' });
// Store is fully initialized and ready to use
```

### Running

Once started, the store accepts all operations. You can define buckets, perform CRUD operations, set up reactive queries, run transactions, and subscribe to events. There is no explicit "open" or "connect" step — the store is ready immediately after `start()` resolves.

### Stopping

Always stop the store when you're done. `stop()` performs a graceful shutdown in the correct order:

```typescript
await store.stop();
```

The shutdown sequence:

1. **Stop TTL manager** — no more automatic purge cycles
2. **Destroy reactive queries** — unsubscribe all listeners
3. **Flush persistence** — save final snapshots to storage (requires live bucket actors)
4. **Terminate all bucket actors** — via the Supervisor
5. **Stop EventBus** — shut down the event system

The order matters: persistence must flush *before* bucket actors terminate, because flushing requires sending snapshot requests to live actors.

## Inspecting the Store

`getStats()` returns a comprehensive snapshot of the store's current state:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'stats-demo' });

  // Empty store
  const stats = await store.getStats();
  console.log(stats);
  // {
  //   name: 'stats-demo',
  //   buckets: { count: 0, names: [] },
  //   records: { total: 0, perBucket: {} },
  //   indexes: { total: 0, perBucket: {} },
  //   queries: { defined: 0, activeSubscriptions: 0 },
  //   persistence: { enabled: false },
  //   ttl: { enabled: true, checkIntervalMs: 1000 },
  // }

  // Define a bucket and insert some data
  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:   { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
    },
    indexes: ['name'],
  });

  const users = store.bucket('users');
  await users.insert({ name: 'Alice' });
  await users.insert({ name: 'Bob' });

  const updated = await store.getStats();
  console.log(updated.buckets);
  // { count: 1, names: ['users'] }
  console.log(updated.records);
  // { total: 2, perBucket: { users: 2 } }
  console.log(updated.indexes);
  // { total: 1, perBucket: { users: 1 } }

  await store.stop();
}

main();
```

### StoreStats Shape

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Store identifier |
| `buckets.count` | `number` | Number of defined buckets |
| `buckets.names` | `string[]` | List of bucket names |
| `records.total` | `number` | Total records across all buckets |
| `records.perBucket` | `Record<string, number>` | Record count per bucket |
| `indexes.total` | `number` | Total indexes across all buckets |
| `indexes.perBucket` | `Record<string, number>` | Index count per bucket |
| `queries.defined` | `number` | Number of registered reactive queries |
| `queries.activeSubscriptions` | `number` | Number of active query subscriptions |
| `persistence.enabled` | `boolean` | Whether persistence is configured |
| `ttl.enabled` | `boolean` | Whether automatic TTL checks are running |
| `ttl.checkIntervalMs` | `number` | TTL check interval in milliseconds |

## Settling Asynchronous Work

Reactive queries re-evaluate asynchronously when data changes. If you need to ensure all pending evaluations have completed (for example, before an assertion in a test), use `settle()`:

```typescript
const store = await Store.start({ name: 'settle-demo' });

await store.defineBucket('items', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

let latestCount = 0;

store.defineQuery('itemCount', async (ctx) => {
  const all = await ctx.bucket('items').all();
  return all.length;
});

await store.subscribe<number>('itemCount', (count) => {
  latestCount = count;
});

const items = store.bucket('items');
await items.insert({ name: 'Widget' });

// The reactive query re-evaluates asynchronously.
// Without settle(), latestCount might still be 0 here.
await store.settle();

console.log(latestCount); // 1 — guaranteed after settle()

await store.stop();
```

`settle()` is primarily useful in tests. In production, reactive query callbacks handle updates naturally as they arrive.

## Complete Example

Putting it all together — a store that starts, defines two buckets, checks stats, and shuts down:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  // 1. Start the store
  const store = await Store.start({
    name: 'getting-started',
    ttlCheckIntervalMs: 5000,
  });

  console.log(`Store "${store.name}" started`);

  // 2. Define buckets
  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', format: 'email', unique: true },
    },
    indexes: ['email'],
  });

  await store.defineBucket('logs', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      action:    { type: 'string', required: true },
      timestamp: { type: 'string', generated: 'timestamp' },
    },
    ttl: '7d',
  });

  // 3. Insert data
  const users = store.bucket('users');
  const logs = store.bucket('logs');

  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  console.log('Inserted user:', alice.id);

  await logs.insert({ action: 'user.created' });

  // 4. Inspect the store
  const stats = await store.getStats();
  console.log(`Buckets: ${stats.buckets.count}`);       // 2
  console.log(`Total records: ${stats.records.total}`);  // 2
  console.log(`TTL enabled: ${stats.ttl.enabled}`);      // true

  // 5. Clean shutdown
  await store.stop();
  console.log('Store stopped');
}

main();
```

## Exercise

Without running the code, predict the output of this program. Then check your answers.

```typescript
import { Store } from '@hamicek/noex-store';

async function quiz() {
  const store = await Store.start({ name: 'quiz' });

  // Question 1: What is store.name?
  console.log('Q1:', store.name);

  await store.defineBucket('tasks', {
    key: 'id',
    schema: {
      id:     { type: 'number', generated: 'autoincrement' },
      title:  { type: 'string', required: true },
      done:   { type: 'boolean', default: false },
    },
  });

  const tasks = store.bucket('tasks');
  await tasks.insert({ title: 'Learn noex-store' });
  await tasks.insert({ title: 'Build something' });
  await tasks.insert({ title: 'Ship it' });

  const stats = await store.getStats();

  // Question 2: How many buckets?
  console.log('Q2:', stats.buckets.count);

  // Question 3: How many total records?
  console.log('Q3:', stats.records.total);

  // Question 4: Is persistence enabled?
  console.log('Q4:', stats.persistence.enabled);

  // Question 5: What happens here?
  try {
    await store.defineBucket('tasks', {
      key: 'id',
      schema: { id: { type: 'string' } },
    });
    console.log('Q5: success');
  } catch (err) {
    console.log('Q5:', err.constructor.name);
  }

  await store.stop();
}

quiz();
```

<details>
<summary>Solution</summary>

**Q1: `'quiz'`**
The name option was set to `'quiz'`, so `store.name` returns `'quiz'`.

**Q2: `1`**
Only one bucket (`tasks`) was defined.

**Q3: `3`**
Three records were inserted into the `tasks` bucket.

**Q4: `false`**
No `persistence` option was passed to `Store.start()`, so persistence is not enabled.

**Q5: `'BucketAlreadyExistsError'`**
The `tasks` bucket was already defined. Calling `defineBucket('tasks', …)` again throws a `BucketAlreadyExistsError`. The bucket name must be unique within a store.

</details>

## Summary

- Install `@hamicek/noex-store` alongside `@hamicek/noex` (the underlying actor framework)
- Create a store with `await Store.start(options?)` — the constructor is private
- `StoreOptions` configures the name, persistence, and TTL check interval
- The store lifecycle is: **start** (async initialization) → **running** (all operations available) → **stop** (graceful shutdown in correct order)
- `getStats()` provides a comprehensive snapshot: buckets, records, indexes, queries, persistence, and TTL status
- `settle()` waits for all pending reactive query evaluations — useful in tests
- Always call `store.stop()` when done to flush persistence and release resources

## API Reference

- [Store API](../../reference/store.md) — `Store.start()`, `StoreOptions`, `getStats()`, `settle()`, `stop()`

---

Next: [Buckets and Schemas](./02-buckets-and-schemas.md)
