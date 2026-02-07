# @hamicek/noex-store

Schema-driven in-memory store built on [@hamicek/noex](https://github.com/hamicek/noex) with Convex-style reactive queries.

## Features

- Named, schema-validated collections (buckets) with type checking
- Secondary indexes for efficient filtering
- Convex-inspired reactive queries with automatic dependency tracking
- Multi-bucket transactions with optimistic locking
- Optional persistence (File, SQLite)
- Per-record TTL and size limits with LRU eviction
- Event system with wildcard subscriptions
- Bridge for integration with `@hamicek/noex-rules`

## Installation

```bash
npm install @hamicek/noex-store
```

Requires `@hamicek/noex` as a peer dependency and Node.js >= 20.

## Quick Start

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'my-app' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', format: 'email', unique: true },
    role:  { type: 'string', enum: ['admin', 'user'], default: 'user' },
  },
  indexes: ['role'],
});

const bucket = store.bucket('users');

const alice = await bucket.insert({ name: 'Alice', email: 'alice@example.com' });
// { id: '550e8400-...', name: 'Alice', email: 'alice@example.com', role: 'user',
//   _version: 1, _createdAt: 1706745600000, _updatedAt: 1706745600000 }

const admins = await bucket.where({ role: 'admin' });

await store.stop();
```

## API

### Store

#### `Store.start(options?): Promise<Store>`

Creates and starts a new store instance.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `"store-N"` | Store name (used in supervision tree) |
| `persistence` | `StorePersistenceConfig` | — | Persistence configuration |
| `ttlCheckIntervalMs` | `number` | `1000` | TTL check interval in ms. `0` disables automatic checks. |

```typescript
const store = await Store.start({
  name: 'my-store',
  persistence: {
    adapter: new FileAdapter('/data/store'),
    debounceMs: 200,
    onError: (err) => console.error('Persistence error:', err),
  },
  ttlCheckIntervalMs: 5000,
});
```

#### `store.defineBucket(name, definition): Promise<void>`

Register a new bucket with schema definition.

```typescript
store.defineBucket('products', {
  key: 'sku',
  schema: {
    sku:   { type: 'string', required: true },
    name:  { type: 'string', required: true, minLength: 1, maxLength: 200 },
    price: { type: 'number', required: true, min: 0 },
    tags:  { type: 'array', default: [] },
  },
  indexes: ['name'],
  ttl: '7d',
  maxSize: 10_000,
});
```

#### `store.bucket(name): BucketHandle`

Get a handle to an existing bucket. Throws `BucketNotDefinedError` if the bucket does not exist.

#### `store.dropBucket(name): Promise<void>`

Remove a bucket and all its data.

#### `store.transaction(fn): Promise<T>`

Execute an atomic multi-bucket transaction. See [Transactions](#transactions).

#### `store.defineQuery(name, fn): void`

Define a reactive query. See [Reactive Queries](#reactive-queries).

#### `store.subscribe(queryName, [params,] callback): Promise<() => void>`

Subscribe to a reactive query. Returns an unsubscribe function.

#### `store.runQuery(queryName, [params]): Promise<T>`

Execute a query once without subscribing.

#### `store.on(pattern, handler): Promise<() => Promise<void>>`

Subscribe to bucket events. Supports wildcard patterns.

```typescript
// All bucket events
const unsub = await store.on('bucket.*.*', (event, topic) => {
  console.log(topic, event.type, event.bucket, event.key);
});

// Only inserts on a specific bucket
await store.on('bucket.users.inserted', (event) => {
  console.log('New user:', event.record.name);
});
```

#### `store.getStats(): Promise<StoreStats>`

Get aggregated statistics about the store.

```typescript
const stats = await store.getStats();
// {
//   name: 'my-store',
//   buckets: { count: 2, names: ['users', 'orders'] },
//   records: { total: 1500, perBucket: { users: 500, orders: 1000 } },
//   indexes: { total: 3, perBucket: { users: 2, orders: 1 } },
//   queries: { defined: 4, activeSubscriptions: 12 },
//   persistence: { enabled: true },
//   ttl: { enabled: true, checkIntervalMs: 1000 },
// }
```

#### `store.purgeTtl(): Promise<number>`

Manually trigger TTL expiration check. Returns the number of purged records.

#### `store.settle(): Promise<void>`

Wait for all pending reactive query re-evaluations to complete.

#### `store.stop(): Promise<void>`

Flush persistence, stop all bucket servers, and release resources.

---

### BucketHandle

Stateless proxy over a BucketServer GenServer. Creating a handle is free; all operations delegate to the underlying process via `GenServer.call`.

#### CRUD

```typescript
const bucket = store.bucket('users');

