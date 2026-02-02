# Transactions API Reference

> Atomic multi-bucket writes with read-your-own-writes isolation, optimistic locking, and automatic rollback on failure.

## Overview

Transactions let you group multiple write operations across one or more buckets into an atomic unit. All writes are buffered locally during the transaction callback and committed together after the callback completes. If the callback throws, nothing is written. If a commit fails mid-way (e.g., version conflict), previously committed buckets are rolled back on a best-effort basis.

Transactions are created via `store.transaction()`. Inside the callback you receive a `TransactionContext` that provides `TransactionBucketHandle` instances — these buffer writes locally and overlay them on reads, giving you read-your-own-writes semantics.

## API

### `store.transaction(fn): Promise<T>`

Executes a transactional callback. Creates a `TransactionContext`, passes it to `fn`, and commits all buffered writes atomically after `fn` resolves. If `fn` throws, the transaction is discarded — no writes reach the store.

The return value of `fn` is forwarded as the return value of `transaction()`.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `fn` | `(tx: TransactionContext) => Promise<T>` | — | Async callback that performs transactional operations |

**Returns:** `Promise<T>` — the value returned by `fn`

**Throws:**
- `TransactionConflictError` — a version conflict was detected during commit (see [Optimistic Locking](#optimistic-locking))
- Any error thrown by `fn` — propagated as-is, transaction is discarded

**Example:**

```typescript
const newOrder = await store.transaction(async (tx) => {
  const customers = await tx.bucket('customers');
  const orders = await tx.bucket('orders');

  const customer = await customers.get('cust-1');
  if (!customer) throw new Error('Customer not found');

  const order = await orders.insert({
    customerId: 'cust-1',
    total: 99.99,
    status: 'pending',
  });

  await customers.update('cust-1', {
    orderCount: (customer.orderCount as number) + 1,
  });

  return order;
});
```

---

## TransactionContext

The context object passed to the transaction callback. Provides access to transactional bucket handles.

### `tx.bucket(name): Promise<TransactionBucketHandle>`

Returns a `TransactionBucketHandle` for the named bucket. The handle is created lazily on first access and cached — subsequent calls with the same name return the same handle.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | — | Name of a defined bucket |

**Returns:** `Promise<TransactionBucketHandle>`

**Throws:** `Error` — the bucket is not defined

**Example:**

```typescript
await store.transaction(async (tx) => {
  const users = await tx.bucket('users');
  const orders = await tx.bucket('orders');

  // Same handle returned on repeated access
  const usersAgain = await tx.bucket('users');
  // usersAgain === users
});
```

---

## TransactionBucketHandle

Bucket handle for use within a transaction. Write operations are buffered locally. Read operations apply the buffer as an overlay on top of the real store state, providing read-your-own-writes isolation.

### Differences from BucketHandle

| Aspect | `BucketHandle` | `TransactionBucketHandle` |
|--------|----------------|---------------------------|
| **Writes** | Applied immediately | Buffered until commit |
| **Reads** | Always from store | Overlay (buffer + store) |
| **Available methods** | Full API (CRUD, queries, pagination, aggregation) | `insert`, `get`, `update`, `delete`, `all`, `where`, `findOne`, `count` |
| **Events** | Emitted immediately | Emitted after commit |

### Write Operations

---

### `bucket.insert(data): Promise<StoreRecord>`

Validates and prepares a record, then buffers it for insertion. Schema validation, defaults, and generated fields (uuid, cuid, autoincrement, timestamp) are applied immediately. The record is visible to subsequent reads within the same transaction but does not reach the store until commit.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `data` | `Record<string, unknown>` | — | Record data (schema-validated) |

**Returns:** `Promise<StoreRecord>` — the prepared record with generated fields and metadata

**Throws:** `ValidationError` — the data fails schema validation

**Example:**

```typescript
await store.transaction(async (tx) => {
  const orders = await tx.bucket('orders');

  const order = await orders.insert({ product: 'Widget', amount: 42 });
  console.log(order.id); // generated key is available immediately

  // The insert is visible within this transaction
  const fetched = await orders.get(order.id);
  // fetched === order
});
```

---

### `bucket.update(key, changes): Promise<StoreRecord>`

Reads the current record (from buffer overlay or store), applies changes, validates, and buffers the update. The `_version` is incremented in the prepared record. The `expectedVersion` recorded in the buffer is the version at the time of the first read, enabling optimistic locking at commit time.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | `unknown` | — | Primary key of the record to update |
| `changes` | `Record<string, unknown>` | — | Partial record with fields to change |

**Returns:** `Promise<StoreRecord>` — the updated record

**Throws:** `Error` — the record does not exist (not found in buffer or store)

**Example:**

```typescript
await store.transaction(async (tx) => {
  const products = await tx.bucket('products');

  await products.update('prod-1', { price: 29.99 });

  // Update is visible within this transaction
  const updated = await products.get('prod-1');
  console.log(updated?.price); // 29.99
});
```

---

### `bucket.delete(key): Promise<void>`

Reads the current record and buffers a delete operation. Idempotent — deleting a non-existent key is a no-op.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | `unknown` | — | Primary key of the record to delete |

**Returns:** `Promise<void>`

**Example:**

```typescript
await store.transaction(async (tx) => {
  const sessions = await tx.bucket('sessions');

  await sessions.delete('sess-expired');

  // Record is gone within this transaction
  const deleted = await sessions.get('sess-expired');
  // deleted === undefined
});
```

---

### Read Operations

All read operations apply the transaction's write buffer as an overlay on top of the real store data:

- **Inserts** in the buffer are appended to the result set
- **Updates** in the buffer replace the corresponding store records
- **Deletes** in the buffer remove records from the result set

---

### `bucket.get(key): Promise<StoreRecord | undefined>`

Reads a single record by primary key. Checks the buffer first (returning the buffered version or `undefined` for buffered deletes), then falls through to the real store.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | `unknown` | — | Primary key of the record |

**Returns:** `Promise<StoreRecord | undefined>`

---

### `bucket.all(): Promise<StoreRecord[]>`

Returns all records from the store with the buffer overlay applied.

**Returns:** `Promise<StoreRecord[]>`

---

### `bucket.where(filter): Promise<StoreRecord[]>`

Returns records matching the filter (AND logic across properties) from the overlaid data set.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | `Record<string, unknown>` | — | Key-value pairs that records must match |

**Returns:** `Promise<StoreRecord[]>`

---

### `bucket.findOne(filter): Promise<StoreRecord | undefined>`

Returns the first record matching the filter from the overlaid data set.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | `Record<string, unknown>` | — | Key-value pairs to match |

**Returns:** `Promise<StoreRecord | undefined>`

---

### `bucket.count(filter?): Promise<number>`

Returns the number of records matching the filter (or total count) from the overlaid data set.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter |

**Returns:** `Promise<number>`

---

## Read-Your-Own-Writes

Within a transaction, all reads reflect uncommitted writes made earlier in the same transaction. This applies to all read methods (`get`, `all`, `where`, `findOne`, `count`).

```typescript
await store.transaction(async (tx) => {
  const users = await tx.bucket('users');

  // Insert a new user
  const alice = await users.insert({ name: 'Alice', role: 'admin' });

  // The insert is immediately visible
  const all = await users.all();
  const found = all.find((u) => u.name === 'Alice');
  // found !== undefined

  // Update the just-inserted user
  await users.update(alice.id, { role: 'superadmin' });

  // The update is reflected
  const updated = await users.get(alice.id);
  // updated.role === 'superadmin'

  // Delete it
  await users.delete(alice.id);

  // Gone from reads
  const afterDelete = await users.get(alice.id);
  // afterDelete === undefined
});
```

The buffer overlay logic:

| Buffer state for key | `get(key)` returns | Effect on `all()` / `where()` |
|----------------------|--------------------|-------------------------------|
| Inserted | The buffered record | Appended to results |
| Updated | The buffered record | Replaces the store version |
| Deleted | `undefined` | Excluded from results |
| Not in buffer | Store value | Included as-is |

---

## Optimistic Locking

Transactions use optimistic concurrency control via the `_version` field on each record. No locks are held during the transaction — conflicts are detected at commit time.

### How It Works

1. When a `TransactionBucketHandle` reads a record (for `update` or `delete`), it captures the record's current `_version` as the `expectedVersion`.
2. At commit time, each update/delete operation is validated against the current store state.
3. If the store record's `_version` no longer matches the `expectedVersion`, a `TransactionConflictError` is thrown.

### Conflict Scenarios

| Scenario | Result |
|----------|--------|
| Record updated by another operation between read and commit | `TransactionConflictError` (version mismatch) |
| Record deleted by another operation between read and commit (update) | `TransactionConflictError` (record not found) |
| Insert of a key that already exists | `TransactionConflictError` (duplicate key) |

### Retry Pattern

```typescript
async function withRetry<T>(
  store: Store,
  fn: (tx: TransactionContext) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await store.transaction(fn);
    } catch (error) {
      if (error instanceof TransactionConflictError && attempt < maxRetries - 1) {
        continue; // retry with fresh reads
      }
      throw error;
    }
  }
  throw new Error('Unreachable');
}
```

---

## Commit Protocol

The commit process follows a two-phase approach within each bucket and a sequential approach across buckets.

### Commit Flow

1. **Callback completes** — `fn(tx)` returns without throwing
2. **Build operations** — buffered inserts, updates, and deletes are converted to `CommitBatchOp` arrays per bucket
3. **Sequential bucket commit** — for each touched bucket:
   - **Phase 1 (Validate):** All operations are checked against current store state (key existence, version matching, unique constraints) without any mutations
   - **Phase 2 (Apply):** All operations are applied to the store, collecting events and undo operations
4. **Event emission** — after ALL buckets commit successfully, events are published

### Rollback on Failure

If any bucket commit fails (Phase 1 validation or Phase 2 application error):

1. The failing bucket's partial Phase 2 changes are rolled back internally
2. All previously committed buckets are rolled back in reverse order using their undo operations
3. The error is propagated to the caller

Rollback is **best-effort** — if a rollback operation itself fails, the error is swallowed and rollback continues for remaining buckets.

### Event Emission

Events are published only after all buckets have committed successfully. Individual `inserted`, `updated`, and `deleted` events are emitted for each operation:

```typescript
await store.transaction(async (tx) => {
  const users = await tx.bucket('users');
  const orders = await tx.bucket('orders');

  await users.insert({ name: 'Alice' });
  await orders.insert({ product: 'Widget', amount: 10 });
  await orders.insert({ product: 'Gadget', amount: 20 });
});

// After commit, three events are emitted:
// 1. bucket.users.inserted  (Alice)
// 2. bucket.orders.inserted (Widget)
// 3. bucket.orders.inserted (Gadget)
```

Events are emitted synchronously in order after commit. If you need to wait for reactive queries to process these events, use `store.settle()`.

---

## Automatic Rollback on Error

If the transaction callback throws, the transaction is simply discarded — no writes are committed, no events are emitted.

```typescript
try {
  await store.transaction(async (tx) => {
    const users = await tx.bucket('users');

    await users.insert({ name: 'Alice' });
    await users.insert({ name: 'Bob' });

    throw new Error('Something went wrong');
    // Neither Alice nor Bob is inserted
  });
} catch (error) {
  // error.message === 'Something went wrong'
  // Store is unchanged
}
```

---

## Types

### `TransactionContext`

The context object passed to the transaction callback. Provides access to transactional bucket handles.

```typescript
class TransactionContext {
  /** Returns a transactional bucket handle (lazily created, cached). */
  bucket(name: string): Promise<TransactionBucketHandle>;

  /** Commits all buffered writes. Called automatically by store.transaction(). */
  commit(): Promise<void>;
}
```

> **Note:** `commit()` is called automatically by `store.transaction()` after the callback completes. You should not call it manually.

---

### `TransactionBucketHandle`

Bucket handle with buffered writes and overlay reads.

```typescript
class TransactionBucketHandle {
  readonly name: string;

  // Write operations (buffered)
  insert(data: Record<string, unknown>): Promise<StoreRecord>;
  update(key: unknown, changes: Record<string, unknown>): Promise<StoreRecord>;
  delete(key: unknown): Promise<void>;

  // Read operations (overlay on store)
  get(key: unknown): Promise<StoreRecord | undefined>;
  all(): Promise<StoreRecord[]>;
  where(filter: Record<string, unknown>): Promise<StoreRecord[]>;
  findOne(filter: Record<string, unknown>): Promise<StoreRecord | undefined>;
  count(filter?: Record<string, unknown>): Promise<number>;
}
```

---

### `TransactionConflictError`

Thrown when a version conflict or key conflict is detected during commit.

```typescript
class TransactionConflictError extends Error {
  readonly bucket: string;        // bucket where the conflict occurred
  readonly key: unknown;          // primary key of the conflicting record
  readonly field: string | undefined; // field involved (if applicable)
}
```

**When it is thrown:**

| Scenario | Message pattern |
|----------|-----------------|
| Update of a record whose version changed | `Version mismatch: expected X, got Y` |
| Update of a deleted record | `Record with key "..." not found` |
| Delete of a record whose version changed | `Version mismatch: expected X, got Y` |
| Insert of a key that already exists | `Record with key "..." already exists` |

---

### `WriteBuffer`

Top-level write buffer that manages per-bucket buffers. Used internally by `TransactionContext`.

```typescript
class WriteBuffer {
  /** Get or create a per-bucket buffer. */
  forBucket(name: string): BucketWriteBuffer;

  /** Names of all buckets that have buffered operations. */
  getBucketNames(): string[];

  /** Get the buffer for a specific bucket. */
  getBucket(name: string): BucketWriteBuffer | undefined;

  /** True if no operations are buffered in any bucket. */
  readonly isEmpty: boolean;
}
```

---

### `BucketWriteBuffer`

Per-bucket write buffer that tracks inserts, updates, and deletes separately. Maintains an overlay for read-your-own-writes isolation.

```typescript
class BucketWriteBuffer {
  readonly inserts: Map<unknown, StoreRecord>;
  readonly updates: Map<unknown, StoreRecord>;
  readonly deletes: Map<unknown, StoreRecord>;
  readonly ops: BufferedOp[];

  addInsert(key: unknown, record: StoreRecord): void;
  addUpdate(key: unknown, oldRecord: StoreRecord, newRecord: StoreRecord): void;
  addDelete(key: unknown, record: StoreRecord): void;

  /**
   * Look up a record in the overlay.
   * Returns: StoreRecord if in inserts/updates, null if deleted, undefined if not buffered.
   */
  getOverlay(key: unknown): StoreRecord | null | undefined;

  readonly isEmpty: boolean;
}
```

---

### `BufferedOp`

Discriminated union of buffered operation types.

```typescript
interface BufferedInsert {
  readonly type: 'insert';
  readonly key: unknown;
  readonly record: StoreRecord;
}

interface BufferedUpdate {
  readonly type: 'update';
  readonly key: unknown;
  readonly oldRecord: StoreRecord;
  readonly newRecord: StoreRecord;
  readonly expectedVersion: number;
}

interface BufferedDelete {
  readonly type: 'delete';
  readonly key: unknown;
  readonly record: StoreRecord;
  readonly expectedVersion: number;
}

type BufferedOp = BufferedInsert | BufferedUpdate | BufferedDelete;
```

---

### Buffer Optimization

The write buffer applies net-effect optimization for certain operation sequences within a single transaction:

| Sequence | Net effect |
|----------|------------|
| `insert` → `update` | Single insert with the updated record |
| `insert` → `delete` | No operation (both removed from buffer) |
| `update` → `update` | Single update with the latest record (original `expectedVersion` preserved) |

This reduces the number of operations sent to the store at commit time.

---

## See Also

- [Store API](./store.md) — `store.transaction()` entry point
- [BucketHandle API](./bucket-handle.md) — non-transactional bucket operations
- [Events](./events.md) — event types emitted after transaction commit
- [Errors](./errors.md) — complete error catalog including `TransactionConflictError`
- **Learn:** [Why Transactions](../learn/07-transactions/01-why-transactions.md) — conceptual introduction
- **Learn:** [Using Transactions](../learn/07-transactions/02-using-transactions.md) — step-by-step tutorial
- **Source:** [`src/transaction/transaction.ts`](../../src/transaction/transaction.ts)
- **Source:** [`src/transaction/transaction-bucket-handle.ts`](../../src/transaction/transaction-bucket-handle.ts)
- **Source:** [`src/transaction/write-buffer.ts`](../../src/transaction/write-buffer.ts)
