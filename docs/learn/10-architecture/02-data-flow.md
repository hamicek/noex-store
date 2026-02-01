# Data Flow

You call `users.insert({ name: 'Alice' })` and get back a fully formed record with a generated UUID, metadata fields, and validation guarantees. But what actually happened between your call and the response? Which components touched the data, in what order, and where did the events come from?

Understanding the data flow is essential for debugging, performance reasoning, and extending the store. When something goes wrong — a validation error, a unique constraint violation, an unexpected event — knowing exactly which step in the pipeline produced the error tells you where to look. This chapter traces the complete lifecycle of every mutation and query operation through the store's internals.

## What You'll Learn

- The exact sequence of steps during an insert, from BucketHandle to stored record
- How updates merge changes, bump versions, and re-validate
- How deletes clean up indexes and emit events
- How queries decide between index lookup and full table scan
- How transactions batch operations across multiple buckets
- How events flow from BucketServer through EventBus to reactive queries

## Insert: The Complete Path

An insert is the most complex operation because it involves every component. Here's the full path:

```text
  Application Code
        │
        │  users.insert({ name: 'Alice', email: 'alice@example.com' })
        │
        ▼
  BucketHandle
        │
        │  GenServer.call(ref, { type: 'insert', data: { name: 'Alice', ... } })
        │
        ▼
  BucketServer (GenServer mailbox)
        │
        ├── 1. Increment autoincrement counter
        │
        ├── 2. SchemaValidator.prepareInsert(data, counter)
        │       │
        │       ├── Copy input data
        │       ├── Generate values (uuid, cuid, autoincrement, timestamp)
        │       ├── Apply default values (static or functional)
        │       ├── Attach metadata:
        │       │     _version = 1
        │       │     _createdAt = Date.now()
        │       │     _updatedAt = Date.now()
        │       ├── Validate all fields against schema
        │       │     → On failure: throw ValidationError (record is NOT stored)
        │       └── Return prepared StoreRecord
        │
        ├── 3. Extract primary key from prepared record
        │
        ├── 4. TTL check: if bucket has ttl AND record has no _expiresAt
        │       → Set _expiresAt = _createdAt + ttlMs
        │
        ├── 5. MaxSize check: if table.size >= maxSize
        │       → Evict oldest records (by _createdAt) until under limit
        │       → Each eviction: remove from indexes, delete from table, emit event
        │
        ├── 6. IndexManager.addRecord(key, record)
        │       │
        │       ├── Phase 1: Validate ALL unique constraints
        │       │     → On conflict: throw UniqueConstraintError (no partial writes)
        │       │
        │       └── Phase 2: Write to all indexes
        │             Unique:     valueToKey.set(value, primaryKey)
        │             Non-unique: valueToKeys.get(value).add(primaryKey)
        │
        ├── 7. table.set(key, record)
        │
        └── 8. EventBus.publish('bucket.users.inserted', event)
                │
                └── Event payload:
                    { type: 'inserted', bucket: 'users', key, record }
```

### Step by Step

**Step 1 — Counter increment**: The autoincrement counter is bumped unconditionally on every insert, even if no field uses `generated: 'autoincrement'`. This keeps the counter monotonically increasing across all inserts, so autoincrement values never collide.

**Step 2 — Schema validation and preparation**: The `SchemaValidator` is the gatekeeper. It generates values for auto-generated fields (`uuid`, `cuid`, `autoincrement`, `timestamp`), fills in defaults, and attaches metadata (`_version`, `_createdAt`, `_updatedAt`). Then it validates every field against the schema — type, required, enum, min/max, pattern, format. If any field fails validation, a `ValidationError` is thrown with an array of issues, and the record is never stored.

```typescript
// ValidationError contains structured issues:
// {
//   field: 'email',
//   message: 'Invalid email format',
//   code: 'format'
// }
```

**Step 3 — Key extraction**: The primary key value is read from the prepared record using `definition.key`. For example, if `key: 'id'` and the record has `id: 'abc-123'`, the key is `'abc-123'`.

**Step 4 — TTL**: If the bucket has a `ttl` configured and the record doesn't already have an `_expiresAt` (no per-record override), the store computes `_expiresAt = _createdAt + ttlMs`.

