# Key Concepts

Before diving into code, let's establish a clear mental model of how noex-store works. The library has a small number of core concepts that compose into a powerful data management layer. Understanding them now will make everything else straightforward.

## What You'll Learn

- How Store, Buckets, and BucketHandles relate to each other
- What schemas and records are and why every record carries metadata
- How the event system notifies subscribers of changes
- What reactive queries do and how they differ from one-time reads
- How transactions provide atomicity across multiple buckets
- The role of TTL, persistence, and the supervision tree

## The Store at a Glance

```text
                       ┌─────────────────────────────────────────────────────┐
                       │                       STORE                          │
                       │                                                      │
                       │   ┌──────────┐   ┌──────────┐   ┌──────────┐       │
   store.bucket(name)──┼──►│  Bucket  │   │  Bucket  │   │  Bucket  │       │
                       │   │  Server  │   │  Server  │   │  Server  │       │
                       │   │ (actor)  │   │ (actor)  │   │ (actor)  │       │
                       │   └────┬─────┘   └────┬─────┘   └────┬─────┘       │
                       │        │              │              │              │
                       │        ▼              ▼              ▼              │
                       │   ┌────────────────────────────────────────┐        │
                       │   │              EVENT BUS                  │        │
                       │   │  bucket.users.inserted                 │        │
                       │   │  bucket.orders.updated                 │        │
                       │   │  bucket.sessions.deleted               │        │
                       │   └────────┬───────────────┬───────────────┘        │
                       │            │               │                        │
                       │            ▼               ▼                        │
                       │   ┌──────────────┐  ┌──────────────┐               │
                       │   │   Reactive   │  │  Persistence │               │
                       │   │   Queries    │  │   Layer      │               │
                       │   └──────────────┘  └──────────────┘               │
                       │                                                      │
                       │   ┌──────────────┐  ┌──────────────┐               │
                       │   │  TTL Manager │  │  Supervisor  │               │
                       │   └──────────────┘  └──────────────┘               │
                       └─────────────────────────────────────────────────────┘
```

The Store is the entry point. It creates and manages buckets, routes events, handles reactive queries, and coordinates transactions. Each bucket is an isolated actor (GenServer) with its own schema, indexes, and data.

## Store

The Store is the top-level container. You start it, define buckets in it, and use it to access every other feature:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'my-app' });

// Define collections
await store.defineBucket('users', { /* … */ });
await store.defineBucket('orders', { /* … */ });

// Access collections
const users = store.bucket('users');

// Transactions, queries, events, stats…
await store.transaction(async (tx) => { /* … */ });
store.defineQuery('topUsers', async (ctx) => { /* … */ });
await store.on('bucket.*.*', (event) => { /* … */ });
const stats = await store.getStats();

// Clean shutdown
await store.stop();
```

### Store Lifecycle

```text
  Store.start(options)
        │
        ▼
  ┌─────────────┐     defineBucket()     ┌─────────────┐
  │   RUNNING   │ ─────────────────────► │  + Bucket    │
  │             │ ◄───────────────────── │    Server    │
  │  EventBus   │     dropBucket()       └─────────────┘
  │  Supervisor │
  │  TTL Manager│
  │  Queries    │
  └──────┬──────┘
         │
         │  store.stop()
         ▼
  ┌─────────────┐
  │   STOPPED   │  Persistence flushed, actors terminated
  └─────────────┘
```

The `start()` method initializes the event bus, supervisor, TTL manager, and (optionally) persistence. Buckets are added dynamically with `defineBucket()`. The `stop()` method flushes persistence, terminates all bucket actors, and shuts down the event bus.

## Buckets and BucketHandles

A **bucket** is a named, schema-enforced collection of records — similar to a table in a database. Each bucket runs as an independent actor (GenServer) managed by a supervisor.

A **BucketHandle** is a lightweight, stateless proxy that sends messages to the bucket's actor. Creating a handle is free — it holds no state itself:

```typescript
// Define the bucket (this starts the actor)
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', format: 'email', unique: true },
  },
  indexes: ['email'],
});

// Get a handle (stateless proxy — cheap to create)
const users = store.bucket('users');

