# CRUD Operations

You have a store and a bucket with a schema. Now it's time to work with data. Every bucket exposes the same set of operations through its `BucketHandle`: insert, get, update, delete, clear, and all. Each operation is validated against the schema, versioned automatically, and publishes an event. In this chapter you'll learn every operation in detail, understand record metadata, and see how validation and versioning work in practice.

## What You'll Learn

- How to insert records and what the store does behind the scenes
- How to read records by key and retrieve all records in a bucket
- How to update records and what fields are protected from changes
- How to delete individual records or clear an entire bucket
- What metadata fields (`_version`, `_createdAt`, `_updatedAt`, `_expiresAt`) mean and how they change
- How validation errors surface during writes

## Setup

All examples in this chapter use the following bucket definition:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'crud-demo' });

await store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    title:    { type: 'string', required: true, minLength: 1, maxLength: 200 },
    status:   { type: 'string', enum: ['todo', 'in_progress', 'done'], default: 'todo' },
    priority: { type: 'number', min: 1, max: 5, default: 3 },
    tags:     { type: 'array', default: [] },
  },
  indexes: ['status'],
});

const tasks = store.bucket('tasks');
```

## Insert

`insert(data)` creates a new record in the bucket:

```typescript
const task = await tasks.insert({
  title: 'Write documentation',
});

console.log(task);
// {
//   id: 'f47ac10b-58cc-…',       ← generated UUID
//   title: 'Write documentation',
//   status: 'todo',               ← default applied
//   priority: 3,                  ← default applied
//   tags: [],                     ← default applied
//   _version: 1,                  ← starts at 1
//   _createdAt: 1706745600000,    ← Unix ms when inserted
//   _updatedAt: 1706745600000,    ← same as _createdAt on insert
// }
```

### What Happens During Insert

```text
  insert(data)
      │
      ├── 1. Generate values for fields with `generated` (uuid, timestamp, …)
      ├── 2. Apply defaults for missing fields
      ├── 3. Attach metadata: _version = 1, _createdAt = now, _updatedAt = now
      ├── 4. Validate the complete record against the schema
      │      ├── Type checks
      │      ├── required, enum, min/max, minLength/maxLength, pattern, format
      │      └── Fail → throw ValidationError (record NOT stored)
      ├── 5. Check unique constraints
      │      └── Fail → throw UniqueConstraintError (record NOT stored)
      ├── 6. Add to TTL tracking (if bucket has TTL → set _expiresAt)
      ├── 7. Update indexes
      ├── 8. Store the record
      └── 9. Publish 'inserted' event
```

### Insert Returns the Complete Record

The returned object includes all generated values, applied defaults, and metadata. This is the record exactly as stored — no second read needed:

```typescript
const task = await tasks.insert({ title: 'Ship feature' });

// The generated UUID is immediately available
console.log(task.id);         // 'a1b2c3d4-…'
// Defaults are applied
console.log(task.status);     // 'todo'
console.log(task.priority);   // 3
// Metadata is attached
console.log(task._version);   // 1
```

### Insert Validation

If the data violates the schema, the insert fails and the record is not stored:

```typescript
// Missing required field
try {
  await tasks.insert({});
} catch (err) {
  console.log(err.name); // 'ValidationError'
  console.log(err.issues);
  // [{ field: 'title', message: 'Field is required', code: 'required' }]
}

// Invalid type
try {
  await tasks.insert({ title: 123 });
} catch (err) {
  console.log(err.issues);
  // [{ field: 'title', message: 'Expected type "string", got number', code: 'type' }]
}

// Constraint violation
try {
  await tasks.insert({ title: 'x', priority: 10 });
} catch (err) {
  console.log(err.issues);
  // [{ field: 'priority', message: 'Maximum value is 5', code: 'max' }]
}

