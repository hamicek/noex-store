# Recovery and Snapshots

Your application crashed at 3 AM. The process restarts automatically, but the store starts empty. Users inserted records, updated settings, and placed orders — all of it needs to be back in memory before the first request hits. You also need autoincrement counters to continue from where they left off, indexes to be queryable, and unique constraints to be enforced. Manually orchestrating this recovery is error-prone and tightly couples your startup logic to every bucket's internal state.

noex-store handles recovery automatically. When you call `defineBucket()` on a persistence-enabled store, the store loads the last snapshot from the adapter, populates the bucket's in-memory table, rebuilds all indexes, and restores the autoincrement counter. No manual intervention required.

## What You'll Learn

- How the recovery flow works when a store restarts
- What a `BucketSnapshot` contains and how it's captured
- How indexes and unique constraints are rebuilt from restored data
- How autoincrement counters maintain continuity across restarts
- How `store.stop()` guarantees a final flush before shutdown
- How to reason about the data loss window

## The Recovery Flow

When a bucket is defined on a store with persistence, recovery happens inside `defineBucket()`:

```text
  store.defineBucket('users', definition)
      |
      v
  Is persistence enabled AND persistent !== false?
      |
      yes
      |
      v
  adapter.load('my-app:bucket:users')
      |
      +-- found snapshot ──> Extract records + autoincrementCounter
      |                            |
      |                            v
      |                      Initialize BucketServer with restored data:
      |                        - Populate in-memory Map with records
      |                        - Set autoincrementCounter
      |                        - Rebuild all indexes from records
      |                            |
      |                            v
      |                      Register bucket with persistence layer
      |
      +-- no snapshot ──> Start empty bucket (normal init)
      |
      +-- adapter error ──> Report via onError, start empty bucket
```

### Key Properties

| Property | Behavior |
|----------|----------|
| **Silent restore** | No events are emitted during recovery — the EventBus doesn't see the restored records as inserts |
| **Automatic index rebuild** | Every restored record is fed through `IndexManager.addRecord()`, rebuilding secondary indexes and unique indexes |
| **Autoincrement continuity** | The counter resumes from the persisted value — no ID collisions |
| **No re-validation** | Restored records are assumed valid (they were validated on original insert/update) |
| **Graceful degradation** | If loading fails, the bucket starts empty and the error is reported via `onError` |

## BucketSnapshot

A `BucketSnapshot` is the atomic representation of a bucket's complete state at a point in time:

```typescript
interface BucketSnapshot {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `records` | `Array<[key, StoreRecord]>` | All records as key-value tuples |
| `autoincrementCounter` | `number` | Current value of the autoincrement sequence |

### How Snapshots Are Captured

Snapshots are captured via a GenServer call to the BucketServer. This guarantees atomicity — the snapshot reflects the exact state at the moment the call is processed, with no concurrent mutations interleaved:

```text
  StorePersistence                    BucketServer
       |                                   |
       |  GenServer.call({ type: 'getSnapshot' })
       |---------------------------------->|
       |                                   |
       |                                   |  Process message:
       |                                   |    - Read all entries from Map
       |                                   |    - Read autoincrementCounter
       |                                   |    - Return BucketSnapshot
       |                                   |
       |  BucketSnapshot                   |
       |<----------------------------------|
       |                                   |
       |  adapter.save(key, snapshot)       |
       |                                   |
```

The GenServer's mailbox-based concurrency model ensures that the snapshot is consistent — if an insert is in progress, it either completes before the snapshot or is captured in the next one.

### What Gets Persisted

The snapshot is wrapped in a `PersistedState` envelope with metadata:

```text
  adapter.save("my-app:bucket:users", {
    state: {
      records: [
        ["id-1", { id: "id-1", name: "Alice", _version: 2, _createdAt: ..., _updatedAt: ... }],
        ["id-2", { id: "id-2", name: "Bob",   _version: 1, _createdAt: ..., _updatedAt: ... }],
      ],
      autoincrementCounter: 0
    },
    metadata: {
      persistedAt: 1704067200000,
      serverId: "my-app",
      schemaVersion: 1
    }
  })
```

The storage key format is `<storeName>:bucket:<bucketName>`. Each bucket is stored independently — loading `users` doesn't require loading `orders`.

## Index Rebuild

During recovery, the BucketServer iterates all restored records and adds them to the `IndexManager`:

```text
  Restored records: [Alice, Bob, Carol]
  Definition: indexes: ['email', 'role'], email has unique: true

  For each record:
    indexManager.addRecord(key, record)
      |
      +-- Secondary index 'email':  email -> Set<key>
      +-- Secondary index 'role':   role  -> Set<key>
      +-- Unique index 'email':     email -> key  (enforces uniqueness)