// CRUD operations via the handle
const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
const found = await users.get(alice.id);
await users.update(alice.id, { name: 'Alice Smith' });
await users.delete(alice.id);
```

### Bucket Definition

Every bucket has a `key` (primary key field) and a `schema` (field definitions). Optional features are declared in the same object:

| Property | Purpose | Example |
|----------|---------|---------|
| `key` | Primary key field name | `'id'` |
| `schema` | Field definitions with types and constraints | `{ id: { type: 'string' } }` |
| `indexes` | Secondary indexes for fast lookups | `['email', 'role']` |
| `ttl` | Time-to-live before automatic expiration | `'1h'`, `'7d'`, `30000` |
| `maxSize` | Maximum records; oldest evicted when full | `10_000` |
| `persistent` | Opt out of persistence (when store-level is enabled) | `false` |

## Schemas

A schema declares the shape of every record in a bucket. Each field has a type and optional constraints:

```typescript
{
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    name:      { type: 'string', required: true, minLength: 1, maxLength: 100 },
    email:     { type: 'string', format: 'email', unique: true },
    age:       { type: 'number', min: 0, max: 150 },
    role:      { type: 'string', enum: ['admin', 'user', 'guest'], default: 'user' },
    bio:       { type: 'string', pattern: '^[A-Za-z]' },
    tags:      { type: 'array', default: [] },
    settings:  { type: 'object', default: {} },
    active:    { type: 'boolean', default: true },
    birthDate: { type: 'date' },
  },
}
```

### Field Types

| Type | JavaScript Type | Example Values |
|------|----------------|----------------|
| `string` | `string` | `'hello'`, `''` |
| `number` | `number` | `42`, `3.14` |
| `boolean` | `boolean` | `true`, `false` |
| `object` | `Record<string, unknown>` | `{ theme: 'dark' }` |
| `array` | `unknown[]` | `['a', 'b']` |
| `date` | `string` (ISO-8601) | `'2025-01-15'` |

### Constraints and Features

| Constraint | Applies To | Purpose |
|------------|-----------|---------|
| `required` | All types | Field must be present and non-undefined |
| `enum` | All types | Value must be one of the listed options |
| `default` | All types | Static value or `() => value` function |
| `generated` | `string`, `number` | Auto-generated: `uuid`, `cuid`, `autoincrement`, `timestamp` |
| `unique` | All types | Enforced uniqueness via automatic index |
| `min` / `max` | `number` | Numeric range |
| `minLength` / `maxLength` | `string` | String length range |
| `pattern` | `string` | Regular expression |
| `format` | `string` | Built-in format: `email`, `url`, `iso-date` |

When a write violates any constraint, the store throws a `ValidationError` with a detailed list of issues — the record is never stored.

## Records and Metadata

Every record in the store carries automatic metadata fields:

```typescript
const user = await users.insert({ name: 'Alice', email: 'alice@example.com' });

console.log(user);
// {
//   id: 'a1b2c3d4-…',            ← generated UUID
//   name: 'Alice',
//   email: 'alice@example.com',
//   role: 'user',                  ← default value applied
//   _version: 1,                   ← incremented on each update
//   _createdAt: 1706745600000,     ← Unix ms at insertion
//   _updatedAt: 1706745600000,     ← Unix ms, updated on each write
// }
```

| Field | Set On | Purpose |
|-------|--------|---------|
| `_version` | Insert (1), update (+1) | Optimistic concurrency control in transactions |
| `_createdAt` | Insert | When the record was first created (Unix ms) |
| `_updatedAt` | Insert, update | When the record was last modified (Unix ms) |
| `_expiresAt` | Insert (TTL-enabled buckets only) | When the record will be purged (Unix ms) |

Metadata fields cannot be set or overridden by application code. They are managed exclusively by the store.

## Events

Every mutation (insert, update, delete) publishes an event to the store's event bus. Events follow the topic format `bucket.{name}.{type}`:

```typescript
// Subscribe to all events on the "users" bucket
await store.on('bucket.users.*', (event, topic) => {
  console.log(topic, event.type, event.key);
});

await users.insert({ name: 'Alice', email: 'alice@example.com' });
// bucket.users.inserted  inserted  a1b2c3d4-…

await users.update(alice.id, { name: 'Alice Smith' });
// bucket.users.updated  updated  a1b2c3d4-…