// Multiple issues at once
try {
  await tasks.insert({ title: '', status: 'invalid', priority: 0 });
} catch (err) {
  console.log(err.issues.length); // 3
  // title: minLength, status: enum, priority: min
}
```

The validator collects all issues before throwing — it doesn't stop at the first failure.

## Get

`get(key)` retrieves a single record by its primary key:

```typescript
const task = await tasks.insert({ title: 'Review PR' });

// Retrieve by key
const found = await tasks.get(task.id);
console.log(found?.title); // 'Review PR'

// Non-existent key returns undefined
const missing = await tasks.get('does-not-exist');
console.log(missing); // undefined
```

`get()` returns the full record including metadata, or `undefined` if no record exists with that key. It never throws for a missing key.

## Update

`update(key, changes)` modifies an existing record:

```typescript
const task = await tasks.insert({ title: 'Deploy app' });
console.log(task._version);   // 1
console.log(task.status);     // 'todo'

const updated = await tasks.update(task.id, {
  status: 'in_progress',
  priority: 5,
});

console.log(updated.status);     // 'in_progress'
console.log(updated.priority);   // 5
console.log(updated.title);      // 'Deploy app' (unchanged)
console.log(updated._version);   // 2 (incremented)
console.log(updated._updatedAt > task._updatedAt); // true
```

### What Happens During Update

```text
  update(key, changes)
      │
      ├── 1. Look up existing record by key
      │      └── Not found → throw Error
      ├── 2. Strip protected fields from changes:
      │      ├── Metadata: _version, _createdAt, _updatedAt
      │      ├── Primary key field
      │      └── Generated fields
      ├── 3. Merge existing record with sanitized changes
      ├── 4. Bump _version (+1) and set _updatedAt to now
      ├── 5. Validate the merged record against the schema
      │      └── Fail → throw ValidationError (record NOT updated)
      ├── 6. Check unique constraints
      ├── 7. Update indexes
      ├── 8. Replace the stored record
      └── 9. Publish 'updated' event (with both oldRecord and newRecord)
```

### Partial Updates

You only need to send the fields you want to change. Unmentioned fields keep their existing values:

```typescript
const task = await tasks.insert({ title: 'Fix bug', priority: 4 });

// Only update status — title, priority, tags remain the same
const updated = await tasks.update(task.id, { status: 'done' });

console.log(updated.title);    // 'Fix bug'
console.log(updated.priority); // 4
console.log(updated.status);   // 'done'
```

### Protected Fields

Some fields cannot be changed via `update()`. The store silently strips them from the changes object:

| Protected Field | Reason |
|----------------|--------|
| Primary key | Immutable after insertion |
| Generated fields | Managed by the store (uuid, autoincrement, timestamp) |
| `_version` | Managed by the store (incremented automatically) |
| `_createdAt` | Immutable — records are created once |
| `_updatedAt` | Managed by the store (set to `Date.now()` on each update) |

```typescript
const task = await tasks.insert({ title: 'Test' });

// Trying to override protected fields — silently ignored
const updated = await tasks.update(task.id, {
  id: 'custom-id',     // Stripped — key is immutable
  _version: 999,       // Stripped — managed by store
  _createdAt: 0,       // Stripped — immutable
  title: 'Updated',    // Applied
});

console.log(updated.id);         // Original UUID, not 'custom-id'
console.log(updated._version);   // 2, not 999
console.log(updated._createdAt); // Original timestamp, not 0
console.log(updated.title);      // 'Updated'
```

### Update Validation

The merged record (existing + changes) is validated against the schema. This means constraints are checked on the final state, not just the changes:

```typescript
const task = await tasks.insert({ title: 'Valid task', priority: 3 });

// This fails because the merged record has an invalid status
try {
  await tasks.update(task.id, { status: 'cancelled' });
} catch (err) {
  console.log(err.issues);
  // [{ field: 'status', message: 'Value must be one of: todo, in_progress, done', code: 'enum' }]
}