**Step 5 — Eviction**: If the bucket has a `maxSize` and the table is at capacity, the oldest records (sorted by `_createdAt`) are evicted. Each eviction removes the record from indexes, deletes it from the table, and publishes a `deleted` event — so subscribers see evictions as normal deletes.

**Step 6 — Indexing**: The `IndexManager` uses a two-phase approach. First, it validates all unique constraints without modifying any index. If a unique violation is found, it throws `UniqueConstraintError` immediately — no partial index writes occur. Only after all constraints pass does it write to the indexes.

**Step 7 — Storage**: The record is added to the table Map with the primary key.

**Step 8 — Event**: The insert event is published to the EventBus. This triggers event handlers (`store.on()`), reactive query re-evaluations, and persistence snapshots (debounced).

### When Things Fail

| Step | Error | Record Stored? | Indexes Modified? | Event Published? |
|------|-------|---------------|-------------------|-----------------|
| 2 | `ValidationError` | No | No | No |
| 6 | `UniqueConstraintError` | No | No | No |
| 1-7 | Unexpected error | No | Depends | No |

Validation and unique constraint checks happen **before** the record is stored or indexes are modified. The operation is atomic within the GenServer — either everything succeeds or nothing changes.

## Update: Merge, Validate, Store

An update takes the existing record, merges in changes, bumps the version, and re-validates:

```text
  users.update('abc-123', { name: 'Alice Smith' })
        │
        ▼
  BucketServer
        │
        ├── 1. Fetch existing record: table.get('abc-123')
        │       → Not found? Throw error
        │
        ├── 2. SchemaValidator.prepareUpdate(existing, changes)
        │       │
        │       ├── Sanitize changes:
        │       │     Delete _version, _createdAt, _updatedAt (immutable metadata)
        │       │     Delete primary key field (immutable)
        │       │     Delete generated fields (immutable)
        │       │
        │       ├── Merge: { ...existing, ...sanitizedChanges }
        │       │
        │       ├── Bump version: _version = existing._version + 1
        │       │
        │       ├── Update timestamp: _updatedAt = Date.now()
        │       │
        │       └── Validate merged record against schema
        │             → On failure: throw ValidationError
        │
        ├── 3. IndexManager.updateRecord(key, oldRecord, newRecord)
        │       │
        │       ├── Phase 1: For each unique index with a CHANGED value:
        │       │     Check if new value already exists (skip if same key)
        │       │     → On conflict: throw UniqueConstraintError
        │       │
        │       └── Phase 2: Update indexes for changed fields only
        │             Remove old entry, add new entry
        │
        ├── 4. table.set(key, updatedRecord)
        │
        └── 5. EventBus.publish('bucket.users.updated', {
                  type: 'updated',
                  bucket: 'users',
                  key: 'abc-123',
                  oldRecord: { ... },
                  newRecord: { ... }
                })
```

### What You Can't Change

The update sanitizer strips certain fields from the changes object before merging:

| Field | Why Immutable |
|-------|--------------|
| Primary key | Changing the key would break references and index entries |
| `generated` fields | Auto-generated values are set once at insert time |
| `_version` | Managed by the store for optimistic locking |
| `_createdAt` | Records the original insertion time |
| `_updatedAt` | Managed by the store on each update |

If you pass these in the changes object, they're silently ignored — no error is thrown.

### Index Optimization

The IndexManager only updates indexes for fields whose values actually changed. If you update `{ name: 'Alice Smith' }` and `name` is not indexed, no index operations occur. If `email` is indexed but you didn't change it, its index entry remains untouched. This avoids unnecessary index churn.

## Delete: Clean and Notify

Deletes are the simplest mutation — remove from indexes, remove from table, publish event:

```text
  users.delete('abc-123')
        │
        ▼
  BucketServer
        │
        ├── 1. Fetch record: table.get('abc-123')
        │       → Not found? Return silently (idempotent)
        │
        ├── 2. IndexManager.removeRecord(key, record)
        │       → Remove from all indexes (unique and non-unique)
        │
        ├── 3. table.delete(key)
        │
        └── 4. EventBus.publish('bucket.users.deleted', {
                  type: 'deleted',
                  bucket: 'users',
                  key: 'abc-123',
                  record: { ... }  // The deleted record
                })
```