await users.delete(alice.id);
// bucket.users.deleted  deleted  a1b2c3d4-…
```

### Event Types

| Event | Payload | Trigger |
|-------|---------|---------|
| `inserted` | `{ bucket, key, record }` | After a successful insert |
| `updated` | `{ bucket, key, oldRecord, newRecord }` | After a successful update |
| `deleted` | `{ bucket, key, record }` | After a successful delete |

### Wildcard Patterns

| Pattern | Matches |
|---------|---------|
| `bucket.users.inserted` | Only insert events on `users` |
| `bucket.users.*` | All events on `users` |
| `bucket.*.*` | All events on all buckets |
| `bucket.*.deleted` | Delete events on all buckets |

Events are the foundation for reactive queries, persistence, and external integrations.

## Reactive Queries

A reactive query is a named function that reads data from one or more buckets. When you subscribe, the engine tracks which buckets (and which records) the query accessed. If any of those change, the query re-executes and delivers the new result.

```text
  defineQuery('stats', fn)           subscribe('stats', callback)
        │                                     │
        ▼                                     ▼
  ┌──────────────┐                   ┌──────────────────┐
  │ Query Store  │                   │  Subscription    │
  │              │                   │  callback(result) │
  └──────┬───────┘                   └────────┬─────────┘
         │                                    │
         │         bucket change event        │
         │◄───────────────────────────────────┘
         │         re-execute query
         │────────────────────────────────────►│
         │         if result differs           │
         │         callback(newResult)          │
```

```typescript
// Define a query that counts users per role
store.defineQuery('roleCounts', async (ctx) => {
  const all = await ctx.bucket('users').all();
  const counts: Record<string, number> = {};
  for (const user of all) {
    const role = user.role as string;
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
});

// Subscribe — fires immediately, then on every relevant change
const unsub = await store.subscribe<Record<string, number>>(
  'roleCounts',
  (counts) => console.log('Role counts:', counts),
);
// Output: Role counts: { admin: 1, user: 3 }

// Insert triggers re-evaluation
await users.insert({ name: 'Eve', email: 'eve@example.com', role: 'admin' });
// Output: Role counts: { admin: 2, user: 3 }

unsub(); // Stop receiving updates
```

The key insight: **you write a plain async function, and the store turns it into a live subscription**. No manual event wiring, no stale caches, no polling.

## Transactions

Transactions provide atomic writes across multiple buckets. All writes either succeed together or are rolled back:

```typescript
await store.transaction(async (tx) => {
  const orders = await tx.bucket('orders');
  const inventory = await tx.bucket('inventory');

  const item = await inventory.get('SKU-42');
  if (!item || (item.quantity as number) < 1) {
    throw new Error('Out of stock');
  }

  await orders.insert({ itemId: 'SKU-42', customerId: 'C-100' });
  await inventory.update('SKU-42', { quantity: (item.quantity as number) - 1 });

  // Both writes commit atomically when the function returns.
  // If any write fails, everything is rolled back.
});
```

### Transaction Guarantees

| Property | Guarantee |
|----------|-----------|
| **Atomicity** | All writes commit or none do |
| **Isolation** | Reads inside the transaction see your own writes |
| **Consistency** | Version checks prevent conflicting concurrent writes |
| **Rollback** | On failure, previously committed buckets are undone |

Transactions use optimistic locking: each record's `_version` is checked at commit time. If another write modified the record since you read it, the transaction throws a `TransactionConflictError`.

## TTL and Lifecycle

Buckets can declare a time-to-live. Records are automatically expired after the TTL elapses:

```typescript
await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token: { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '30m',      // Expire after 30 minutes
  maxSize: 10_000,  // Evict oldest if more than 10,000 records
});
```

| Feature | Configuration | Behavior |
|---------|--------------|----------|
| TTL | `ttl: '30m'` or `ttl: 1800000` | Records get `_expiresAt`; purged periodically |
| Max size | `maxSize: 10_000` | When full, oldest records (by `_createdAt`) are evicted |
| Manual purge | `store.purgeTtl()` | Trigger immediate expiration check |

TTL supports human-readable durations: `'30s'`, `'5m'`, `'1h'`, `'7d'`.

## Persistence

Persistence is optional and adapter-based. When enabled, the store saves bucket snapshots on every change (debounced) and restores data on restart:

```typescript
import { MemoryAdapter } from '@hamicek/noex';

const store = await Store.start({
  name: 'persistent-app',
  persistence: {
    adapter: new MemoryAdapter(),  // Or FileAdapter, SQLiteAdapter
    debounceMs: 100,               // Batch writes (default: 100ms)
  },
});
```

Individual buckets can opt out of persistence with `persistent: false`.

## The Supervision Tree

Under the hood, noex-store is built on the actor model (`@hamicek/noex`). Each bucket is a GenServer actor, managed by a Supervisor with a `one_for_one` restart strategy:

```text
                    ┌─────────────────────┐
                    │        Store        │
                    │    (orchestrator)    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │     Supervisor      │
                    │   one_for_one       │
                    └──┬──────┬──────┬────┘
                       │      │      │
               ┌───────▼┐ ┌──▼────┐ ┌▼───────┐
               │ Bucket │ │Bucket │ │ Bucket │
               │ Server │ │Server │ │ Server │
               │ users  │ │orders │ │sessions│
               └────────┘ └───────┘ └────────┘
               (GenServer) (GenServer) (GenServer)
