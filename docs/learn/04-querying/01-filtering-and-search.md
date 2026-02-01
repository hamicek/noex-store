# Filtering and Search

You can insert, read, update, and delete records by key. But applications rarely need just one record at a time. You need answers to questions like "which orders are pending?", "how many users signed up today?", or "give me the first five tasks." Scanning every record manually and filtering in application code is tedious, error-prone, and scatters query logic across the codebase.

noex-store gives every bucket a set of query methods that handle filtering, counting, and ordered retrieval in a single call. All queries use strict-equality AND matching — simple to reason about, easy to compose, and fast when backed by secondary indexes.

## What You'll Learn

- How `where()` filters records by field values using AND logic
- How `findOne()` retrieves a single matching record
- How `count()` returns the total or filtered number of records
- How `first()` and `last()` retrieve records from the beginning or end of the bucket
- How filters compose and what "strict equality" means in practice
- When to use each query method and what to expect for edge cases

## Setup

All examples in this chapter use the following bucket:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'querying-demo' });

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    customer: { type: 'string', required: true },
    status:   { type: 'string', enum: ['pending', 'shipped', 'delivered', 'cancelled'], default: 'pending' },
    total:    { type: 'number', required: true, min: 0 },
    region:   { type: 'string', enum: ['us', 'eu', 'asia'] },
  },
  indexes: ['status', 'region'],
});

const orders = store.bucket('orders');
```

## `where()` — Filter by Field Values

`where(filter)` returns all records that match every field in the filter object. The matching uses strict equality (`===`) and AND logic — every condition must hold:

```typescript
await orders.insert({ customer: 'Alice', status: 'pending', total: 50, region: 'us' });
await orders.insert({ customer: 'Bob', status: 'shipped', total: 120, region: 'eu' });
await orders.insert({ customer: 'Carol', status: 'pending', total: 80, region: 'us' });
await orders.insert({ customer: 'Dave', status: 'delivered', total: 200, region: 'asia' });
await orders.insert({ customer: 'Eve', status: 'pending', total: 30, region: 'eu' });

// Single-field filter
const pending = await orders.where({ status: 'pending' });
console.log(pending.length); // 3

// Multi-field filter (AND logic)
const pendingUs = await orders.where({ status: 'pending', region: 'us' });
console.log(pendingUs.length); // 2
console.log(pendingUs.map((o) => o.customer)); // ['Alice', 'Carol']
```

### How Filtering Works

```text
  where({ status: 'pending', region: 'us' })
      |
      v
  +-----------------------------------------------------------------+
  | For each record in the bucket:                                    |
  |                                                                   |
  |   record.status === 'pending'  AND  record.region === 'us'       |
  |                                                                   |
  |   Alice:  'pending' === 'pending' AND 'us' === 'us'   -> MATCH  |
  |   Bob:    'shipped' === 'pending'                      -> SKIP   |
  |   Carol:  'pending' === 'pending' AND 'us' === 'us'   -> MATCH  |
  |   Dave:   'delivered' === 'pending'                    -> SKIP   |
  |   Eve:    'pending' === 'pending' AND 'eu' === 'us'   -> SKIP   |
  +-----------------------------------------------------------------+
```

### Edge Cases

```typescript
// Empty filter returns all records
const all = await orders.where({});
console.log(all.length); // 5

// No matches returns an empty array (not an error)
const none = await orders.where({ status: 'cancelled' });
console.log(none.length); // 0

// Filter by any field — not just indexed ones
const alice = await orders.where({ customer: 'Alice' });
console.log(alice.length); // 1
```

### Strict Equality

Filters use `===` comparison. This means:

| Expression | Result | Why |
|---|---|---|
| `'pending' === 'pending'` | Match | Same string |
| `100 === 100` | Match | Same number |
| `100 === '100'` | No match | Different types |
| `null === undefined` | No match | Strict equality distinguishes them |
| `true === 1` | No match | Different types |

There are no range operators (`>`, `<`), no regex matching, and no OR logic in filters. For these use cases, retrieve a broader set with `where()` or `all()` and filter in application code.

## `findOne()` — Retrieve a Single Match

`findOne(filter)` works like `where()` but returns the first matching record instead of an array. It returns `undefined` if nothing matches:

```typescript
// Find one pending order
const pending = await orders.findOne({ status: 'pending' });
console.log(pending?.customer); // 'Alice'

