# Pagination and Aggregation

Calling `all()` on a bucket with 50,000 records loads every single one into memory at once. That's wasteful when you only need 20 records for a UI table. And sometimes you don't need the records at all — you need a total, an average, or a maximum value.

noex-store provides cursor-based pagination for efficient traversal and aggregation functions for computing summaries directly inside the bucket, without pulling records into application code.

## What You'll Learn

- How cursor-based pagination works with `paginate()`
- How to traverse an entire bucket page by page
- How `sum()`, `avg()`, `min()`, and `max()` compute aggregates
- How to combine aggregation with filters
- How aggregations handle non-numeric values and empty buckets

## Setup

All examples use the following bucket:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'pagination-demo' });

await store.defineBucket('products', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    name:     { type: 'string', required: true },
    category: { type: 'string', required: true, enum: ['electronics', 'clothing', 'food'] },
    price:    { type: 'number', required: true, min: 0 },
    rating:   { type: 'number', min: 1, max: 5 },
    sold:     { type: 'number', default: 0 },
  },
  indexes: ['category'],
});

const products = store.bucket('products');

// Seed data
await products.insert({ name: 'Laptop', category: 'electronics', price: 1200, rating: 5, sold: 340 });
await products.insert({ name: 'Mouse', category: 'electronics', price: 25, rating: 4, sold: 1500 });
await products.insert({ name: 'T-Shirt', category: 'clothing', price: 20, rating: 3, sold: 800 });
await products.insert({ name: 'Jacket', category: 'clothing', price: 90, rating: 4, sold: 250 });
await products.insert({ name: 'Coffee', category: 'food', price: 12, rating: 5, sold: 3000 });
await products.insert({ name: 'Rice', category: 'food', price: 5, rating: 3, sold: 2100 });
await products.insert({ name: 'Headphones', category: 'electronics', price: 150, rating: 4, sold: 600 });
await products.insert({ name: 'Sneakers', category: 'clothing', price: 110, rating: 5, sold: 420 });
```

## Cursor-Based Pagination

`paginate(options)` retrieves a page of records using a cursor (the primary key of the last record from the previous page):

```typescript
// First page — no cursor
const page1 = await products.paginate({ limit: 3 });

console.log(page1.records.map((p) => `#${p.id} ${p.name}`));
// ['#1 Laptop', '#2 Mouse', '#3 T-Shirt']
console.log(page1.hasMore);    // true
console.log(page1.nextCursor); // 3 (primary key of last record)
```

### The `PaginateOptions` Interface

```typescript
interface PaginateOptions {
  readonly after?: unknown;  // Primary key to start after (omit for first page)
  readonly limit: number;    // Maximum records per page
}
```

### The `PaginatedResult` Interface

```typescript
interface PaginatedResult {
  readonly records: StoreRecord[];          // Records for this page
  readonly hasMore: boolean;                // true if more records exist after this page
  readonly nextCursor: unknown | undefined; // Primary key of the last record (use as 'after' for next page)
}
```

### Traversing Page by Page

Use `nextCursor` as the `after` value for the next page:

```typescript
// Page 1
const page1 = await products.paginate({ limit: 3 });
console.log(page1.records.map((p) => p.name));
// ['Laptop', 'Mouse', 'T-Shirt']
console.log(page1.hasMore); // true

// Page 2 — use nextCursor from page 1
const page2 = await products.paginate({ after: page1.nextCursor, limit: 3 });
console.log(page2.records.map((p) => p.name));
// ['Jacket', 'Coffee', 'Rice']
console.log(page2.hasMore); // true

// Page 3 — use nextCursor from page 2
const page3 = await products.paginate({ after: page2.nextCursor, limit: 3 });
console.log(page3.records.map((p) => p.name));
// ['Headphones', 'Sneakers']
console.log(page3.hasMore); // false (last page — only 2 records)
console.log(page3.nextCursor); // 8
```

### How Cursor Pagination Works

```text
  paginate({ after: 3, limit: 3 })
      |
      v
  +---------------------------------------------------------------+
  | 1. Get all keys in order:                                       |
  |    [1, 2, 3, 4, 5, 6, 7, 8]                                   |
  |                                                                 |
  | 2. Find cursor position:                                        |
  |    after = 3  ->  index of key 3 is 2  ->  start at index 3   |
  |                                                                 |
  | 3. Slice [startIdx, startIdx + limit]:                          |
  |    keys[3..6] = [4, 5, 6]                                      |
  |                                                                 |
  | 4. Fetch records for keys [4, 5, 6]:                            |
  |    [Jacket, Coffee, Rice]                                       |
  |                                                                 |
  | 5. hasMore = startIdx + limit < total keys                      |
  |    3 + 3 = 6 < 8 = true                                        |
  |                                                                 |
  | 6. nextCursor = last record's primary key = 6                   |
  +---------------------------------------------------------------+