```

Each BucketServer encapsulates:
- **Data**: An in-memory Map of records
- **SchemaValidator**: Validates and prepares records
- **IndexManager**: Maintains secondary indexes and unique constraints
- **Event publishing**: Sends insert/update/delete events to the EventBus

If a bucket actor crashes, the supervisor restarts it. Other buckets continue operating unaffected. This is the **one_for_one** strategy: the failure of one child doesn't take down its siblings.

## How Concepts Map to Real-World Problems

| Concept | Real-World Analogy | Example |
|---------|--------------------|---------|
| **Store** | A database server | Central entry point for all data operations |
| **Bucket** | A table | Named collection with a schema |
| **BucketHandle** | A table reference | Lightweight proxy for read/write operations |
| **Schema** | A table definition (DDL) | Declares field types, constraints, defaults |
| **Record** | A row | Data + automatic metadata (`_version`, `_createdAt`, …) |
| **Event** | A trigger / changelog | Notification that data changed |
| **Reactive Query** | A materialized view | Live result that updates when underlying data changes |
| **Transaction** | A database transaction | Atomic writes across multiple buckets |
| **TTL** | Row expiration policy | Automatic cleanup of stale data |
| **Persistence** | Write-ahead log / snapshot | Survive process restarts |
| **Supervisor** | Process manager | Restarts crashed bucket actors automatically |

## Exercise

A team is building a real-time chat application. They need to store users, rooms, and messages. Using the concepts from this chapter, answer the following questions.

**Requirements:**
- Users have a unique username and an email
- Rooms have a name and a creator (user ID)
- Messages belong to a room and a user, and contain text
- The dashboard should show the message count per room in real-time
- Messages older than 30 days should be automatically deleted
- When a user sends a message, the system should verify the user exists and the room exists before inserting

1. How many buckets do you need? What are their names and key fields?
2. Which fields would you index?
3. Where would you use a reactive query?
4. Where would you use a transaction?
5. Which bucket needs TTL?

<details>
<summary>Solution</summary>

**1. Three buckets:**
- `users` — key: `id` (generated uuid). Schema: `id`, `username` (unique), `email` (format: email, unique).
- `rooms` — key: `id` (generated uuid). Schema: `id`, `name`, `creatorId` (ref to users).
- `messages` — key: `id` (generated uuid). Schema: `id`, `roomId`, `userId`, `text`, `sentAt` (generated timestamp).

**2. Indexes:**
- `users`: index on `username` (for lookups by name). Unique constraint already creates an index on `username` and `email`.
- `rooms`: no additional indexes needed beyond the key.
- `messages`: index on `roomId` (for listing messages in a room) and `userId` (for listing messages by user).

**3. Reactive query for the dashboard:**
- Define a query `messageCountPerRoom` that calls `ctx.bucket('messages').all()`, groups by `roomId`, and returns `Record<string, number>`.
- Subscribe from the dashboard component. The count updates automatically when messages are inserted or deleted.

**4. Transaction for sending a message:**
- Use `store.transaction()` to verify the user exists (`users.get(userId)`) and the room exists (`rooms.get(roomId)`) before inserting the message. If either is missing, throw an error — the transaction aborts with no side effects.

**5. TTL on messages:**
- Set `ttl: '30d'` on the `messages` bucket. Messages automatically get `_expiresAt = _createdAt + 30 days` and are purged by the TTL manager without any cleanup code.

</details>

## Summary

- The **Store** is the central entry point — it manages buckets, events, queries, and transactions
- A **Bucket** is a schema-enforced collection backed by a GenServer actor
- A **BucketHandle** is a stateless proxy — creating one is free
- **Schemas** declare field types, constraints, defaults, and auto-generated values
- Every **Record** carries metadata: `_version`, `_createdAt`, `_updatedAt`, and optionally `_expiresAt`
- **Events** (`inserted`, `updated`, `deleted`) are published on every mutation
- **Reactive Queries** are plain async functions that the store turns into live subscriptions
- **Transactions** provide atomic writes across multiple buckets with optimistic locking
- **TTL** and **maxSize** handle automatic data lifecycle
- **Persistence** is adapter-based and opt-in per bucket
- The **Supervision Tree** isolates bucket failures — one crash doesn't take down the others

---

Next: [Your First Store](../02-getting-started/01-first-store.md)