// No match returns undefined
const cancelled = await orders.findOne({ status: 'cancelled' });
console.log(cancelled); // undefined
```

Use `findOne()` when you expect zero or one result, or when you only care about the first match. It short-circuits internally — once a match is found, scanning stops.

### `findOne()` vs `where()` vs `get()`

| Method | Returns | Use When |
|---|---|---|
| `get(key)` | Record or `undefined` | You know the primary key |
| `findOne(filter)` | Record or `undefined` | You need one record by field values |
| `where(filter)` | `StoreRecord[]` | You need all matching records |

## `count()` — Count Records

`count(filter?)` returns the number of matching records. Without a filter, it counts everything:

```typescript
// Total records
const total = await orders.count();
console.log(total); // 5

// Filtered count
const pendingCount = await orders.count({ status: 'pending' });
console.log(pendingCount); // 3

const euCount = await orders.count({ region: 'eu' });
console.log(euCount); // 2
```

`count()` is more efficient than `where(filter).length` when you only need the number — it avoids building the full result array.

## `first()` — Records from the Beginning

`first(n)` returns the first `n` records from the bucket, ordered by primary key:

```typescript
const firstTwo = await orders.first(2);
console.log(firstTwo.length); // 2
console.log(firstTwo.map((o) => o.customer)); // First 2 customers by key order
```

### Ordering Depends on `etsType`

The order of records in `first()` and `last()` depends on the bucket's `etsType` setting:

| `etsType` | Order |
|---|---|
| `'ordered_set'` | Keys sorted numerically/lexicographically (default for `ordered_set`) |
| `'set'` | Insertion order (default) |

```typescript
// With etsType: 'ordered_set' and numeric keys (1, 2, 3):
// first(2) returns records with keys 1, 2

// With etsType: 'set' (default):
// first(2) returns the first two inserted records
```

### Edge Cases

```typescript
// Requesting more than available returns what exists
const allFive = await orders.first(100);
console.log(allFive.length); // 5 (only 5 records exist)

// Empty bucket returns empty array
await orders.clear();
const empty = await orders.first(3);
console.log(empty.length); // 0
```

## `last()` — Records from the End

`last(n)` returns the last `n` records, respecting the same ordering as `first()`:

```typescript
await orders.insert({ customer: 'Alice', total: 50, region: 'us' });
await orders.insert({ customer: 'Bob', total: 120, region: 'eu' });
await orders.insert({ customer: 'Carol', total: 80, region: 'us' });

const lastTwo = await orders.last(2);
console.log(lastTwo.length); // 2
console.log(lastTwo.map((o) => o.customer)); // Last 2 customers by key order
```

`last()` mirrors `first()` — same ordering rules, same edge-case behavior for oversized `n` and empty buckets.

## How Queries Flow Through the Store

Every query goes through the GenServer message-passing architecture:

```text
  orders.where({ status: 'pending' })
      |
      v
  BucketHandle               BucketServer (GenServer)
  +-----------+   call()    +-----------------------------+
  | where()   | ----------> | handle_call('where', filter)|
  |           |             |                             |
  |           |             |  1. Check indexes           |
  |           |             |     status is indexed?      |
  |           |             |     -> YES: lookup('pending')|
  |           |             |     -> get candidate keys   |
  |           |             |                             |
  |           |             |  2. Apply remaining filters |
  |           |             |     (none left in this case)|
  |           |             |                             |
  |           | <---------- |  3. Return matching records |
  +-----------+   reply     +-----------------------------+