Deletes are **idempotent**. Deleting a key that doesn't exist is a no-op — no error, no event. This makes it safe to retry deletes without worrying about double-processing.

## Query: Index Lookup vs Full Scan

When you call `where()`, the BucketServer decides whether to use an index or scan the entire table:

```text
  users.where({ email: 'alice@example.com', role: 'admin' })
        │
        ▼
  BucketServer
        │
        ├── 1. Check filter fields against IndexManager
        │       │
        │       ├── Is 'email' indexed? → YES (unique index)
        │       │     indexManager.lookup('email', 'alice@example.com')
        │       │     → Returns [primaryKey] (0 or 1 keys for unique)
        │       │
        │       └── Use 'email' as the index field
        │
        ├── 2. Fetch candidate records from table using returned keys
        │       → table.get(primaryKey) for each key
        │
        ├── 3. Apply remaining filter: check { role: 'admin' } on candidates
        │       → Keep records where record.role === 'admin'
        │
        └── 4. Return matching records
```

### Decision Logic

```text
  Filter: { email: 'alice@example.com', role: 'admin' }
        │
        ├── Check each field in filter order:
        │     email → indexed? YES → use as index field, stop
        │
        │   (If 'email' were not indexed:)
        │     role → indexed? YES → use as index field
        │
        │   (If neither indexed:)
        │     → Full table scan: iterate ALL records, test ALL fields
        │
        └── Apply remaining (non-index) filter fields on candidates
```

| Scenario | Index Used | Records Scanned | Performance |
|----------|-----------|----------------|-------------|
| Indexed field in filter | Yes | Only indexed matches | O(1) lookup + O(k) filter, k = matches |
| No indexed field | No | Entire table | O(n) scan, n = total records |
| Multiple indexed fields | First match | Indexed matches for first field | Remaining fields applied as post-filter |

The index manager checks fields in the order they appear in the filter object. The first indexed field found is used for the initial narrowing. All remaining fields are applied as post-filters on the candidate set.

### Unique vs Non-Unique Index Lookup

```text
  Unique index on 'email':
    lookup('email', 'alice@example.com')
    → valueToKey.get('alice@example.com')
    → Returns: ['abc-123']  (at most 1 key)

  Non-unique index on 'role':
    lookup('role', 'admin')
    → valueToKeys.get('admin')
    → Returns: ['abc-123', 'def-456', 'ghi-789']  (0 to N keys)
```

Unique indexes return 0 or 1 keys. Non-unique indexes return 0 to N keys. Both avoid a full table scan.

## Event Propagation

Every mutation publishes an event. Here's how events flow through the system:

```text
  BucketServer publishes event
        │
        │  EventBus.publish('bucket.users.inserted', payload)
        │
        ▼
  EventBus
        │
        ├────────────────────┬─────────────────────┐
        │                    │                      │
        ▼                    ▼                      ▼
  store.on() handlers   QueryManager          StorePersistence
        │               .onBucketChange()     .onBucketChange()
        │                    │                      │
        │                    │                      │
  User callbacks        Re-evaluate           Mark bucket dirty,
  (audit log,           affected              schedule debounced
   notifications,       subscriptions         snapshot
   cascading deletes)
```

### QueryManager Event Handling

When a bucket change event arrives, the QueryManager identifies affected subscriptions through its dependency indexes:

```text
  onBucketChange('users', 'abc-123')
        │
        ├── Bucket-level index: "users" → {sub-1, sub-3, sub-5}
        │     All subscriptions that used all(), where(), count(), etc. on 'users'
        │
        ├── Record-level index: "users"/"abc-123" → {sub-2}
        │     Subscriptions that called get('abc-123') on 'users'
        │
        └── Merge: {sub-1, sub-2, sub-3, sub-5}
              │
              └── For each subscription:
                    1. Re-execute query with fresh QueryContext
                    2. Compare result with previous (deepEqual)
                    3. If different → call subscriber callback
                    4. If same → skip (no unnecessary re-renders)
```

The two-level dependency tracking means a query that only calls `get('abc-123')` on the users bucket won't re-execute when a completely different user record changes. Only bucket-level operations (`all`, `where`, `count`, etc.) trigger on any change in the bucket.

