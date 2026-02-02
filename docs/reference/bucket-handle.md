# BucketHandle API Reference

> Fluent, stateless proxy for CRUD operations, filtering, cursor-based pagination, and aggregation on a single bucket.

## Overview

`BucketHandle` is the primary interface for reading and writing data in a bucket. You obtain one from `store.bucket(name)` — it holds only the bucket name and an internal actor reference, so creating handles is effectively free.

Every method delegates to the underlying `BucketServer` actor via `GenServer.call`, which means all operations are serialized per bucket and safe to call concurrently from multiple parts of your application.

## API

### `handle.name: string`

Read-only property. Returns the name of the bucket this handle points to.

**Example:**

```typescript
const users = store.bucket('users');
console.log(users.name); // "users"
```

---

### CRUD Methods

#### `handle.insert(data): Promise<StoreRecord>`

Inserts a new record into the bucket. The data is validated against the bucket schema, defaults are applied, generated fields are populated, and record metadata (`_version`, `_createdAt`, `_updatedAt`) is set automatically.

If the bucket has TTL configured and the record does not already have `_expiresAt`, it is set to `_createdAt + ttlMs`. If the bucket has `maxSize` and is at capacity, the oldest record (by `_createdAt`) is evicted before the insert.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `data` | `Record<string, unknown>` | — | Field values for the new record. Generated and default fields may be omitted |

**Returns:** `Promise<StoreRecord>` — the fully populated record including generated fields and metadata

**Throws:**

- `ValidationError` — data violates schema constraints (required fields, enum, min/max, format, etc.)
- `UniqueConstraintError` — a unique-indexed field value already exists in the bucket

**Example:**

```typescript
const users = store.bucket('users');

const record = await users.insert({ name: 'Alice', email: 'alice@example.com' });
// record.id       → "a1b2c3d4-..." (generated UUID)
// record.role     → "member"        (schema default)
// record._version → 1
```

---

#### `handle.get(key): Promise<StoreRecord | undefined>`

Retrieves a single record by its primary key. Returns `undefined` if no record exists with that key. This is an O(1) lookup.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | `unknown` | — | Primary key value |

**Returns:** `Promise<StoreRecord | undefined>`

**Example:**

```typescript
const user = await users.get('a1b2c3d4-...');
if (user) {
  console.log(user.name);
}
```

---

#### `handle.update(key, changes): Promise<StoreRecord>`

Applies a partial update to an existing record. Only the provided fields are changed — other fields retain their current values. The `_version` is incremented by 1 and `_updatedAt` is set to the current timestamp. Changes are validated against the schema.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | `unknown` | — | Primary key of the record to update |
| `changes` | `Record<string, unknown>` | — | Fields to change |

**Returns:** `Promise<StoreRecord>` — the updated record

**Throws:**

- `Error` — record with the given key does not exist
- `ValidationError` — changes violate schema constraints
- `UniqueConstraintError` — a unique-indexed field value already exists

**Example:**

```typescript
const updated = await users.update('a1b2c3d4-...', { name: 'Bob', role: 'admin' });
// updated._version → 2
```

---

#### `handle.delete(key): Promise<void>`

Removes a record by its primary key. If no record exists with that key, the call is a silent no-op.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | `unknown` | — | Primary key of the record to delete |

**Returns:** `Promise<void>`

**Example:**

```typescript
await users.delete('a1b2c3d4-...');
```

---

#### `handle.clear(): Promise<void>`

Removes all records from the bucket and clears all indexes.

**Returns:** `Promise<void>`

**Example:**

```typescript
await users.clear();
const count = await users.count(); // 0
```

---

#### `handle.all(): Promise<StoreRecord[]>`

Returns all records in the bucket as an array. The order is not guaranteed unless the bucket uses `etsType: 'ordered_set'`.

**Returns:** `Promise<StoreRecord[]>`

**Example:**

```typescript
const allUsers = await users.all();
console.log(`Total: ${allUsers.length}`);
```

---

### Querying Methods

