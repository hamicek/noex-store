# Secondary Indexes

In the previous chapter you filtered records with `where()`. Behind the scenes, a filter without an index forces the store to scan every record in the bucket — comparing each one against the filter until it has checked them all. For a bucket with 10 records that's invisible. For a bucket with 100,000 records, every query pays the full scan cost.

Secondary indexes solve this. An index maps a field value to the set of primary keys that share that value. Instead of scanning 100,000 records to find orders with `status: 'pending'`, the store looks up `'pending'` in the index and gets back only the matching keys — then fetches those records directly.

## What You'll Learn

- How to declare secondary indexes on a bucket
- The difference between non-unique and unique indexes
- How `IndexManager` stores and maintains index data
- How the store accelerates `where()` and `findOne()` with indexes
- The performance difference between full scan and indexed lookup
- How indexes interact with null/undefined values and updates

## Declaring Indexes

Indexes are declared in the bucket definition using the `indexes` array:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'index-demo' });

await store.defineBucket('customers', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', required: true, unique: true },
    tier:  { type: 'string', enum: ['free', 'basic', 'premium'], default: 'free' },
    city:  { type: 'string' },
  },
  indexes: ['tier', 'city'],
});
```

This creates three indexes:

| Field | Index Type | Source |
|---|---|---|
| `email` | Unique | `unique: true` in the schema |
| `tier` | Non-unique | Listed in `indexes` |
| `city` | Non-unique | Listed in `indexes` |

Two ways to create an index:

1. **`indexes: ['field']`** — creates a non-unique index for faster lookups
2. **`unique: true`** on a schema field — creates a unique index that also enforces uniqueness

## Non-Unique Indexes

A non-unique index maps each field value to a **set** of primary keys. Multiple records can share the same value:

```text
  Non-Unique Index: tier
  +----------------------------------+
  | 'free'    -> { key1, key4, key7 }|
  | 'basic'   -> { key2, key5 }     |
  | 'premium' -> { key3, key6 }     |
  +----------------------------------+
```

```typescript
const customers = store.bucket('customers');

await customers.insert({ name: 'Alice', email: 'alice@a.com', tier: 'premium', city: 'Prague' });
await customers.insert({ name: 'Bob', email: 'bob@b.com', tier: 'free', city: 'Berlin' });
await customers.insert({ name: 'Carol', email: 'carol@c.com', tier: 'premium', city: 'Prague' });
await customers.insert({ name: 'Dave', email: 'dave@d.com', tier: 'free', city: 'London' });

// Index-accelerated: looks up 'premium' in the tier index
const premium = await customers.where({ tier: 'premium' });
console.log(premium.length); // 2
console.log(premium.map((c) => c.name)); // ['Alice', 'Carol']

// Also index-accelerated: looks up 'Prague' in the city index
const prague = await customers.where({ city: 'Prague' });
console.log(prague.length); // 2
```

## Unique Indexes

A unique index maps each field value to exactly **one** primary key. It enforces that no two records share the same value:

```text
  Unique Index: email
  +----------------------------------------+
  | 'alice@a.com' -> key1                  |
  | 'bob@b.com'   -> key2                  |
  | 'carol@c.com' -> key3                  |
  | 'dave@d.com'  -> key4                  |
  +----------------------------------------+
```

```typescript
// Unique index enables fast exact lookups
const alice = await customers.findOne({ email: 'alice@a.com' });
console.log(alice?.name); // 'Alice'

// Attempting a duplicate email throws UniqueConstraintError
try {
  await customers.insert({ name: 'Fake Alice', email: 'alice@a.com', tier: 'free' });
} catch (err) {
  console.log(err.name); // 'UniqueConstraintError'
}
```

Unique indexes were covered in detail in [Unique Constraints](../03-schema-validation/03-unique-constraints.md). This chapter focuses on their role as query accelerators.

## How Index Lookup Works

When `where()` receives a filter, the store checks each filter field against available indexes. If an indexed field is found, it uses the index to narrow the candidate set before applying the remaining filters:

```text
  where({ tier: 'premium', city: 'Prague' })
      |
      v
  +---------------------------------------------------------------+
  | Phase 1: Index Lookup                                           |
  |                                                                 |
  |   tier is indexed?  -> YES                                      |
  |   lookup('premium') -> { key1, key3 }                          |
  |   2 candidates (instead of scanning all 4 records)             |
  |                                                                 |
  | Phase 2: Apply Remaining Filters                                |
  |                                                                 |
  |   Remaining filter: { city: 'Prague' }                          |
  |   key1 (Alice): city === 'Prague'  -> MATCH                    |
  |   key3 (Carol): city === 'Prague'  -> MATCH                    |
  |                                                                 |
  |   Result: [Alice, Carol]                                        |
  +---------------------------------------------------------------+
```

The two-phase approach:

1. **Index lookup** — one indexed field narrows the search space
2. **Scan remaining** — any non-indexed filter fields are checked against the candidates

If no indexed field is found in the filter, the store falls back to a full table scan:

```text
  where({ name: 'Alice' })
      |
      v
  +---------------------------------------------------------------+
  | No index on 'name'                                              |
  | Full scan: check every record against { name: 'Alice' }        |
  +---------------------------------------------------------------+
