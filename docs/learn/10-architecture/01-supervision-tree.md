# Supervision Tree

You build a store with six buckets, run it for hours, and then an edge case in your schema validation throws an unhandled error inside one bucket's actor. In a traditional architecture, that error crashes the process — and all six buckets go down. Users lose access to everything, not just the bucket that failed. You add try/catch blocks everywhere, but some errors slip through. You need each bucket to be isolated so that one failure doesn't cascade.

noex-store is built on the actor model (`@hamicek/noex`). Every bucket runs as an independent GenServer process, managed by a Supervisor with a `one_for_one` strategy. If a bucket crashes, the supervisor restarts only that bucket. The other buckets keep serving requests as if nothing happened. This chapter shows you exactly how the supervision tree is structured, how processes are registered, and why this architecture makes the store resilient.

## What You'll Learn

- How Store, Supervisor, BucketServer, and EventBus form a process hierarchy
- What the `one_for_one` supervision strategy means and why it's used
- How BucketServer encapsulates state as a GenServer actor
- How the Registry names processes for debugging and monitoring
- How `defineBucket()` and `dropBucket()` dynamically modify the tree
- How graceful shutdown propagates through the hierarchy

## The Full Process Tree

When you call `Store.start()`, the store creates a supervision tree:

```text
  Store.start({ name: 'app' })
        │
        ├── EventBus ─────────────── "app:events"
        │
        ├── Supervisor ──────────── "app:supervisor"  (one_for_one)
        │       │
        │       ├── BucketServer ── "app:bucket:users"     (GenServer)
        │       ├── BucketServer ── "app:bucket:orders"    (GenServer)
        │       └── BucketServer ── "app:bucket:sessions"  (GenServer)
        │
        ├── QueryManager ────────── (in-process, not an actor)
        │
        ├── StorePersistence ────── (optional, subscribes to EventBus)
        │
        └── TtlManager ─────────── (optional, periodic setTimeout chain)
```

The Store itself is not an actor — it's a plain TypeScript object that holds references to all the moving parts. The actors are the EventBus, the Supervisor, and the BucketServers. The QueryManager, StorePersistence, and TtlManager are regular objects that interact with actors through message passing.

## The Supervisor

The Supervisor is the backbone of fault tolerance. It manages child processes (BucketServers) and restarts them when they fail.

### one_for_one Strategy

```text
  Supervisor (one_for_one)
      │
      ├── BucketServer "users"     ← crashes
      ├── BucketServer "orders"    ← unaffected, keeps running
      └── BucketServer "sessions"  ← unaffected, keeps running
```

With `one_for_one`, when a child process crashes, **only that child** is restarted. The siblings continue running without interruption. This is the right strategy when children are independent — and buckets are independent. The users bucket doesn't need the orders bucket to function.

Compare this to the alternatives:

| Strategy | On Child Crash | When to Use |
|----------|---------------|-------------|
| `one_for_one` | Restart only the crashed child | Children are independent (buckets) |
| `one_for_all` | Restart all children | Children depend on each other |
| `rest_for_one` | Restart crashed child and all children started after it | Sequential dependencies |

noex-store uses `one_for_one` because every bucket is a self-contained unit with its own data, schema, and indexes. No bucket depends on another bucket's internal state.

### How the Supervisor Starts

The store creates the supervisor during `Store.start()`:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'app' });

// At this point, the process tree looks like:
//
//   Store
//     ├── EventBus ("app:events")
//     ├── Supervisor ("app:supervisor")  ← empty, no children yet
//     ├── TtlManager (idle)
//     └── QueryManager (empty)
```

The supervisor starts with zero children. BucketServers are added dynamically as you call `defineBucket()`.

## BucketServer: The GenServer Actor

Each bucket is backed by a BucketServer — a GenServer that holds the bucket's data and processes all operations sequentially. This is the single most important architectural concept in noex-store.

### Why GenServer?

A GenServer processes messages one at a time, in order. This eliminates concurrency bugs without locks:

```text
  Request A: insert({name: 'Alice'})  ──┐
  Request B: update('key-1', {...})    ──┤     ┌──────────────┐
  Request C: where({role: 'admin'})    ──┼────►│ BucketServer │──► Response A
  Request D: delete('key-2')           ──┤     │  (mailbox)   │──► Response B
  Request E: insert({name: 'Bob'})     ──┘     └──────────────┘──► Response C
                                                                ──► Response D
                                                                ──► Response E