```

### Ordering

Pagination order depends on the bucket's `etsType`:

| `etsType` | Order |
|---|---|
| `'set'` (default) | Insertion order |
| `'ordered_set'` | Keys sorted numerically / lexicographically |

For numeric autoincrement keys, both insertion order and sorted order are identical.

### Edge Cases

```typescript
// First page: omit 'after'
const first = await products.paginate({ limit: 2 });
console.log(first.records.length); // 2

// Past the end: returns empty
const pastEnd = await products.paginate({ after: 999, limit: 10 });
console.log(pastEnd.records.length); // 0
console.log(pastEnd.hasMore);        // false
console.log(pastEnd.nextCursor);     // undefined

// Limit larger than total: returns all records
const all = await products.paginate({ limit: 100 });
console.log(all.records.length); // 8
console.log(all.hasMore);       // false
```

### Traversing an Entire Bucket

A helper pattern to process all records page by page:

```typescript
let cursor: unknown | undefined;
let pageNum = 0;

do {
  const page = await products.paginate({ after: cursor, limit: 3 });
  pageNum++;
  console.log(`Page ${pageNum}: ${page.records.map((p) => p.name).join(', ')}`);
  cursor = page.nextCursor;

  if (!page.hasMore) break;
} while (true);

// Page 1: Laptop, Mouse, T-Shirt
// Page 2: Jacket, Coffee, Rice
// Page 3: Headphones, Sneakers
```

## Aggregation Functions

Aggregation functions compute a single value from a numeric field across matching records. All four functions accept an optional filter to narrow the input set.

### `sum()` — Total of Numeric Values

```typescript
// Total revenue (price * sold would need app logic, but we can sum individual fields)
const totalSold = await products.sum('sold');
console.log(totalSold); // 9010

// Sum with filter
const electronicsSold = await products.sum('sold', { category: 'electronics' });
console.log(electronicsSold); // 2440 (340 + 1500 + 600)
```

### `avg()` — Average of Numeric Values

```typescript
// Average price across all products
const avgPrice = await products.avg('price');
console.log(avgPrice); // 201.5 ((1200+25+20+90+12+5+150+110) / 8)

// Average rating for food
const avgFoodRating = await products.avg('rating', { category: 'food' });
console.log(avgFoodRating); // 4 ((5 + 3) / 2)
```

### `min()` — Minimum Numeric Value

```typescript
// Cheapest product
const cheapest = await products.min('price');
console.log(cheapest); // 5

// Cheapest electronics
const cheapestElectronics = await products.min('price', { category: 'electronics' });
console.log(cheapestElectronics); // 25
```

### `max()` — Maximum Numeric Value

```typescript
// Most expensive product
const mostExpensive = await products.max('price');
console.log(mostExpensive); // 1200

// Highest rating among clothing
const bestClothing = await products.max('rating', { category: 'clothing' });
console.log(bestClothing); // 5
```

### Aggregation Signatures

| Method | Signature | Returns |
|---|---|---|
| `sum(field, filter?)` | `(string, Record?) => Promise<number>` | Sum of numeric values, `0` if empty |
| `avg(field, filter?)` | `(string, Record?) => Promise<number>` | Average of numeric values, `0` if empty |
| `min(field, filter?)` | `(string, Record?) => Promise<number \| undefined>` | Minimum value, `undefined` if empty |
| `max(field, filter?)` | `(string, Record?) => Promise<number \| undefined>` | Maximum value, `undefined` if empty |

### How Aggregations Work

```text
  sum('price', { category: 'electronics' })
      |
      v
  +---------------------------------------------------------------+
  | 1. Get matching records:                                        |
  |    Filter { category: 'electronics' } -> index lookup          |
  |    -> [Laptop(1200), Mouse(25), Headphones(150)]               |
  |                                                                 |
  | 2. Iterate and accumulate:                                      |
  |    sum = 0                                                      |
  |    Laptop:     price = 1200 (number) -> sum = 1200             |
  |    Mouse:      price = 25   (number) -> sum = 1225             |
  |    Headphones: price = 150  (number) -> sum = 1375             |
  |                                                                 |
  | 3. Return 1375                                                  |
  +---------------------------------------------------------------+