```

## Performance: Scan vs Index

The performance difference grows with bucket size:

```text
  Records    Full Scan     Indexed Lookup
  -------    ----------    ---------------
       10    10 checks     1 lookup + ~k checks (k = matches)
      100    100 checks    1 lookup + ~k checks
    1,000    1,000 checks  1 lookup + ~k checks
   10,000    10,000 checks 1 lookup + ~k checks
  100,000    100,000 checks 1 lookup + ~k checks
```

| Scenario | Without Index | With Index |
|---|---|---|
| `where({ status: 'pending' })` on 10,000 records, 50 pending | Scans 10,000 | Looks up 50 keys |
| `findOne({ email: 'x@y.com' })` on 10,000 records | Scans until found (avg 5,000) | Direct lookup: 1 step |
| `count({ tier: 'vip' })` on 10,000 records, 200 VIPs | Scans 10,000 | Looks up 200 keys |

### When to Add an Index

Add an index when:
- A field is frequently used in `where()` or `findOne()` filters
- The bucket has many records and query performance matters
- A field has moderate cardinality (many distinct values relative to total records)

Don't add an index when:
- The bucket has very few records (< 100) — the overhead isn't worth it
- The field is rarely queried
- The field has very low cardinality (e.g., a boolean with 2 values) and the bucket is small

Every index adds memory overhead and slows down inserts/updates/deletes (the index must be updated on each write). The trade-off is worth it when reads significantly outnumber writes for that field.

## Index Maintenance

Indexes are automatically maintained on every mutation. You never rebuild or refresh them manually:

### On Insert

```text
  insert({ name: 'Eve', email: 'eve@e.com', tier: 'basic', city: 'Paris' })
      |
      v
  +------------------------------------------------------+
  | 1. Validate unique constraints (email index)           |
  |    'eve@e.com' not in unique index -> OK              |
  |                                                        |
  | 2. Add to all indexes:                                 |
  |    email: 'eve@e.com' -> key5                         |
  |    tier:  'basic'     -> { ..., key5 }                |
  |    city:  'Paris'     -> { key5 }                     |
  +------------------------------------------------------+
```

### On Update

When a field value changes, the index is updated to reflect the new value:

```typescript
// Eve moves from 'basic' to 'premium'
await customers.update(eve.id, { tier: 'premium' });
```

```text
  update(key5, { tier: 'premium' })
      |
      v
  +------------------------------------------------------+
  | 1. Remove key5 from tier['basic']                      |
  | 2. Validate unique constraints (if applicable)         |
  | 3. Add key5 to tier['premium']                         |
  |                                                        |
  | Unchanged fields (city, email) are not touched          |
  +------------------------------------------------------+
```

Only changed fields trigger index updates. If an update doesn't modify any indexed field, the indexes are left untouched.

### On Delete

```text
  delete(key5)
      |
      v
  +------------------------------------------------------+
  | Remove key5 from all indexes:                          |
  |   email: remove 'eve@e.com' -> key5                   |
  |   tier:  remove key5 from 'premium' set               |
  |   city:  remove key5 from 'Paris' set                 |
  +------------------------------------------------------+
```

## Null and Undefined Values

Fields with `null` or `undefined` values are **not indexed**. This has two consequences:

1. **Multiple records can have null/undefined in a unique field** — uniqueness is only enforced among non-null values
2. **Looking up null/undefined returns no results** from the index

```typescript
await store.defineBucket('profiles', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true },
    nickname: { type: 'string', unique: true }, // Optional but unique when present
  },
});

const profiles = store.bucket('profiles');

// Both have undefined nickname — no unique conflict
await profiles.insert({ name: 'Alice' });
await profiles.insert({ name: 'Bob' });

// Nickname is set — now it's indexed and enforced
await profiles.insert({ name: 'Carol', nickname: 'caz' });