```

Messages queue in the mailbox and are processed sequentially. While the BucketServer handles request A, requests B through E wait. This gives you serializable isolation without any locking overhead — every operation sees a consistent snapshot of the data.

### BucketServer Internal State

Each BucketServer maintains four pieces of state:

```text
  ┌─────────────────────────────────────────────┐
  │              BucketServer                     │
  │                                               │
  │   ┌───────────────────────────────────────┐   │
  │   │  table: Map<PrimaryKey, StoreRecord>  │   │
  │   │                                       │   │
  │   │  The actual data. A Map keyed by the  │   │
  │   │  primary key field value.             │   │
  │   └───────────────────────────────────────┘   │
  │                                               │
  │   ┌─────────────────────┐  ┌──────────────┐  │
  │   │  SchemaValidator    │  │ IndexManager  │  │
  │   │                     │  │              │  │
  │   │  Validates inserts  │  │ Unique and   │  │
  │   │  and updates.       │  │ non-unique   │  │
  │   │  Generates values.  │  │ secondary    │  │
  │   │  Attaches metadata. │  │ indexes.     │  │
  │   └─────────────────────┘  └──────────────┘  │
  │                                               │
  │   autoincrementCounter: number                │
  │                                               │
  └─────────────────────────────────────────────┘
```

| Component | Type | Purpose |
|-----------|------|---------|
| `table` | `Map<unknown, StoreRecord>` | Primary data storage, keyed by primary key value |
| `validator` | `SchemaValidator` | Validates data against the schema, generates auto values, attaches metadata |
| `indexManager` | `IndexManager` | Maintains secondary indexes (unique and non-unique) for fast lookups |
| `autoincrementCounter` | `number` | Tracks the next value for `generated: 'autoincrement'` fields |

All four live inside the GenServer's state. They're never shared with other actors — each bucket has its own validator, index manager, and data map.

### Message Protocol

The BucketServer communicates exclusively through `GenServer.call()` — a synchronous request/reply mechanism. The caller sends a message and awaits the response:

```text
  BucketHandle                          BucketServer (GenServer)
       │                                       │
       │  GenServer.call(ref, {               │
       │    type: 'insert',                    │
       │    data: { name: 'Alice' }            │
       │  })                                   │
       │──────────────────────────────────────►│
       │                                       │  1. Validate schema
       │                                       │  2. Generate values
       │                                       │  3. Update indexes
       │                                       │  4. Store in table
       │                                       │  5. Publish event
       │                                       │
       │◄──────────────────────────────────────│
       │  reply: StoreRecord                   │
```

The full set of message types:

| Category | Messages |
|----------|----------|
| **CRUD** | `insert`, `get`, `update`, `delete`, `clear` |
| **Query** | `all`, `where`, `findOne`, `count`, `first`, `last`, `paginate` |
| **Aggregation** | `sum`, `avg`, `min`, `max` |
| **Lifecycle** | `purgeExpired`, `getSnapshot`, `getStats` |
| **Transaction** | `commitBatch`, `rollbackBatch`, `getAutoincrementCounter` |

Every message goes through the same mailbox. There's no priority queue — a `get` waits behind a `commitBatch` if it arrived later.

## BucketHandle: The Stateless Proxy

The BucketHandle is what you interact with in application code. It's a thin wrapper that sends messages to the BucketServer:

```text
  Application Code            BucketHandle              BucketServer
        │                          │                          │
        │  users.insert(data)      │                          │
        │─────────────────────────►│                          │
        │                          │  GenServer.call(ref,     │
        │                          │    { type: 'insert',     │
        │                          │      data })             │
        │                          │─────────────────────────►│
        │                          │                          │  (process)
        │                          │◄─────────────────────────│
        │                          │  reply: StoreRecord      │
        │◄─────────────────────────│                          │
        │  return StoreRecord      │                          │