```

### Non-Numeric Values

Aggregation functions skip non-numeric values silently. They don't throw:

```typescript
await store.defineBucket('mixed', {
  key: 'id',
  schema: {
    id:    { type: 'number', generated: 'autoincrement' },
    value: { type: 'string' }, // Not a number!
  },
});

const mixed = store.bucket('mixed');
await mixed.insert({ value: 'hello' });
await mixed.insert({ value: 'world' });

// String field — all values skipped
const total = await mixed.sum('value');
console.log(total); // 0

const average = await mixed.avg('value');
console.log(average); // 0

const minimum = await mixed.min('value');
console.log(minimum); // undefined

const maximum = await mixed.max('value');
console.log(maximum); // undefined

await store.stop();
```

### Empty Bucket Behavior

| Function | Empty Bucket | No Matches After Filter |
|---|---|---|
| `sum()` | `0` | `0` |
| `avg()` | `0` | `0` |
| `min()` | `undefined` | `undefined` |
| `max()` | `undefined` | `undefined` |

This distinction matters: `sum` and `avg` return `0` (a number you can use in arithmetic), while `min` and `max` return `undefined` (there's no meaningful minimum of an empty set).

## Complete Working Example

A sales dashboard that combines pagination and aggregation:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'dashboard' });

  await store.defineBucket('sales', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      product:  { type: 'string', required: true },
      region:   { type: 'string', required: true, enum: ['us', 'eu', 'asia'] },
      amount:   { type: 'number', required: true, min: 0 },
      units:    { type: 'number', required: true, min: 1 },
    },
    indexes: ['region'],
  });

  const sales = store.bucket('sales');

  // Seed 10 sales records
  await sales.insert({ product: 'Widget A', region: 'us', amount: 500, units: 10 });
  await sales.insert({ product: 'Widget B', region: 'eu', amount: 750, units: 15 });
  await sales.insert({ product: 'Widget A', region: 'asia', amount: 300, units: 6 });
  await sales.insert({ product: 'Gadget X', region: 'us', amount: 1200, units: 4 });
  await sales.insert({ product: 'Widget A', region: 'eu', amount: 450, units: 9 });
  await sales.insert({ product: 'Gadget Y', region: 'asia', amount: 800, units: 8 });
  await sales.insert({ product: 'Widget B', region: 'us', amount: 600, units: 12 });
  await sales.insert({ product: 'Gadget X', region: 'eu', amount: 950, units: 3 });
  await sales.insert({ product: 'Widget A', region: 'us', amount: 400, units: 8 });
  await sales.insert({ product: 'Gadget Y', region: 'asia', amount: 1100, units: 11 });

  // --- KPI Dashboard ---
  console.log('=== Sales Dashboard ===\n');

  // Total revenue
  const totalRevenue = await sales.sum('amount');
  console.log(`Total revenue: $${totalRevenue}`);
  // Total revenue: $7050

  // Average order value
  const avgOrder = await sales.avg('amount');
  console.log(`Average order: $${avgOrder}`);
  // Average order: $705

  // Revenue by region
  for (const region of ['us', 'eu', 'asia'] as const) {
    const regionRevenue = await sales.sum('amount', { region });
    const regionCount = await sales.count({ region });
    const regionAvg = await sales.avg('amount', { region });
    console.log(`  ${region.toUpperCase()}: $${regionRevenue} (${regionCount} orders, avg $${regionAvg})`);
  }
  // US:   $2700 (3 orders, avg $900)
  // EU:   $2150 (3 orders, avg $716.67)
  // ASIA: $2200 (3 orders, avg $733.33) -- rounded

  // Largest and smallest orders
  const largest = await sales.max('amount');
  const smallest = await sales.min('amount');
  console.log(`\nLargest order: $${largest}`);
  console.log(`Smallest order: $${smallest}`);
  // Largest order: $1200
  // Smallest order: $300

  // Total units sold
  const totalUnits = await sales.sum('units');
  console.log(`Total units sold: ${totalUnits}`);
  // Total units sold: 86

  // --- Paginated Sales Report ---
  console.log('\n=== Paginated Report ===\n');

  let cursor: unknown | undefined;
  let page = 0;

  do {
    const result = await sales.paginate({ after: cursor, limit: 4 });
    page++;
    console.log(`Page ${page}:`);
    for (const sale of result.records) {
      console.log(`  #${sale.id} ${sale.product} (${sale.region}) — $${sale.amount}`);
    }

    cursor = result.nextCursor;
    if (!result.hasMore) break;
  } while (true);

  await store.stop();
}