// Insert — returns the full record including generated fields and metadata
const record = await bucket.insert({ name: 'Alice', email: 'alice@example.com' });

// Get by primary key
const user = await bucket.get(record.id);

// Update — merges changes into the existing record
const updated = await bucket.update(record.id, { role: 'admin' });

// Delete
await bucket.delete(record.id);

// Clear all records
await bucket.clear();
```

#### Queries

```typescript
// All records
const all = await bucket.all();

// Filter by exact field values (AND logic, uses indexes when available)
const vips = await bucket.where({ role: 'admin' });

// First matching record
const admin = await bucket.findOne({ role: 'admin' });

// Count (with optional filter)
const total = await bucket.count();
const adminCount = await bucket.count({ role: 'admin' });

// First/last N records
const firstFive = await bucket.first(5);
const lastThree = await bucket.last(3);
```

#### Pagination

Cursor-based pagination using primary keys.

```typescript
// First page
const page1 = await bucket.paginate({ limit: 20 });
// { records: [...], hasMore: true, nextCursor: 'abc-123' }

// Next page
const page2 = await bucket.paginate({ after: page1.nextCursor, limit: 20 });
```

#### Aggregations

```typescript
const totalRevenue = await bucket.sum('price');
const avgPrice = await bucket.avg('price', { category: 'electronics' });
const cheapest = await bucket.min('price');
const mostExpensive = await bucket.max('price');
```

---

### Schema

#### Field Types

| Type | JavaScript | Description |
|------|-----------|-------------|
| `string` | `string` | Text value |
| `number` | `number` | Numeric value |
| `boolean` | `boolean` | Boolean value |
| `object` | `object` | Plain object |
| `array` | `Array` | Array value |
| `date` | `string` (ISO 8601) | Date string |

#### Field Options

```typescript
{
  type: 'string',          // Required: field type
  required: true,          // Reject insert/update if missing
  default: 'basic',       // Static default (or () => value for dynamic)
  generated: 'uuid',      // Auto-generate: 'uuid' | 'cuid' | 'autoincrement' | 'timestamp'
  unique: true,            // Enforced uniqueness (backed by index)
  enum: ['a', 'b', 'c'],  // Restrict to enumerated values
  format: 'email',        // Format validation: 'email' | 'url' | 'iso-date'
  min: 0,                 // Minimum numeric value
  max: 100,               // Maximum numeric value
  minLength: 1,           // Minimum string length
  maxLength: 255,         // Maximum string length
  pattern: '^[A-Z]+$',    // Regex pattern (string)
  ref: 'orders',          // Foreign key reference (metadata only, not enforced)
}
```

#### Record Metadata

Every record automatically includes metadata fields:

| Field | Type | Description |
|-------|------|-------------|
| `_version` | `number` | Starts at 1, increments on each update |
| `_createdAt` | `number` | Unix timestamp (ms) of insertion |
| `_updatedAt` | `number` | Unix timestamp (ms) of last update |
| `_expiresAt` | `number?` | Unix timestamp (ms) when the record expires (TTL buckets only) |

---

### Reactive Queries

Define pure query functions that automatically re-evaluate when their dependencies change.

#### Definition

```typescript
// Simple query
store.defineQuery('all-users', async (ctx) => {
  return ctx.bucket('users').all();
});

// Parameterized query
store.defineQuery('users-by-role', async (ctx, params: { role: string }) => {
  return ctx.bucket('users').where({ role: params.role });
});

// Multi-bucket query
store.defineQuery('user-orders', async (ctx, params: { userId: string }) => {
  const user = await ctx.bucket('users').get(params.userId);
  if (!user) return null;
  const orders = await ctx.bucket('orders').where({ userId: params.userId });
  return { user, orders };
});
```

#### Subscriptions

```typescript
// Subscribe without params
const unsub = await store.subscribe('all-users', (users) => {
  console.log('Users changed:', users.length);
});

// Subscribe with params
const unsub = await store.subscribe('users-by-role', { role: 'admin' }, (admins) => {
  renderAdminList(admins);
});

// One-shot execution
const result = await store.runQuery('all-users');

// Wait for pending re-evaluations
await store.settle();