// The record is unchanged after a failed update
const unchanged = await tasks.get(task.id);
console.log(unchanged?.status); // 'todo' (still the original value)
```

### Update Non-Existent Record

Updating a key that doesn't exist throws an error:

```typescript
try {
  await tasks.update('non-existent-id', { title: 'Nope' });
} catch (err) {
  console.log(err.message); // Error about record not found
}
```

## Delete

`delete(key)` removes a record by its primary key:

```typescript
const task = await tasks.insert({ title: 'Temporary task' });
console.log(await tasks.get(task.id)); // { id: '…', title: 'Temporary task', … }

await tasks.delete(task.id);
console.log(await tasks.get(task.id)); // undefined
```

Deleting a non-existent key is a no-op — it doesn't throw:

```typescript
// Safe to call even if the record doesn't exist
await tasks.delete('already-deleted');
// No error
```

After deletion, the store publishes a `deleted` event containing the full deleted record.

## Clear

`clear()` removes all records from a bucket:

```typescript
await tasks.insert({ title: 'Task 1' });
await tasks.insert({ title: 'Task 2' });
await tasks.insert({ title: 'Task 3' });

console.log(await tasks.count()); // 3

await tasks.clear();

console.log(await tasks.count()); // 0
```

`clear()` removes all data but the bucket definition, schema, and indexes remain intact. You can insert new records immediately after clearing.

## All

`all()` retrieves every record in the bucket:

```typescript
await tasks.insert({ title: 'Task A' });
await tasks.insert({ title: 'Task B' });
await tasks.insert({ title: 'Task C' });

const all = await tasks.all();
console.log(all.length); // 3
console.log(all.map((t) => t.title)); // ['Task A', 'Task B', 'Task C']
```

Each record in the array includes all fields and metadata. For large buckets, consider using `paginate()` instead (covered in the Querying chapter).

## Record Metadata

Every record in the store carries four metadata fields, managed exclusively by the store:

```text
  ┌───────────────────────────────────────────────────────────────┐
  │                        RECORD                                  │
  │                                                                │
  │   ┌──────────────────────────────────────────────────────┐    │
  │   │  Your data: id, title, status, priority, tags, …     │    │
  │   └──────────────────────────────────────────────────────┘    │
  │                                                                │
  │   ┌──────────────────────────────────────────────────────┐    │
  │   │  Metadata (managed by the store)                      │    │
  │   │                                                       │    │
  │   │  _version    : 1 → 2 → 3 → …  (on each update)     │    │
  │   │  _createdAt  : 1706745600000   (set once on insert)  │    │
  │   │  _updatedAt  : 1706745600000   (reset on each write) │    │
  │   │  _expiresAt? : 1706832000000   (TTL buckets only)    │    │
  │   └──────────────────────────────────────────────────────┘    │
  └───────────────────────────────────────────────────────────────┘
```

### `_version`

An integer counter that starts at `1` on insert and increments by `1` on every update:

```typescript
const task = await tasks.insert({ title: 'Versioned task' });
console.log(task._version); // 1

const v2 = await tasks.update(task.id, { status: 'in_progress' });
console.log(v2._version); // 2

const v3 = await tasks.update(task.id, { status: 'done' });
console.log(v3._version); // 3
```

The version field is the foundation of optimistic locking in transactions. When a transaction reads a record and later writes to it, the store checks that `_version` hasn't changed since the read. If it has, the transaction fails with a `TransactionConflictError`.

### `_createdAt`

A Unix timestamp in milliseconds, set once when the record is inserted. It never changes:

```typescript
const task = await tasks.insert({ title: 'Created once' });
console.log(task._createdAt); // e.g., 1706745600000

const updated = await tasks.update(task.id, { title: 'Updated title' });
console.log(updated._createdAt === task._createdAt); // true — never changes
```

`_createdAt` is also used for eviction order in `maxSize` buckets — when the bucket is full, the record with the smallest `_createdAt` is evicted first.

### `_updatedAt`

A Unix timestamp in milliseconds, set on insert and updated on every subsequent write:

```typescript
const task = await tasks.insert({ title: 'Track changes' });
console.log(task._updatedAt === task._createdAt); // true — same on insert