### StorePersistence Event Handling

```text
  onBucketChange('users')
        │
        ├── Add 'users' to dirtyBuckets set
        │
        ├── If no debounce timer running:
        │     → Start timer (default: 100ms)
        │
        └── When timer fires:
              │
              ├── For each dirty bucket:
              │     GenServer.call(ref, { type: 'getSnapshot' })
              │     → Returns { records: [...], autoincrementCounter }
              │     adapter.save(key, snapshot)
              │
              └── Clear dirtyBuckets set
```

Persistence is **debounced** — multiple rapid changes to the same bucket result in a single snapshot write after the debounce period. This prevents I/O storms during bulk operations.

## Transaction: Multi-Bucket Atomic Writes

Transactions follow a buffered write pattern. All writes are buffered locally, then committed to each bucket atomically:

```text
  store.transaction(async (tx) => {
    const users = await tx.bucket('users');
    const orders = await tx.bucket('orders');
    await users.insert({ name: 'Alice' });
    await orders.insert({ userId: 'alice-id', amount: 99 });
  })
        │
        ▼
  TransactionContext
        │
        │  Phase 1: Execute callback
        │
        ├── tx.bucket('users') → TransactionBucketHandle
        │     │
        │     └── users.insert({ name: 'Alice' })
        │           │
        │           ├── SchemaValidator.prepareInsert() (local validation)
        │           ├── Add to WriteBuffer: inserts.set(key, record)
        │           └── Return record (optimistic, not yet committed)
        │
        ├── tx.bucket('orders') → TransactionBucketHandle
        │     │
        │     └── orders.insert({ userId: 'alice-id', amount: 99 })
        │           │
        │           ├── SchemaValidator.prepareInsert() (local validation)
        │           ├── Add to WriteBuffer: inserts.set(key, record)
        │           └── Return record (optimistic, not yet committed)
        │
        │  Phase 2: Commit (after callback completes)
        │
        ├── For each bucket with buffered writes (sequentially):
        │     │
        │     ├── Build commit operations from buffer
        │     │
        │     ├── GenServer.call(ref, { type: 'commitBatch', operations })
        │     │     │
        │     │     ├── Validate ALL operations (no mutations yet):
        │     │     │     Check unique constraints
        │     │     │     Check version matches (for updates/deletes)
        │     │     │     Check key doesn't exist (for inserts)
        │     │     │     → On failure: throw TransactionConflictError
        │     │     │
        │     │     ├── Apply ALL operations:
        │     │     │     Update indexes, store records, collect events
        │     │     │
        │     │     └── Return { events, undoOps }
        │     │
        │     └── Track undo operations for rollback
        │
        ├── If ALL buckets committed successfully:
        │     → Publish all collected events
        │
        └── If ANY bucket failed:
              → Rollback previously committed buckets (reverse order)
              → GenServer.call(ref, { type: 'rollbackBatch', undoOps })
              → Re-throw the original error
```

### Read-Your-Own-Writes

Inside a transaction, reads see uncommitted writes from the same transaction:

```text
  TransactionBucketHandle.get(key)
        │
        ├── Check WriteBuffer overlay:
        │     │
        │     ├── Key in deletes → return undefined
        │     ├── Key in inserts → return buffered record
        │     ├── Key in updates → return buffered record
        │     └── Key not in buffer → fall through
        │
        └── GenServer.call(ref, { type: 'get', key })
              → Read from actual BucketServer
```

The overlay is applied for all read operations (`get`, `all`, `where`, `findOne`, `count`). This means you can insert a record and immediately query it within the same transaction — even though it hasn't been committed to the BucketServer yet.

### Rollback on Failure

If the second bucket's commit fails, the first bucket's changes are rolled back:

```text
  Bucket 1 (users):  commitBatch → SUCCESS → undo ops saved
  Bucket 2 (orders): commitBatch → FAILURE → TransactionConflictError
        │
        └── Rollback:
              Bucket 1: rollbackBatch(undoOps)
                → For each undo operation:
                    'undoInsert': delete the record, remove from indexes
                    'undoUpdate': restore old record, revert indexes
                    'undoDelete': re-insert the record, add to indexes
```