// Unsubscribe
await unsub();
```

#### Dependency Tracking

Queries track which buckets and records they access:

- **Bucket-level** (`all`, `where`, `findOne`, `count`, `first`, `last`, `paginate`, aggregations): any change in the bucket triggers re-evaluation.
- **Record-level** (`get`): only changes to the specific accessed keys trigger re-evaluation.

---

### Transactions

Atomic multi-bucket operations with optimistic locking and automatic rollback.

```typescript
await store.transaction(async (tx) => {
  const users = await tx.bucket('users');
  const orders = await tx.bucket('orders');

  const user = await users.get('user-1');
  await users.update('user-1', { orderCount: (user!.orderCount as number) + 1 });
  await orders.insert({ userId: 'user-1', total: 99.99 });
});
```

**Behavior:**

- All writes are buffered until the callback completes, then committed atomically.
- Reads within the transaction see buffered writes (read-your-own-writes).
- Record `_version` is checked at commit time; if another process modified the record, a `TransactionConflictError` is thrown.
- On failure, previously committed buckets are rolled back (best-effort).
- Events are published only after all commits succeed.

---

### Persistence

Optionally persist bucket data to durable storage using adapters from `@hamicek/noex`.

```typescript
import { FileAdapter } from '@hamicek/noex';

const store = await Store.start({
  persistence: {
    adapter: new FileAdapter('/data/my-store'),
    debounceMs: 200,
  },
});

// Buckets are automatically restored on start.
// Writes are debounced and batched for efficiency.
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `adapter` | `StorageAdapter` | — | Storage backend (`MemoryAdapter`, `FileAdapter`, `SQLiteAdapter`) |
| `debounceMs` | `number` | `100` | Debounce interval for batched writes |
| `onError` | `(error: Error) => void` | — | Callback for non-fatal persistence errors |

Individual buckets can opt out of persistence:

```typescript
store.defineBucket('cache', {
  key: 'id',
  schema: { id: { type: 'string', required: true }, data: { type: 'object' } },
  persistent: false, // not persisted even if the store has persistence
});
```

---

### TTL & Size Limits

#### Per-Record TTL

Records automatically expire after a specified duration.

```typescript
store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token:  { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '30m', // human-readable: "1s", "30m", "1h", "7d", "90d"
});

// Or in milliseconds:
store.defineBucket('temp', {
  key: 'id',
  schema: { id: { type: 'string', generated: 'uuid' } },
  ttl: 60_000, // 60 seconds
});

// Manual purge
const purgedCount = await store.purgeTtl();
```

Expired records are automatically purged at the interval configured via `ttlCheckIntervalMs` (default 1000 ms).

#### Max Size

Limit the number of records in a bucket. When the limit is exceeded, the oldest records (by `_createdAt`) are evicted.

```typescript
store.defineBucket('recent-logs', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    message: { type: 'string', required: true },
  },
  maxSize: 1000,
});
```

---

### Rules Bridge

Bridge store events to an external event receiver (typically a `@hamicek/noex-rules` RuleEngine).

```typescript
import { bridgeStoreToRules } from '@hamicek/noex-store/bridge';

const unbridge = await bridgeStoreToRules(store, ruleEngine);

// All bucket events are now forwarded:
//   'bucket.users.inserted' → ruleEngine.emit('bucket.users.inserted', { ... })

// Stop forwarding
await unbridge();
```

The bridge uses an `EventReceiver` interface (`{ emit(topic, data): Promise<unknown> }`) instead of depending on `@hamicek/noex-rules` directly. Any object implementing this interface works.

#### Options

```typescript
await bridgeStoreToRules(store, receiver, {
  // Forward only specific events
  filter: (event) => event.bucket === 'orders',

  // Transform the topic string
  mapTopic: (topic) => topic.replace(/\./g, ':'),

  // Transform the event payload
  mapData: (event) => ({ bucket: event.bucket, key: event.key }),
});
```

| Option | Type | Description |
|--------|------|-------------|
| `filter` | `(event: BucketEvent) => boolean` | Filter which events to forward |
| `mapTopic` | `(topic: string, event: BucketEvent) => string` | Transform the topic |
| `mapData` | `(event: BucketEvent) => Record<string, unknown>` | Transform the event data |

Receiver errors are silently caught and do not affect store operation (fire-and-forget).

---

### Events

Bucket mutations publish events on the store's internal EventBus.

| Topic Pattern | Event Type | Payload |
|--------------|------------|---------|
| `bucket.{name}.inserted` | `BucketInsertedEvent` | `{ type, bucket, key, record }` |
| `bucket.{name}.updated` | `BucketUpdatedEvent` | `{ type, bucket, key, oldRecord, newRecord }` |
| `bucket.{name}.deleted` | `BucketDeletedEvent` | `{ type, bucket, key, record }` |