// Duplicate nickname fails
try {
  await profiles.insert({ name: 'Dave', nickname: 'caz' });
} catch (err) {
  console.log(err.name); // 'UniqueConstraintError'
}
```

## Complete Working Example

An e-commerce product catalog that demonstrates the impact of indexes on query patterns:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'index-example' });

  await store.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:      { type: 'string', required: true, pattern: '^[A-Z]{2}-\\d{4}$' },
      name:     { type: 'string', required: true },
      category: { type: 'string', required: true, enum: ['electronics', 'clothing', 'food', 'books'] },
      brand:    { type: 'string', required: true },
      price:    { type: 'number', required: true, min: 0 },
      inStock:  { type: 'boolean', default: true },
    },
    indexes: ['category', 'brand', 'inStock'],
  });

  const products = store.bucket('products');

  // Seed products
  await products.insert({ sku: 'EL-0001', name: 'Laptop Pro', category: 'electronics', brand: 'TechCo', price: 1299 });
  await products.insert({ sku: 'EL-0002', name: 'Wireless Mouse', category: 'electronics', brand: 'TechCo', price: 29 });
  await products.insert({ sku: 'CL-0001', name: 'Cotton T-Shirt', category: 'clothing', brand: 'WearIt', price: 19 });
  await products.insert({ sku: 'CL-0002', name: 'Denim Jacket', category: 'clothing', brand: 'WearIt', price: 89 });
  await products.insert({ sku: 'BK-0001', name: 'TypeScript Handbook', category: 'books', brand: 'DevPress', price: 45 });
  await products.insert({ sku: 'FD-0001', name: 'Organic Coffee', category: 'food', brand: 'BeanCo', price: 15, inStock: false });

  // Index-accelerated queries
  const electronics = await products.where({ category: 'electronics' });
  console.log(`Electronics: ${electronics.map((p) => p.name).join(', ')}`);
  // Electronics: Laptop Pro, Wireless Mouse

  const techCoElectronics = await products.where({ category: 'electronics', brand: 'TechCo' });
  console.log(`TechCo electronics: ${techCoElectronics.length}`);
  // TechCo electronics: 2

  const outOfStock = await products.where({ inStock: false });
  console.log(`Out of stock: ${outOfStock.map((p) => p.name).join(', ')}`);
  // Out of stock: Organic Coffee

  // findOne with index
  const firstBook = await products.findOne({ category: 'books' });
  console.log(`First book: ${firstBook?.name}`);
  // First book: TypeScript Handbook

  // Count with index
  const clothingCount = await products.count({ category: 'clothing' });
  console.log(`Clothing items: ${clothingCount}`);
  // Clothing items: 2

  // Update changes the index
  await products.update('FD-0001', { inStock: true });
  const nowOutOfStock = await products.where({ inStock: false });
  console.log(`Out of stock after restock: ${nowOutOfStock.length}`);
  // Out of stock after restock: 0

  await store.stop();
}

main();
```

## Exercise

You are building a user management system. Design a bucket with appropriate indexes and then write queries that benefit from them.

Requirements:
1. Define a `users` bucket with fields: `id` (uuid), `email` (unique), `role` (enum: admin/editor/viewer), `country` (string), and `active` (boolean, default true)
2. Add secondary indexes on `role`, `country`, and `active`
3. Insert 5 users with varied roles, countries, and active states
4. Write queries to:
   - Find all active admins (two-field filter using indexes)
   - Find a user by email (unique index lookup)
   - Count users in a specific country
   - Check if any inactive user exists

<details>
<summary>Solution</summary>

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'exercise' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:      { type: 'string', generated: 'uuid' },
      email:   { type: 'string', required: true, unique: true, format: 'email' },
      role:    { type: 'string', required: true, enum: ['admin', 'editor', 'viewer'] },
      country: { type: 'string', required: true },
      active:  { type: 'boolean', default: true },
    },
    indexes: ['role', 'country', 'active'],
  });

  const users = store.bucket('users');

  await users.insert({ email: 'alice@a.com', role: 'admin', country: 'CZ' });
  await users.insert({ email: 'bob@b.com', role: 'editor', country: 'DE' });
  await users.insert({ email: 'carol@c.com', role: 'admin', country: 'CZ', active: false });
  await users.insert({ email: 'dave@d.com', role: 'viewer', country: 'US' });
  await users.insert({ email: 'eve@e.com', role: 'admin', country: 'DE' });

  // All active admins — uses role index, then filters by active
  const activeAdmins = await users.where({ role: 'admin', active: true });
  console.log(activeAdmins.map((u) => u.email));
  // ['alice@a.com', 'eve@e.com']

  // Find by email — unique index: direct lookup
  const bob = await users.findOne({ email: 'bob@b.com' });
  console.log(bob?.role); // 'editor'

  // Count users in CZ — uses country index
  const czCount = await users.count({ country: 'CZ' });
  console.log(czCount); // 2

  // Any inactive user — uses active index
  const inactive = await users.findOne({ active: false });
  console.log(inactive?.email); // 'carol@c.com'

  await store.stop();
}

main();
```

</details>

## Summary

- **`indexes: ['field']`** creates a non-unique secondary index — maps values to sets of primary keys
- **`unique: true`** on a schema field creates a unique index that also enforces uniqueness
- Indexes accelerate `where()`, `findOne()`, and `count()` by narrowing candidates before scanning
- The store uses a **two-phase** approach: index lookup narrows the set, then remaining filters are applied
- Without an index, every query scans all records — O(n) where n is the bucket size
- With an index, lookup is O(k) where k is the number of matching records
- Indexes are maintained automatically on insert, update, and delete — no manual rebuilds
- Only changed fields trigger index updates on mutation
- `null` and `undefined` values are not indexed — unique constraints are only enforced among non-null values
- Indexes trade write performance (update cost on each mutation) for read performance (fast lookups)

## API Reference

- [BucketHandle API](../../reference/bucket-handle.md) — index-accelerated `where()` and `findOne()`
- [Schema and Types](../../reference/schema.md) — `BucketDefinition.indexes` and `unique` automatic indexing

---

Next: [Pagination and Aggregation](./03-pagination-and-aggregation.md)