#### `handle.where(filter): Promise<StoreRecord[]>`

Returns all records matching the filter. The filter uses strict equality (`===`) with AND logic — a record must match every field in the filter object.

If any filter field has a secondary index, the query uses the index for an O(1) key lookup instead of a full table scan. Remaining (non-indexed) fields are checked against the narrowed candidate set.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | `Record<string, unknown>` | — | Key-value pairs to match. All must be satisfied (AND) |

**Returns:** `Promise<StoreRecord[]>` — matching records, or empty array if none match

**Example:**

```typescript
const admins = await users.where({ role: 'admin' });
const specific = await users.where({ role: 'admin', name: 'Alice' });
```

---

#### `handle.findOne(filter): Promise<StoreRecord | undefined>`

Returns the first record matching the filter, or `undefined` if no record matches. Uses the same index-accelerated lookup as `where()`.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | `Record<string, unknown>` | — | Key-value pairs to match |

**Returns:** `Promise<StoreRecord | undefined>`

**Example:**

```typescript
const alice = await users.findOne({ email: 'alice@example.com' });
```

---

#### `handle.count(filter?): Promise<number>`

Returns the number of records in the bucket. When called without a filter, returns the total count in O(1). With a filter, counts only matching records.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter. Omit for total count |

**Returns:** `Promise<number>`

**Example:**

```typescript
const total = await users.count();
const adminCount = await users.count({ role: 'admin' });
```

---

#### `handle.first(n): Promise<StoreRecord[]>`

Returns the first `n` records. On `ordered_set` buckets, records are sorted by primary key. On regular `set` buckets, the order follows insertion order. If `n` exceeds the record count, all records are returned.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `n` | `number` | — | Maximum number of records to return |

**Returns:** `Promise<StoreRecord[]>`

**Example:**

```typescript
const top5 = await products.first(5);
```

---

#### `handle.last(n): Promise<StoreRecord[]>`

Returns the last `n` records. On `ordered_set` buckets, records are sorted by primary key. If `n` exceeds the record count, all records are returned.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `n` | `number` | — | Maximum number of records to return |

**Returns:** `Promise<StoreRecord[]>`

**Example:**

```typescript
const latest3 = await orders.last(3);
```

---

### Pagination

#### `handle.paginate(options): Promise<PaginatedResult>`