```typescript
await store.on('bucket.*.*', (event, topic) => {
  switch (event.type) {
    case 'inserted': console.log('New:', event.record); break;
    case 'updated':  console.log('Changed:', event.oldRecord, '->', event.newRecord); break;
    case 'deleted':  console.log('Removed:', event.record); break;
  }
});
```

---

### Error Classes

| Error | Thrown When | Properties |
|-------|-----------|------------|
| `BucketAlreadyExistsError` | `defineBucket` with existing name | `bucket` |
| `BucketNotDefinedError` | `bucket()` or `dropBucket` with unknown name | `bucket` |
| `UniqueConstraintError` | Insert/update violates unique field | `bucket`, `field`, `value` |
| `TransactionConflictError` | Record version mismatch during transaction commit | `bucket`, `key`, `field?` |
| `ValidationError` | Schema validation fails | `issues: { field, message, code }[]` |
| `QueryAlreadyDefinedError` | `defineQuery` with existing name | — |
| `QueryNotDefinedError` | `subscribe`/`runQuery` with unknown name | — |

---

## Architecture

### Supervision Tree

```
Store
├── Supervisor (one_for_one)
│   ├── BucketServer "users"     ← GenServer (holds data + indexes)
│   ├── BucketServer "orders"    ← GenServer
│   └── BucketServer "products"  ← GenServer
├── EventBus                     ← Wildcard pub/sub for bucket events
├── QueryManager                 ← Reactive query subscriptions
├── TtlManager                   ← Periodic expiration checks
└── StorePersistence             ← Debounced writes to storage adapter
```

Each bucket is a `GenServer` process managed by a `Supervisor`. All reads and writes go through `GenServer.call`, providing sequential consistency per bucket. Cross-bucket atomicity is handled by `TransactionContext` with buffered writes and rollback.

### Data Flow

```
insert(data) → GenServer.call → BucketServer.handleCall
                                  ├── SchemaValidator.prepareInsert
                                  ├── IndexManager.add
                                  ├── EtsTable.insert
                                  └── EventBus.publish('bucket.users.inserted', event)
                                        ├── QueryManager → re-evaluate affected queries
                                        ├── StorePersistence → debounced snapshot
                                        └── (optional) Bridge → EventReceiver.emit
```

---

## Comparison

How does `noex-store` compare to other reactive stores and client-side databases?

| Feature | noex-store | RxDB | TinyBase | SignalDB | LokiJS | Dexie.js | WatermelonDB |
|---------|:----------:|:----:|:--------:|:--------:|:------:|:--------:|:------------:|
| Reactive queries | Convex-style | RxJS Observables | Query engine | Signal-based | DynamicViews | liveQuery | observe() |
| Schema validation | Built-in DSL | JSON Schema | Schematizers | Validate event | — | — | Column types |
| Multi-collection transactions | Optimistic locking | — | Single-store | — | Single-coll. | ACID | Writer blocks |
| Persistence | Adapter-based | Swappable storage | Adapters | Adapters | Adapters | IndexedDB | SQLite |
| TTL / auto-expiration | First-class | Cleanup only | — | — | Buggy | — | — |
| Event bus with wildcards | Topic pub/sub | RxJS streams | Granular listeners | Collection events | Collection events | Hooks | Observables |
| In-memory first | Yes | No | Yes | Yes | Yes | No | No |
| Supervision tree | OTP one_for_one | — | — | — | — | — | — |
| Secondary indexes | Unique + non-unique | JSON Schema | Indexes API | Query selectors | Unique + binary | Core feature | isIndexed |
| Bundle size (gzip) | ~5 kB | 60–150+ kB | 3.5–8 kB | ~5–8 kB | ~20 kB | ~26 kB | ~2 MB |
| Status | Active | Active (freemium) | Active | Active | Archived | Active | Active |

**Key differentiators:**

- **Supervision tree** — each bucket is an isolated GenServer actor; if one crashes, the supervisor restarts it while siblings continue. No other JS store offers this.
- **First-class TTL** — declarative per-bucket expiration (`ttl: '30m'`) with automatic background purge and `_expiresAt` metadata.
- **Convex-style reactive queries** — plain `async` functions become live subscriptions with automatic bucket-level and record-level dependency tracking.
- **Multi-bucket ACID transactions** — version-based optimistic locking with atomic commit and best-effort rollback.
- **Wildcard event bus** — subscribe to patterns like `bucket.*.deleted` or `bucket.users.*` across the entire store.

---

## Benchmarks

Run benchmarks with:

```bash
npm run bench           # all benchmarks
npm run bench:crud      # CRUD throughput
npm run bench:queries   # query + index performance
npm run bench:reactive  # reactive query latency & overhead
```

---

## License

MIT