```

After recovery, queries using indexed fields work at full speed — no degradation compared to a store that never restarted:

```typescript
// After restart — indexes are rebuilt from the snapshot
const admins = await store.bucket('users').where({ role: 'admin' });
// Uses the rebuilt 'role' index, not a full scan

// Unique constraints are enforced from rebuilt unique index
await store.bucket('users').insert({ name: 'Fake', email: 'alice@example.com' });
// Throws UniqueConstraintError — the unique index was rebuilt from the snapshot
```

## Autoincrement Continuity

The autoincrement counter is part of the snapshot. After a restart, new records get the next sequential ID:

```typescript
import { Store } from '@hamicek/noex-store';
import { MemoryAdapter } from '@hamicek/noex';

const adapter = new MemoryAdapter();

// First run: insert 3 orders (IDs: 1, 2, 3)
const store1 = await Store.start({
  name: 'shop',
  persistence: { adapter },
});

await store1.defineBucket('orders', {
  key: 'id',
  schema: {
    id:      { type: 'number', generated: 'autoincrement' },
    product: { type: 'string', required: true },
  },
});

await store1.bucket('orders').insert({ product: 'Widget' });  // id: 1
await store1.bucket('orders').insert({ product: 'Gadget' });  // id: 2
await store1.bucket('orders').insert({ product: 'Gizmo' });   // id: 3
await store1.stop();

// Second run: counter continues from 3
const store2 = await Store.start({
  name: 'shop',
  persistence: { adapter },
});

await store2.defineBucket('orders', {
  key: 'id',
  schema: {
    id:      { type: 'number', generated: 'autoincrement' },
    product: { type: 'string', required: true },
  },
});

const next = await store2.bucket('orders').insert({ product: 'Doohickey' });
console.log(next.id); // 4 — not 1

await store2.stop();
```

Without autoincrement persistence, the counter would reset to 0 and the next insert would get `id: 1`, colliding with the existing record.

## The Shutdown Flush

When `store.stop()` is called, the persistence layer performs a final flush of all registered buckets — not just the dirty ones. This guarantees that the last state is saved even for buckets that were modified less than `debounceMs` ago:

```text
  store.stop()
      |
      v
  1. Stop TtlManager (no more expiration checks)
  2. Destroy QueryManager (no more reactive subscriptions)
  3. Unsubscribe from EventBus
      |
      v
  4. StorePersistence.stop()
      |
      v
     4a. Mark ALL registered buckets as dirty
     4b. Flush (cancel debounce timer, persist all dirty)
     4c. Unsubscribe from EventBus
     4d. Close adapter (if adapter.close exists)
      |
      v
  5. Stop Supervisor (terminates all BucketServers)
  6. Stop EventBus
```

The order is critical: persistence flushes **before** the Supervisor stops. The flush needs to send `getSnapshot` messages to live BucketServers. If the Supervisor stopped first, the GenServer calls would fail and data would be lost.

```typescript
// Mutations right before shutdown are safe
await store.bucket('users').insert({ name: 'Last-minute insert' });
await store.stop(); // Flushes this insert to the adapter
```

## The Data Loss Window

Between debounce flushes, there's a window where mutations exist only in memory. If the process crashes during this window, those mutations are lost:

```text
  Timeline:
  ─────────────────────────────────────────────────>

  t=0     insert('Alice')    -> dirty, timer starts
  t=30    insert('Bob')      -> dirty
  t=100   FLUSH              -> Alice + Bob saved ✓
  t=130   insert('Carol')    -> dirty, timer starts
  t=150   CRASH!             -> Carol lost ✗
```

### Reducing the Window

| Strategy | Trade-off |
|----------|-----------|
| Lower `debounceMs` (e.g., 10) | More frequent writes, higher I/O |
| Use `SQLiteAdapter` | Atomic writes, no partial file corruption |
| Accept the default (100ms) | Good balance for most workloads |

There is no per-operation sync write option by design. The debounce model optimizes for throughput over per-operation durability — if you need strict durability guarantees for every write, use an external database as the source of truth and the store as a cache layer.

## Persistence with Transactions

Transactions interact naturally with persistence. When a transaction commits, it applies all buffered writes to the real buckets. Each bucket emits events for the applied mutations. The persistence layer receives these events and marks the affected buckets as dirty:

```text
  store.transaction(async (tx) => {
    txCustomers.insert(...)   // buffered
    txOrders.insert(...)      // buffered
  })
      |
      v
  Commit: apply to real buckets
      |
      v
  Events emitted: bucket.customers.inserted, bucket.orders.inserted
      |
      v
  StorePersistence: mark 'customers' dirty, mark 'orders' dirty
      |
      v
  Debounce timer fires -> snapshot both buckets