Cursor-based pagination. Returns a page of records starting after the given cursor (primary key). On `ordered_set` buckets, records are sorted by primary key. Use the returned `nextCursor` as the `after` value for the next page.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `options` | [`PaginateOptions`](#paginateoptions) | — | Pagination cursor and page size |

**Returns:** `Promise<`[`PaginatedResult`](#paginatedresult)`>`

**Example:**

```typescript
// First page
const page1 = await products.paginate({ limit: 10 });

// Next page
if (page1.hasMore) {
  const page2 = await products.paginate({ after: page1.nextCursor, limit: 10 });
}

// Iterate all pages
let cursor: unknown;
let hasMore = true;

while (hasMore) {
  const page = await products.paginate({ after: cursor, limit: 20 });
  for (const record of page.records) {
    // process each record
  }
  cursor = page.nextCursor;
  hasMore = page.hasMore;
}
```

---

### Aggregation Methods

All aggregation methods operate on numeric fields only. Non-numeric values in the target field are silently skipped. Each method accepts an optional filter to narrow the records before aggregation.

#### `handle.sum(field, filter?): Promise<number>`

Returns the sum of a numeric field across all (or filtered) records. Returns `0` for an empty result set.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `field` | `string` | — | Name of the numeric field to sum |
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter to narrow records |

**Returns:** `Promise<number>`

**Example:**

```typescript
const totalRevenue = await orders.sum('amount');
const vipRevenue = await orders.sum('amount', { tier: 'vip' });
```

---

#### `handle.avg(field, filter?): Promise<number>`

Returns the arithmetic mean of a numeric field. Returns `0` for an empty result set or when no values are numeric.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `field` | `string` | — | Name of the numeric field |
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter |

**Returns:** `Promise<number>`

**Example:**

```typescript
const avgScore = await students.avg('score');
```

---

#### `handle.min(field, filter?): Promise<number | undefined>`

Returns the minimum value of a numeric field. Returns `undefined` for an empty result set or when no values are numeric.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `field` | `string` | — | Name of the numeric field |
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter |

**Returns:** `Promise<number | undefined>`

**Example:**

```typescript
const cheapest = await products.min('price');
```

---

#### `handle.max(field, filter?): Promise<number | undefined>`

Returns the maximum value of a numeric field. Returns `undefined` for an empty result set or when no values are numeric.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `field` | `string` | — | Name of the numeric field |
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter |

**Returns:** `Promise<number | undefined>`

**Example:**

```typescript
const highest = await scores.max('points');
const highestVip = await scores.max('points', { tier: 'vip' });
```

---

## Types

### `StoreRecord`

Every record stored in a bucket is a `StoreRecord` — the user-defined fields merged with `RecordMeta`.

```typescript
type StoreRecord<T = Record<string, unknown>> = T & RecordMeta;
```

### `RecordMeta`

System metadata automatically managed by the store. Present on every record.

```typescript
interface RecordMeta {
  readonly _version: number;     // Starts at 1, incremented on each update
  readonly _createdAt: number;   // Unix ms timestamp, set on insert
  readonly _updatedAt: number;   // Unix ms timestamp, set on insert and each update
  readonly _expiresAt?: number;  // Unix ms timestamp, set for TTL-enabled buckets
}
```

---

### `PaginateOptions`

Options for cursor-based pagination.

```typescript
interface PaginateOptions {
  readonly after?: unknown;  // Start after this primary key (cursor). Omit for first page
  readonly limit: number;    // Maximum number of records to return
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `after` | `unknown` | `undefined` | Primary key cursor. Omit to start from the beginning |
| `limit` | `number` | — | Maximum records per page |

---

### `PaginatedResult`

Result of a `paginate()` call.

```typescript
interface PaginatedResult {
  readonly records: StoreRecord[];       // Records in this page
  readonly hasMore: boolean;             // Whether more records exist after this page
  readonly nextCursor: unknown | undefined;  // Primary key of last record. Pass as `after` for next page
}
```

| Property | Type | Description |
|----------|------|-------------|
| `records` | `StoreRecord[]` | Records in the current page |
| `hasMore` | `boolean` | `true` if there are more records beyond this page |
| `nextCursor` | `unknown \| undefined` | Primary key of the last returned record. `undefined` when no records are returned |

## See Also

- [Store API](./store.md) — `store.bucket()`, `store.defineBucket()`, and store lifecycle
- [Schema and Types](./schema.md) — `BucketDefinition`, field types, constraints, and validation
- [Reactive Queries](./reactive-queries.md) — `QueryBucket` provides a read-only subset of the same API inside queries
- [Transactions](./transactions.md) — `TransactionBucketHandle` wraps the same operations with transactional buffering
- [Events](./events.md) — events emitted by `insert`, `update`, and `delete` operations
- [TTL and Lifecycle](./ttl-lifecycle.md) — TTL expiration and `maxSize` eviction behavior
- [Errors](./errors.md) — `ValidationError`, `UniqueConstraintError`, and other error classes
- **Learn:** [CRUD Operations](../learn/02-getting-started/03-crud-operations.md) — step-by-step tutorial for insert, get, update, delete
- **Learn:** [Filtering and Search](../learn/04-querying/01-filtering-and-search.md) — where, findOne, count with examples
- **Learn:** [Secondary Indexes](../learn/04-querying/02-secondary-indexes.md) — how indexes accelerate queries
- **Learn:** [Pagination and Aggregation](../learn/04-querying/03-pagination-and-aggregation.md) — cursor-based pagination and sum/avg/min/max
- **Source:** [`src/core/bucket-handle.ts`](../../src/core/bucket-handle.ts)