Rollback is **best-effort** — if a rollback call fails (e.g., the bucket crashed), the error is swallowed and rollback continues for remaining buckets. This means there's a theoretical window where a crash during rollback can leave partial data, but in practice, BucketServer crashes are rare, and the data is in-memory (lost on crash anyway).

## Complete Request Lifecycle Diagram

Putting it all together — from a user's `insert()` call through every component and back:

```text
  ┌──────────────┐
  │ Application  │
  │    Code      │
  └──────┬───────┘
         │ users.insert({ name: 'Alice', email: 'alice@ex.com' })
         ▼
  ┌──────────────┐
  │ BucketHandle │  Stateless proxy
  │              │  Sends GenServer.call()
  └──────┬───────┘
         │
         ▼
  ┌──────────────────────────────────────────────┐
  │              BucketServer (GenServer)          │
  │                                                │
  │  ┌─────────────────┐                          │
  │  │ SchemaValidator  │  Validate, generate,     │
  │  │                  │  attach metadata          │
  │  └────────┬────────┘                          │
  │           │                                    │
  │  ┌────────▼────────┐                          │
  │  │  IndexManager   │  Two-phase: validate      │
  │  │                 │  unique, then write        │
  │  └────────┬────────┘                          │
  │           │                                    │
  │  ┌────────▼────────┐                          │
  │  │   table (Map)   │  Store the record         │
  │  └────────┬────────┘                          │
  │           │                                    │
  └───────────┼────────────────────────────────────┘
              │
              │ EventBus.publish('bucket.users.inserted', ...)
              ▼
  ┌──────────────────────────────────────────────┐
  │                 EventBus                       │
  │                                                │
  │  Subscribers:                                  │
  │    ├── store.on('bucket.users.*') handlers    │
  │    ├── QueryManager.onBucketChange()          │
  │    └── StorePersistence.onBucketChange()      │
  │                                                │
  └──────────────────────────────────────────────┘
              │
      ┌───────┼───────┐
      ▼       ▼       ▼
  Callbacks  Reactive  Persistence
             Queries   Snapshot
             re-eval   (debounced)
```

## Complete Working Example

A step-by-step trace of operations through the system:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'trace' });

  await store.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:      { type: 'string', required: true },
      name:     { type: 'string', required: true },
      price:    { type: 'number', min: 0, required: true },
      category: { type: 'string', enum: ['electronics', 'clothing', 'food'] },
      stock:    { type: 'number', min: 0, default: 0 },
    },
    indexes: ['category'],
  });

  const products = store.bucket('products');

  // --- INSERT ---
  // Path: BucketHandle → GenServer.call → prepareInsert → addRecord → table.set → publish
  const laptop = await products.insert({
    sku: 'LAPTOP-001',
    name: 'Pro Laptop',
    price: 1299,
    category: 'electronics',
    stock: 50,
  });
  // laptop._version === 1, laptop._createdAt === Date.now()

  // --- QUERY (indexed) ---
  // Path: BucketHandle → GenServer.call → lookup('category', 'electronics') → post-filter → return
  const electronics = await products.where({ category: 'electronics' });
  console.log(electronics.length); // 1

  // --- QUERY (full scan) ---
  // 'name' is not indexed → full table scan, check every record
  const byName = await products.where({ name: 'Pro Laptop' });
  console.log(byName.length); // 1

  // --- UPDATE ---
  // Path: BucketHandle → GenServer.call → prepareUpdate (merge + validate) → updateRecord → table.set → publish
  const updated = await products.update('LAPTOP-001', { price: 1199, stock: 45 });
  console.log(updated._version); // 2
  console.log(updated.price);    // 1199
  // name, sku, category unchanged — indexes for 'category' not touched

  // --- DELETE ---
  // Path: BucketHandle → GenServer.call → removeRecord → table.delete → publish
  await products.delete('LAPTOP-001');

  // Idempotent: deleting again is a no-op
  await products.delete('LAPTOP-001');

  // --- AGGREGATION ---
  await products.insert({ sku: 'A', name: 'Item A', price: 100, category: 'food', stock: 10 });
  await products.insert({ sku: 'B', name: 'Item B', price: 200, category: 'food', stock: 20 });
  await products.insert({ sku: 'C', name: 'Item C', price: 300, category: 'clothing', stock: 5 });

  // Path: GenServer.call → selectWhere (index on 'category') → sum 'price' over results
  const foodTotal = await products.sum('price', { category: 'food' });
  console.log(foodTotal); // 300

  // Path: GenServer.call → all records → compute average
  const avgPrice = await products.avg('price');
  console.log(avgPrice); // 200

  await store.stop();
}