```

A failed transaction emits no events, so the persistence layer is never triggered — consistent with the "nothing happened" semantics of a rolled-back transaction.

## Complete Working Example

An inventory system that demonstrates recovery, index rebuild, autoincrement continuity, and per-bucket opt-out:

```typescript
import { Store, UniqueConstraintError } from '@hamicek/noex-store';
import { MemoryAdapter } from '@hamicek/noex';

async function main() {
  const adapter = new MemoryAdapter();

  // === First run: populate the store ===

  const store1 = await Store.start({
    name: 'inventory',
    persistence: { adapter },
  });

  await store1.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:      { type: 'string', required: true },
      name:     { type: 'string', required: true },
      price:    { type: 'number', required: true, min: 0 },
      category: { type: 'string', required: true },
    },
    indexes: ['category'],
  });

  await store1.defineBucket('orders', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      sku:      { type: 'string', required: true },
      quantity: { type: 'number', required: true, min: 1 },
    },
    indexes: ['sku'],
  });

  await store1.defineBucket('viewCount', {
    key: 'sku',
    schema: {
      sku:   { type: 'string', required: true },
      views: { type: 'number', required: true },
    },
    persistent: false, // Ephemeral analytics — not persisted
  });

  // Insert products
  await store1.bucket('products').insert({
    sku: 'LAPTOP-1', name: 'Pro Laptop', price: 1299, category: 'electronics',
  });
  await store1.bucket('products').insert({
    sku: 'MOUSE-1', name: 'Wireless Mouse', price: 49, category: 'electronics',
  });
  await store1.bucket('products').insert({
    sku: 'DESK-1', name: 'Standing Desk', price: 599, category: 'furniture',
  });

  // Insert orders (IDs: 1, 2, 3)
  await store1.bucket('orders').insert({ sku: 'LAPTOP-1', quantity: 1 });
  await store1.bucket('orders').insert({ sku: 'MOUSE-1', quantity: 5 });
  await store1.bucket('orders').insert({ sku: 'LAPTOP-1', quantity: 2 });

  // Insert view counts (ephemeral)
  await store1.bucket('viewCount').insert({ sku: 'LAPTOP-1', views: 1500 });

  console.log('=== First run ===');
  console.log(`Products: ${await store1.bucket('products').count()}`);
  console.log(`Orders: ${await store1.bucket('orders').count()}`);
  console.log(`View counts: ${await store1.bucket('viewCount').count()}`);

  await store1.stop();

  // === Second run: verify recovery ===

  const store2 = await Store.start({
    name: 'inventory',
    persistence: { adapter },
  });

  await store2.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:      { type: 'string', required: true },
      name:     { type: 'string', required: true },
      price:    { type: 'number', required: true, min: 0 },
      category: { type: 'string', required: true },
    },
    indexes: ['category'],
  });

  await store2.defineBucket('orders', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      sku:      { type: 'string', required: true },
      quantity: { type: 'number', required: true, min: 1 },
    },
    indexes: ['sku'],
  });

  await store2.defineBucket('viewCount', {
    key: 'sku',
    schema: {
      sku:   { type: 'string', required: true },
      views: { type: 'number', required: true },
    },
    persistent: false,
  });

  console.log('\n=== Second run (after restart) ===');

  // 1. Data restored
  console.log(`Products: ${await store2.bucket('products').count()}`);   // 3
  console.log(`Orders: ${await store2.bucket('orders').count()}`);       // 3
  console.log(`View counts: ${await store2.bucket('viewCount').count()}`); // 0 (not persisted)

  // 2. Indexes work
  const electronics = await store2.bucket('products').where({ category: 'electronics' });
  console.log(`Electronics: ${electronics.map((p) => p.name).join(', ')}`);

  const laptopOrders = await store2.bucket('orders').where({ sku: 'LAPTOP-1' });
  console.log(`Laptop orders: ${laptopOrders.length}`); // 2

  // 3. Autoincrement continuity
  const newOrder = await store2.bucket('orders').insert({ sku: 'DESK-1', quantity: 1 });
  console.log(`New order ID: ${newOrder.id}`); // 4 (continues from 3)

  // 4. Record metadata preserved
  const laptop = await store2.bucket('products').get('LAPTOP-1');
  console.log(`Laptop version: ${laptop?._version}`);       // 1
  console.log(`Laptop created: ${laptop?._createdAt}`);      // Original timestamp

  // 5. Store is fully functional after recovery
  await store2.bucket('products').update('LAPTOP-1', { price: 1199 });
  const updated = await store2.bucket('products').get('LAPTOP-1');
  console.log(`Laptop price: $${updated?.price}, version: ${updated?._version}`); // $1199, version 2

  await store2.stop();
}

main();
```

## Exercise

You're building a task tracker. The store persists tasks with autoincrement IDs and a non-persistent `activityLog` bucket that tracks user actions.

```typescript
const adapter = new MemoryAdapter();