```

When a filter field has a secondary index, the store uses the index to narrow candidates before scanning. This is covered in detail in the next chapter.

## Complete Working Example

A customer support system that queries a ticket bucket in different ways:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'filtering-demo' });

  await store.defineBucket('tickets', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      title:    { type: 'string', required: true },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
      status:   { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open' },
      assignee: { type: 'string' },
    },
    indexes: ['priority', 'status', 'assignee'],
  });

  const tickets = store.bucket('tickets');

  // Seed data
  await tickets.insert({ title: 'Login page broken', priority: 'critical', assignee: 'alice' });
  await tickets.insert({ title: 'Typo in footer', priority: 'low', assignee: 'bob' });
  await tickets.insert({ title: 'API timeout', priority: 'high', status: 'in_progress', assignee: 'alice' });
  await tickets.insert({ title: 'Missing translations', priority: 'medium', assignee: 'carol' });
  await tickets.insert({ title: 'Dashboard crash', priority: 'critical', status: 'in_progress', assignee: 'bob' });
  await tickets.insert({ title: 'Slow search', priority: 'high', assignee: 'alice' });

  // 1. All critical tickets
  const critical = await tickets.where({ priority: 'critical' });
  console.log(`Critical tickets: ${critical.length}`);
  // Critical tickets: 2

  // 2. Alice's open tickets
  const aliceOpen = await tickets.where({ assignee: 'alice', status: 'open' });
  console.log(`Alice's open: ${aliceOpen.map((t) => t.title).join(', ')}`);
  // Alice's open: Login page broken, Slow search

  // 3. Any in-progress ticket (first match)
  const inProgress = await tickets.findOne({ status: 'in_progress' });
  console.log(`In progress: ${inProgress?.title}`);
  // In progress: API timeout

  // 4. Count open tickets
  const openCount = await tickets.count({ status: 'open' });
  console.log(`Open tickets: ${openCount}`);
  // Open tickets: 4

  // 5. First 3 tickets (by autoincrement key)
  const firstThree = await tickets.first(3);
  console.log(`First 3: ${firstThree.map((t) => `#${t.id} ${t.title}`).join(', ')}`);
  // First 3: #1 Login page broken, #2 Typo in footer, #3 API timeout

  // 6. Last 2 tickets
  const lastTwo = await tickets.last(2);
  console.log(`Last 2: ${lastTwo.map((t) => `#${t.id} ${t.title}`).join(', ')}`);
  // Last 2: #5 Dashboard crash, #6 Slow search

  // 7. Total ticket count
  const totalCount = await tickets.count();
  console.log(`Total tickets: ${totalCount}`);
  // Total tickets: 6

  await store.stop();
}

main();
```

## Exercise

Given the following bucket with employee data:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('employees', {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    name:       { type: 'string', required: true },
    department: { type: 'string', enum: ['engineering', 'design', 'marketing', 'sales'] },
    level:      { type: 'string', enum: ['junior', 'mid', 'senior', 'lead'] },
    active:     { type: 'boolean', default: true },
  },
  indexes: ['department', 'level'],
});

const employees = store.bucket('employees');

await employees.insert({ name: 'Alice', department: 'engineering', level: 'senior' });
await employees.insert({ name: 'Bob', department: 'engineering', level: 'junior' });
await employees.insert({ name: 'Carol', department: 'design', level: 'lead' });
await employees.insert({ name: 'Dave', department: 'marketing', level: 'mid' });
await employees.insert({ name: 'Eve', department: 'engineering', level: 'senior' });
await employees.insert({ name: 'Frank', department: 'sales', level: 'junior', active: false });
```

Write queries to answer:

1. How many employees are in the engineering department?
2. Find all senior engineers (department + level filter).
3. Is there any inactive employee? Use `findOne()`.
4. Get the first 2 employees (by autoincrement key).
5. Count the total number of employees.

<details>
<summary>Solution</summary>

```typescript
// 1. Engineering department count
const engCount = await employees.count({ department: 'engineering' });
console.log(engCount); // 3

// 2. Senior engineers
const seniorEng = await employees.where({ department: 'engineering', level: 'senior' });
console.log(seniorEng.map((e) => e.name)); // ['Alice', 'Eve']

// 3. Any inactive employee
const inactive = await employees.findOne({ active: false });
console.log(inactive?.name); // 'Frank'

// 4. First 2 employees
const firstTwo = await employees.first(2);
console.log(firstTwo.map((e) => `#${e.id} ${e.name}`)); // ['#1 Alice', '#2 Bob']

// 5. Total count
const total = await employees.count();
console.log(total); // 6
```

</details>

## Summary

- **`where(filter)`** returns all records matching every field in the filter using strict equality and AND logic
- **`findOne(filter)`** returns the first match or `undefined` — use it when you need at most one result
- **`count(filter?)`** returns the number of matching records — omit the filter for a total count
- **`first(n)`** and **`last(n)`** return records from the beginning or end of the bucket, ordered by primary key
- Filters use `===` comparison — no range operators, no regex, no OR logic
- An empty filter `{}` matches all records; no matches returns an empty array (never throws)
- All queries go through the GenServer architecture, benefiting from index acceleration when available
- Ordering in `first()` / `last()` depends on `etsType`: sorted keys for `ordered_set`, insertion order for `set`

---

Next: [Secondary Indexes](./02-secondary-indexes.md)