```

The BucketHandle holds only two things: the bucket name and a reference to the GenServer. Creating multiple handles to the same bucket is free — they all point to the same actor:

```typescript
const a = store.bucket('users');
const b = store.bucket('users');
// a and b both send messages to the same BucketServer actor
// No duplication of data or state
```

## Process Registration and Naming

Every actor in the tree is registered with a name for debugging and monitoring:

| Actor | Name Pattern | Example |
|-------|-------------|---------|
| EventBus | `{storeName}:events` | `app:events` |
| Supervisor | `{storeName}:supervisor` | `app:supervisor` |
| BucketServer | `{storeName}:bucket:{bucketName}` | `app:bucket:users` |

These names appear in logs and error messages. When a BucketServer crashes, you see exactly which bucket failed:

```text
[Supervisor] Child "app:bucket:sessions" crashed: ValidationError: ...
[Supervisor] Restarting child "app:bucket:sessions" (one_for_one)
```

## Dynamic Tree Modification

The supervision tree is not static. You can add and remove buckets at runtime.

### Adding a Bucket: `defineBucket()`

```text
  store.defineBucket('products', definition)
        │
        ├── 1. Check: bucket name not already registered
        │
        ├── 2. Load persisted data (if persistence enabled)
        │
        ├── 3. Create BucketServer behavior
        │       (SchemaValidator, IndexManager, initial data)
        │
        ├── 4. Supervisor.startChild()
        │       → Starts GenServer with the behavior
        │       → Registers as "app:bucket:products"
        │
        ├── 5. Register with StorePersistence (if applicable)
        │
        └── 6. Register with TtlManager (if ttl is set)
```

Each step is sequential. The bucket is not available for CRUD until all steps complete. If the bucket name is already taken, `defineBucket()` throws `BucketAlreadyExistsError`.

### Removing a Bucket: `dropBucket()`

```text
  store.dropBucket('products')
        │
        ├── 1. Unregister from TtlManager
        │
        ├── 2. Unregister from StorePersistence
        │
        ├── 3. Supervisor.terminateChild('products')
        │       → Stops the GenServer gracefully
        │       → Removes from supervisor's child list
        │
        └── 4. Remove from store's internal maps
```

After `dropBucket()`, the actor is terminated and its data is gone (unless persisted). Calling `store.bucket('products')` after this throws `BucketNotDefinedError`.

## Graceful Shutdown

When you call `store.stop()`, the shutdown propagates through the tree in a specific order:

```text
  store.stop()
        │
        ├── 1. Stop TtlManager
        │       → Cancel pending setTimeout
        │       → No more purge cycles
        │
        ├── 2. Flush StorePersistence
        │       → Mark all buckets dirty
        │       → Save snapshots immediately (no debounce)
        │       → Close adapter
        │
        ├── 3. Stop Supervisor
        │       → Terminates all BucketServer children
        │       → Each GenServer processes remaining messages, then exits
        │
        └── 4. Stop EventBus
                → No more event delivery
```

The order matters. Persistence flushes **before** the supervisor stops BucketServers — otherwise, the snapshots would contain stale data (or the buckets would already be gone). The EventBus stops **last** because persistence and other components may publish events during shutdown.

## Complete Working Example

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  // 1. Start the store — creates Supervisor, EventBus, TtlManager
  const store = await Store.start({ name: 'demo' });

  // 2. Define buckets — each starts a BucketServer under the Supervisor
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
      id:      { type: 'number', generated: 'autoincrement' },
      action:  { type: 'string', required: true },
      userId:  { type: 'string', required: true },
    },
    indexes: ['userId'],
    ttl: '7d',
    maxSize: 100_000,
  });

  // The process tree now looks like:
  //
  //   Store "demo"
  //     ├── EventBus ("demo:events")
  //     ├── Supervisor ("demo:supervisor")
  //     │     ├── BucketServer ("demo:bucket:users")
  //     │     └── BucketServer ("demo:bucket:logs")
  //     ├── TtlManager (watching "logs")
  //     └── QueryManager

  // 3. Use buckets — messages go through BucketHandle → GenServer.call → BucketServer
  const users = store.bucket('users');
  const logs = store.bucket('logs');

  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  await logs.insert({ action: 'user.created', userId: alice.id as string });

  // 4. Check stats — each BucketServer reports its own stats
  const stats = await store.getStats();
  console.log('Total buckets:', stats.buckets.length);    // 2
  console.log('Users count:', stats.buckets[0].recordCount); // 1
  console.log('Logs count:', stats.buckets[1].recordCount);  // 1

  // 5. Drop a bucket — removes it from the supervisor
  await store.dropBucket('logs');

  // The tree is now:
  //   Supervisor
  //     └── BucketServer ("demo:bucket:users")

  // store.bucket('logs') would throw BucketNotDefinedError

  // 6. Graceful shutdown
  await store.stop();
}

main();
```