main();
```

## Exercise

Given the following bucket with exam scores:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('scores', {
  key: 'id',
  schema: {
    id:      { type: 'number', generated: 'autoincrement' },
    student: { type: 'string', required: true },
    subject: { type: 'string', required: true, enum: ['math', 'science', 'english'] },
    score:   { type: 'number', required: true, min: 0, max: 100 },
  },
  indexes: ['subject'],
});

const scores = store.bucket('scores');

await scores.insert({ student: 'Alice', subject: 'math', score: 92 });
await scores.insert({ student: 'Bob', subject: 'math', score: 78 });
await scores.insert({ student: 'Carol', subject: 'science', score: 88 });
await scores.insert({ student: 'Alice', subject: 'science', score: 95 });
await scores.insert({ student: 'Bob', subject: 'english', score: 82 });
await scores.insert({ student: 'Carol', subject: 'math', score: 90 });
await scores.insert({ student: 'Alice', subject: 'english', score: 87 });
await scores.insert({ student: 'Dave', subject: 'science', score: 73 });
```

Write code to:

1. Compute the average math score
2. Find the highest science score
3. Find the lowest score across all subjects
4. Compute the total of all scores
5. Paginate through all records with a page size of 3 and print each page

<details>
<summary>Solution</summary>

```typescript
// 1. Average math score
const avgMath = await scores.avg('score', { subject: 'math' });
console.log(`Average math score: ${avgMath}`);
// Average math score: 86.67 ((92 + 78 + 90) / 3)

// 2. Highest science score
const maxScience = await scores.max('score', { subject: 'science' });
console.log(`Highest science score: ${maxScience}`);
// Highest science score: 95

// 3. Lowest score overall
const minScore = await scores.min('score');
console.log(`Lowest score: ${minScore}`);
// Lowest score: 73

// 4. Total of all scores
const totalScores = await scores.sum('score');
console.log(`Total of all scores: ${totalScores}`);
// Total of all scores: 685

// 5. Paginate through all records
let cursor: unknown | undefined;
let page = 0;

do {
  const result = await scores.paginate({ after: cursor, limit: 3 });
  page++;
  console.log(`Page ${page}:`);
  for (const s of result.records) {
    console.log(`  ${s.student} - ${s.subject}: ${s.score}`);
  }

  cursor = result.nextCursor;
  if (!result.hasMore) break;
} while (true);

// Page 1:
//   Alice - math: 92
//   Bob - math: 78
//   Carol - science: 88
// Page 2:
//   Alice - science: 95
//   Bob - english: 82
//   Carol - math: 90
// Page 3:
//   Alice - english: 87
//   Dave - science: 73
```

</details>

## Summary

- **`paginate({ after?, limit })`** implements cursor-based pagination using primary keys
- Omit `after` for the first page; use `nextCursor` from the result for subsequent pages
- `hasMore` tells you whether more records exist beyond the current page
- Pagination order follows `etsType`: insertion order for `set`, sorted keys for `ordered_set`
- **`sum(field, filter?)`** returns the total of numeric values — `0` for empty sets
- **`avg(field, filter?)`** returns the arithmetic mean — `0` for empty sets
- **`min(field, filter?)`** returns the smallest numeric value — `undefined` for empty sets
- **`max(field, filter?)`** returns the largest numeric value — `undefined` for empty sets
- All aggregation functions accept an optional filter to narrow the input
- Non-numeric values are silently skipped — aggregations never throw for wrong types
- Aggregation with filters benefits from secondary indexes the same way `where()` does

## API Reference

- [BucketHandle API](../../reference/bucket-handle.md) — `paginate()`, `first()`, `last()`, `sum()`, `avg()`, `min()`, `max()`

---

Next: [What Are Reactive Queries?](../05-reactive-queries/01-what-are-reactive-queries.md)