// Wait briefly to get a different timestamp
const updated = await tasks.update(task.id, { priority: 1 });
console.log(updated._updatedAt >= task._updatedAt); // true — updated
```

### `_expiresAt`

Only present on records in TTL-enabled buckets. Set automatically based on `_createdAt` + the bucket's TTL duration:

```typescript
const store = await Store.start({ name: 'ttl-meta' });

await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token:  { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '1h', // 1 hour
});

const sessions = store.bucket('sessions');
const session = await sessions.insert({ userId: 'alice' });

console.log(session._expiresAt);
// _createdAt + 3600000 (1 hour in ms)
console.log(session._expiresAt! - session._createdAt); // 3600000

await store.stop();
```

The TTL manager periodically checks `_expiresAt` against the current time and purges expired records.

## The Flow of a Record

Here's the complete lifecycle of a record through insert, multiple updates, and deletion:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'lifecycle-demo' });

  await store.defineBucket('tasks', {
    key: 'id',
    schema: {
      id:     { type: 'string', generated: 'uuid' },
      title:  { type: 'string', required: true },
      status: { type: 'string', enum: ['todo', 'in_progress', 'done'], default: 'todo' },
    },
  });

  const tasks = store.bucket('tasks');

  // 1. Insert — record is born
  const task = await tasks.insert({ title: 'Ship v1.0' });
  console.log(`Created: v${task._version}, status=${task.status}`);
  // Created: v1, status=todo

  // 2. First update — version bumps
  const v2 = await tasks.update(task.id, { status: 'in_progress' });
  console.log(`Updated: v${v2._version}, status=${v2.status}`);
  // Updated: v2, status=in_progress

  // 3. Second update — version bumps again
  const v3 = await tasks.update(task.id, { status: 'done' });
  console.log(`Updated: v${v3._version}, status=${v3.status}`);
  // Updated: v3, status=done

  // 4. Read — returns latest state
  const current = await tasks.get(task.id);
  console.log(`Read: v${current?._version}, status=${current?.status}`);
  // Read: v3, status=done

  // 5. Delete — record is gone
  await tasks.delete(task.id);
  const deleted = await tasks.get(task.id);
  console.log(`After delete: ${deleted}`);
  // After delete: undefined

  await store.stop();
}

main();
```

## Complete Example

A practical example: managing a product catalog with validation, updates, and metadata inspection.

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'product-catalog' });

  await store.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:         { type: 'string', required: true, pattern: '^[A-Z]{2,4}-\\d{3,6}$' },
      name:        { type: 'string', required: true, minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      price:       { type: 'number', required: true, min: 0.01 },
      currency:    { type: 'string', enum: ['USD', 'EUR', 'GBP'], default: 'USD' },
      inStock:     { type: 'boolean', default: true },
      tags:        { type: 'array', default: [] },
    },
    indexes: ['currency', 'inStock'],
  });

  const products = store.bucket('products');

  // Insert products
  const widget = await products.insert({
    sku: 'WDG-001',
    name: 'Standard Widget',
    price: 9.99,
    tags: ['widget', 'standard'],
  });

  const gadget = await products.insert({
    sku: 'GDG-042',
    name: 'Premium Gadget',
    description: 'A premium gadget with advanced features',
    price: 49.99,
    currency: 'EUR',
    tags: ['gadget', 'premium'],
  });

  // Read
  const found = await products.get('WDG-001');
  console.log(`${found?.name}: ${found?.currency} ${found?.price}`);
  // Standard Widget: USD 9.99

  // Update price
  const updated = await products.update('WDG-001', { price: 12.99 });
  console.log(`New price: ${updated.price}, version: ${updated._version}`);
  // New price: 12.99, version: 2

  // Mark out of stock
  const outOfStock = await products.update('GDG-042', { inStock: false });
  console.log(`In stock: ${outOfStock.inStock}`);
  // In stock: false

  // List all
  const all = await products.all();
  console.log(`Products: ${all.length}`);
  // Products: 2

  // Validation catches bad data
  try {
    await products.insert({ sku: 'bad', name: 'Oops', price: -5 });
  } catch (err) {
    for (const issue of err.issues) {
      console.log(`  ${issue.field}: ${issue.message} (${issue.code})`);
    }
    // sku: Value must match pattern "^[A-Z]{2,4}-\d{3,6}$" (pattern)
    // price: Minimum value is 0.01 (min)
  }

  // Delete and verify
  await products.delete('WDG-001');
  console.log(`After delete: ${await products.get('WDG-001')}`);
  // After delete: undefined

  // Clear everything
  await products.clear();
  console.log(`After clear: ${(await products.all()).length} products`);
  // After clear: 0 products

  await store.stop();
}