const store = await Store.start({
  name: 'task-tracker',
  persistence: { adapter },
});

await store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:          { type: 'number', generated: 'autoincrement' },
    title:       { type: 'string', required: true },
    status:      { type: 'string', enum: ['todo', 'in-progress', 'done'], default: 'todo' },
    assignee:    { type: 'string' },
  },
  indexes: ['status', 'assignee'],
});

await store.defineBucket('activityLog', {
  key: 'id',
  schema: {
    id:        { type: 'number', generated: 'autoincrement' },
    action:    { type: 'string', required: true },
    taskId:    { type: 'number', required: true },
    timestamp: { type: 'number', generated: 'timestamp' },
  },
  persistent: false,
});
```

1. Insert 3 tasks: "Design mockups" (todo, assignee: "Alice"), "Write tests" (in-progress, assignee: "Bob"), "Deploy v2" (todo).
2. Log an activity for each task insert (e.g., action: "created", taskId: the task's ID).
3. Stop the store and restart it with the same adapter. Re-define both buckets.
4. After restart: How many tasks exist? What is the next autoincrement ID for tasks? How many activity log entries exist?
5. After restart, query tasks with `status: 'todo'`. Does the index work?
6. Insert a new task. What ID does it get?

<details>
<summary>Solution</summary>

```typescript
const tasks = store.bucket('tasks');
const log = store.bucket('activityLog');

// 1. Insert tasks
const t1 = await tasks.insert({ title: 'Design mockups', status: 'todo', assignee: 'Alice' });
const t2 = await tasks.insert({ title: 'Write tests', status: 'in-progress', assignee: 'Bob' });
const t3 = await tasks.insert({ title: 'Deploy v2', status: 'todo' });

// 2. Log activities
await log.insert({ action: 'created', taskId: t1.id as number });
await log.insert({ action: 'created', taskId: t2.id as number });
await log.insert({ action: 'created', taskId: t3.id as number });

console.log(`Tasks: ${await tasks.count()}`);         // 3
console.log(`Activity log: ${await log.count()}`);     // 3

// 3. Restart
await store.stop();

const store2 = await Store.start({
  name: 'task-tracker',
  persistence: { adapter },
});

await store2.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    title:    { type: 'string', required: true },
    status:   { type: 'string', enum: ['todo', 'in-progress', 'done'], default: 'todo' },
    assignee: { type: 'string' },
  },
  indexes: ['status', 'assignee'],
});

await store2.defineBucket('activityLog', {
  key: 'id',
  schema: {
    id:        { type: 'number', generated: 'autoincrement' },
    action:    { type: 'string', required: true },
    taskId:    { type: 'number', required: true },
    timestamp: { type: 'number', generated: 'timestamp' },
  },
  persistent: false,
});

const tasks2 = store2.bucket('tasks');
const log2 = store2.bucket('activityLog');

// 4. After restart
console.log(`Tasks after restart: ${await tasks2.count()}`);         // 3
console.log(`Activity log after restart: ${await log2.count()}`);     // 0 (not persisted)

// 5. Index query works — rebuilt from snapshot
const todoTasks = await tasks2.where({ status: 'todo' });
console.log(`Todo tasks: ${todoTasks.length}`); // 2 (Design mockups, Deploy v2)
console.log(todoTasks.map((t) => t.title));
// Yes, the index works because it was rebuilt from restored records during defineBucket().

// 6. New task gets ID 4 (autoincrement counter restored from snapshot)
const t4 = await tasks2.insert({ title: 'Write docs', assignee: 'Carol' });
console.log(`New task ID: ${t4.id}`); // 4

await store2.stop();
```

</details>

## Summary

- **Recovery is automatic**: calling `defineBucket()` on a persistence-enabled store loads the last snapshot, populates the in-memory table, rebuilds indexes, and restores the autoincrement counter
- **`BucketSnapshot`** contains all records as key-value tuples and the autoincrement counter — it's the complete bucket state
- Snapshots are captured **atomically** via a GenServer call — no concurrent mutations can interleave during capture
- **Indexes are rebuilt** from restored records, including unique indexes — `where()` queries and unique constraints work immediately after recovery
- **Autoincrement counters** continue from the persisted value — no ID collisions after restart
- **No events are emitted** during recovery — the EventBus doesn't see restored records as inserts
- **`store.stop()`** performs a final flush of **all** registered buckets before shutting down — persistence flushes before the Supervisor stops BucketServers
- The **data loss window** equals `debounceMs` — mutations within the last debounce interval before a crash may be lost
- **Load errors** result in graceful degradation — the bucket starts empty and the error is reported via `onError`
- Transactions interact naturally — committed writes trigger events, which trigger persistence; rolled-back transactions trigger nothing

---

Next: [TTL Expiration](../09-ttl-lifecycle/01-ttl-expiration.md)