main();
```

## Exercise

You're investigating a performance issue. A bucket with 100,000 records is slow when querying `where({ status: 'active', region: 'EU' })`. Neither field is indexed.

1. Trace the query through the data flow. How many records does the BucketServer scan?
2. You add `indexes: ['status']` to the bucket definition. Trace the query again. How many records are scanned now?
3. The `status` field has 3 possible values: `'active'`, `'inactive'`, `'pending'`. Roughly how many records does the index return for `status: 'active'`? Is this a good index?
4. Instead, you add `indexes: ['region']` (10 possible regions, roughly equal distribution). Trace the query. Is this a better index choice?
5. What if you add both `indexes: ['status', 'region']`? Does the query use both indexes?

<details>
<summary>Solution</summary>

**1. No index — full table scan:**

The BucketServer iterates all 100,000 records, checking `record.status === 'active' && record.region === 'EU'` on each one. Total records scanned: 100,000.

**2. Index on `status`:**

```text
  lookup('status', 'active')
    → Returns ~33,333 primary keys (1/3 of 100k, assuming equal distribution)
    → Fetch those records from the table
    → Post-filter: check record.region === 'EU' on each
    → Return matches
```

Records scanned: ~33,333 (the active ones). Better than 100k, but still scanning a third of the table.

**3. Is `status` a good index?**

With only 3 possible values, each value matches roughly 33% of records. This is **low selectivity** — the index eliminates only 2/3 of records. Not a great index for large tables.

**4. Index on `region`:**

```text
  lookup('region', 'EU')
    → Returns ~10,000 primary keys (1/10 of 100k)
    → Post-filter: check record.status === 'active' on each
    → Return matches
```

Records scanned: ~10,000. Much better. With 10 regions, each matches ~10% of records — **higher selectivity** than status.

**5. Both indexes:**

The query does NOT use both indexes. The BucketServer uses the **first** indexed field it finds in the filter object. If the filter is `{ status: 'active', region: 'EU' }`, it uses `status` first (because it appears first in the filter). If you swap the order to `{ region: 'EU', status: 'active' }`, it uses `region` first.

The store does not perform index intersection (combining results from multiple indexes). To optimize this query, put the more selective field first in the filter, or design your schema so the first indexed field in the filter is the most selective.

</details>

## Summary

- **Insert path**: BucketHandle → GenServer.call → increment counter → SchemaValidator.prepareInsert (generate, default, metadata, validate) → TTL check → maxSize eviction → IndexManager.addRecord (two-phase: validate unique, then write) → table.set → EventBus.publish
- **Update path**: fetch existing → SchemaValidator.prepareUpdate (sanitize, merge, bump version, validate) → IndexManager.updateRecord (only changed fields) → table.set → EventBus.publish
- **Delete path**: fetch record → IndexManager.removeRecord → table.delete → EventBus.publish; deletes are idempotent
- **Query path**: check filter fields against IndexManager → if indexed: lookup keys, fetch records, post-filter remaining fields; if no index: full table scan
- Indexes use the **first indexed field** found in the filter — no index intersection; put the most selective field first
- **Events** flow from BucketServer through EventBus to three subscribers: user handlers (`store.on`), QueryManager (reactive query re-evaluation), and StorePersistence (debounced snapshots)
- **Transactions** buffer writes locally, then commit bucket-by-bucket; read-your-own-writes via overlay on the write buffer; rollback on failure via undo operations
- The IndexManager uses a **two-phase approach** for all writes: validate all constraints first, then write — preventing partial index corruption
- **Validation errors** and **unique constraint violations** fail fast before any state is modified

---

Next: [Bridge Setup](../11-rules-bridge/01-bridge-setup.md)