main();
```

## Exercise

Given this bucket definition:

```typescript
await store.defineBucket('employees', {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    name:       { type: 'string', required: true, minLength: 1 },
    department: { type: 'string', enum: ['engineering', 'design', 'marketing', 'sales'] },
    salary:     { type: 'number', required: true, min: 30000, max: 500000 },
    active:     { type: 'boolean', default: true },
  },
  indexes: ['department'],
});

const employees = store.bucket('employees');
```

Predict the result of each operation:

```typescript
// 1. What does this return?
const emp = await employees.insert({ name: 'Alice', department: 'engineering', salary: 120000 });
console.log(emp.id, emp.active, emp._version);

// 2. What does this return?
const updated = await employees.update(emp.id, { salary: 135000, id: 999 });
console.log(updated.id, updated.salary, updated._version);

// 3. Does this throw? If so, what error?
await employees.insert({ name: 'Bob', salary: 25000 });

// 4. Does this throw? If so, what error?
await employees.update(emp.id, { department: 'hr' });

// 5. What does this return?
await employees.delete(emp.id);
const result = await employees.get(emp.id);
console.log(result);
```

<details>
<summary>Solution</summary>

**1.** `1 true 1`
- `id` is `1` because `autoincrement` starts at 1.
- `active` is `true` because the default is applied.
- `_version` is `1` because it's a new record.

**2.** `1 135000 2`
- `id` is still `1` — the `id: 999` in the changes is stripped because the primary key is immutable.
- `salary` is `135000` — the update is applied.
- `_version` is `2` — incremented on update.

**3.** Yes, `ValidationError` with `{ field: 'salary', code: 'min', message: 'Minimum value is 30000' }`.
The salary `25000` is below the minimum of `30000`.

**4.** Yes, `ValidationError` with `{ field: 'department', code: 'enum', message: 'Value must be one of: engineering, design, marketing, sales' }`.
`'hr'` is not in the enum list.

**5.** `undefined`
The record was deleted, so `get()` returns `undefined`.

</details>

## Summary

- **`insert(data)`** creates a record — generates values, applies defaults, validates, stores, and publishes an `inserted` event
- **`get(key)`** retrieves a record by primary key — returns `undefined` if not found
- **`update(key, changes)`** partially updates a record — strips protected fields, validates the merged result, bumps `_version`, publishes an `updated` event
- **`delete(key)`** removes a record — silent if the key doesn't exist, publishes a `deleted` event
- **`clear()`** removes all records — bucket definition and schema remain intact
- **`all()`** returns every record in the bucket including metadata
- Every record carries automatic metadata: `_version` (optimistic locking), `_createdAt` (immutable birth timestamp), `_updatedAt` (last modification), and optionally `_expiresAt` (TTL)
- Validation collects all issues before throwing — the record is never stored on failure
- Protected fields (key, generated, metadata) are silently stripped from update payloads

---

Next: [Field Constraints](../03-schema-validation/01-field-constraints.md)