## How Fault Isolation Works

Consider what happens when a BucketServer encounters an unrecoverable error:

```text
  Time    BucketServer "users"    BucketServer "orders"    Supervisor
  ─────  ──────────────────────  ───────────────────────  ────────────────
  t=0    Processing insert       Processing where         Monitoring
  t=1    *** CRASH ***           Processing where         Detects crash
  t=2    (dead)                  Serving get request      Restarts "users"
  t=3    Reinitializing...       Serving update           Waiting for init
  t=4    Ready (empty state)     Serving insert           Child registered
```

Key observations:

1. **No cascade**: The orders bucket never noticed the users bucket crashed. Its mailbox, state, and processing continue uninterrupted.
2. **Automatic restart**: The supervisor detects the crash and restarts the BucketServer with a fresh state (empty table, reset indexes).
3. **Data loss**: The restarted bucket starts empty. If persistence is enabled, the bucket reloads its last snapshot — but any writes between the last snapshot and the crash are lost.
4. **Pending requests fail**: Any `GenServer.call()` that was in-flight to the crashed BucketServer receives an error. The caller's `await` rejects with the error.

## Exercise

You're designing a store for a multi-tenant SaaS application. Each tenant has their own `projects` bucket and a shared `auditLog` bucket. There are 50 tenants.

1. How would you structure the bucket names so that each tenant's data is isolated?
2. If tenant #23's projects bucket crashes, what happens to the other 49 tenants' projects buckets?
3. If the `auditLog` bucket crashes, does it affect any tenant's `projects` bucket?
4. You need to add a new tenant at runtime (tenant #51 signs up). How do you add their bucket without restarting the store?
5. A tenant cancels their subscription. How do you remove their bucket and free memory?

<details>
<summary>Solution</summary>

**1. Naming convention:**

Use a prefix convention like `tenant:{id}:projects`:

```typescript
for (let i = 1; i <= 50; i++) {
  await store.defineBucket(`tenant:${i}:projects`, {
    key: 'id',
    schema: {
      id:   { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
    },
  });
}

await store.defineBucket('auditLog', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    tenantId: { type: 'number', required: true },
    action:   { type: 'string', required: true },
  },
  indexes: ['tenantId'],
  ttl: '90d',
});
```

Each tenant gets a separate BucketServer under the supervisor. The naming convention `tenant:{id}:projects` makes it clear which actor belongs to which tenant.

**2. Tenant #23 crashes:**

Nothing happens to the other 49 tenants. The supervisor uses `one_for_one` — only `tenant:23:projects` is restarted. Tenants 1-22 and 24-50 continue operating without interruption.

**3. auditLog crashes:**

No effect on any tenant's `projects` bucket. The auditLog is a separate child under the same supervisor. Its crash triggers a restart of the auditLog BucketServer only.

**4. Adding a new tenant at runtime:**

```typescript
await store.defineBucket('tenant:51:projects', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});
// The supervisor now has 52 children (51 tenant buckets + auditLog)
```

`defineBucket()` calls `Supervisor.startChild()` under the hood — no restart needed.

**5. Removing a tenant:**

```typescript
await store.dropBucket('tenant:42:projects');
// The supervisor now has 51 children
// The BucketServer is terminated and its data is freed
```

`dropBucket()` calls `Supervisor.terminateChild()`, stops the GenServer, and removes the registration.

</details>

## Summary

- noex-store is built on the **actor model** from `@hamicek/noex` — each bucket is a GenServer process managed by a Supervisor
- The **Supervisor** uses `one_for_one` strategy: when a BucketServer crashes, only that bucket is restarted — other buckets are unaffected
- Each **BucketServer** encapsulates a data Map, SchemaValidator, IndexManager, and autoincrement counter — nothing is shared between buckets
- The **BucketHandle** is a stateless proxy that delegates every operation to `GenServer.call()` — creating handles is free
- Every actor is registered with a **name** (`{store}:bucket:{name}`) for logging and debugging
- **`defineBucket()`** dynamically adds a BucketServer to the supervision tree; **`dropBucket()`** removes and terminates it
- **Graceful shutdown** propagates in order: TtlManager stops, persistence flushes, supervisor terminates children, EventBus stops last
- If a BucketServer crashes, pending requests fail, the bucket restarts empty (or from the last persistence snapshot), and sibling buckets continue uninterrupted

---

Next: [Data Flow](./02-data-flow.md)
