# Dependency Tracking

You've defined queries and subscribed to them. The store re-executes queries when data changes and calls your callback only when the result differs. But how does the store know which queries to re-run? It doesn't re-execute every query on every mutation — that would be polling in disguise. Instead, it uses a two-level dependency tracking system that observes exactly what each query reads and builds a precise invalidation map.

This chapter explains the internals: how `QueryContext` records dependencies, how bucket-level and record-level tracking differ, how the invalidation index works, and how dependencies update dynamically on each re-evaluation.

## What You'll Learn

- How `QueryContext` tracks dependencies through method interception
- The difference between bucket-level and record-level dependencies
- Which methods create which type of dependency
- How the invalidation index maps data changes to affected subscriptions
- How `deepEqual()` prevents unnecessary callbacks
- How dependencies update dynamically when query logic changes between re-evaluations

## Setup

All examples in this chapter use the following store:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'deps-demo' });

await store.defineBucket('customers', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    tier: { type: 'string', enum: ['free', 'pro', 'enterprise'], default: 'free' },
  },
  indexes: ['tier'],
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    customerId: { type: 'string', required: true },
    amount:     { type: 'number', required: true, min: 0 },
    status:     { type: 'string', enum: ['pending', 'paid', 'refunded'], default: 'pending' },
  },
  indexes: ['customerId', 'status'],
});

await store.defineBucket('products', {
  key: 'sku',
  schema: {
    sku:   { type: 'string', required: true },
    name:  { type: 'string', required: true },
    price: { type: 'number', required: true, min: 0 },
  },
});

const customers = store.bucket('customers');
const orders = store.bucket('orders');
const products = store.bucket('products');
```

## Two Levels of Dependency

When a query function runs, `QueryContext` intercepts every method call on the read-only bucket proxy and records what was accessed. There are two levels of tracking:

### Record-Level Dependencies

The `get(key)` method creates a **record-level dependency**. The store records both the bucket name and the specific key:

```typescript
store.defineQuery('singleCustomer', async (ctx, params: { id: string }) => {
  return ctx.bucket('customers').get(params.id);
});
```

```text
  Dependencies:
  ┌──────────────────────────────────────┐
  │  recordLevel:                        │
  │    customers -> { params.id }        │
  │                                      │
  │  bucketLevel:                        │
  │    (empty)                           │
  └──────────────────────────────────────┘
```

**Record-level tracking is surgical.** This query re-evaluates only when the specific record identified by `params.id` is inserted, updated, or deleted. Changes to other records in the `customers` bucket are ignored.

### Bucket-Level Dependencies

Every method except `get()` creates a **bucket-level dependency**. The store records only the bucket name — any change in that bucket triggers re-evaluation:

```typescript
store.defineQuery('allPending', async (ctx) => {
  return ctx.bucket('orders').where({ status: 'pending' });
});
```

```text
  Dependencies:
  ┌──────────────────────────────────────┐
  │  recordLevel:                        │
  │    (empty)                           │
  │                                      │
  │  bucketLevel:                        │
  │    { orders }                        │
  └──────────────────────────────────────┘
```

**Bucket-level tracking is broad.** This query re-evaluates on any insert, update, or delete in the `orders` bucket — even if the mutation doesn't affect pending orders.

## Method-to-Dependency Mapping

| Method | Dependency Level | What Is Tracked |
|---|---|---|
| `get(key)` | Record-level | Bucket name + specific key |
| `all()` | Bucket-level | Bucket name |
| `where(filter)` | Bucket-level | Bucket name |
| `findOne(filter)` | Bucket-level | Bucket name |
| `count(filter?)` | Bucket-level | Bucket name |
| `first(n)` | Bucket-level | Bucket name |
| `last(n)` | Bucket-level | Bucket name |
| `paginate(options)` | Bucket-level | Bucket name |
| `sum(field, filter?)` | Bucket-level | Bucket name |
| `avg(field, filter?)` | Bucket-level | Bucket name |
| `min(field, filter?)` | Bucket-level | Bucket name |
| `max(field, filter?)` | Bucket-level | Bucket name |

The rationale: `get()` accesses a known, specific record. All other methods scan or aggregate — the store cannot predict which records contribute to the result, so it conservatively tracks the entire bucket.

## Record-Level Tracking in Practice

Record-level dependencies enable precise invalidation. When a query uses `get()`, only changes to that exact record trigger re-evaluation:

```typescript
const alice = await customers.insert({ name: 'Alice', tier: 'pro' });
const bob = await customers.insert({ name: 'Bob', tier: 'free' });

store.defineQuery('watchAlice', async (ctx) => {
  return ctx.bucket('customers').get(alice.id);
});

let callCount = 0;
await store.subscribe('watchAlice', () => {
  callCount++;
});

// Update Alice — the watched record
await customers.update(alice.id, { tier: 'enterprise' });
await store.settle();
console.log(callCount); // 1 — re-evaluated and result changed

// Update Bob — a different record
await customers.update(bob.id, { tier: 'pro' });
await store.settle();
console.log(callCount); // 1 — not re-evaluated at all

// Insert a new customer — also unrelated
await customers.insert({ name: 'Carol', tier: 'free' });
await store.settle();
console.log(callCount); // 1 — still not re-evaluated
```

Record-level tracking is ideal for queries that look up a small number of specific records. It avoids unnecessary re-evaluations when the bucket has high write traffic on other records.

## Bucket-Level Tracking in Practice

Bucket-level dependencies are coarser — any mutation in the bucket triggers re-evaluation:

```typescript
store.defineQuery('pendingCount', async (ctx) => {
  return ctx.bucket('orders').count({ status: 'pending' });
});

let callCount = 0;
await store.subscribe('pendingCount', (count) => {
  callCount++;
  console.log(`Pending: ${count}`);
});

// Insert a pending order — result changes
await orders.insert({ customerId: 'id-1', amount: 100 });
await store.settle();
// Pending: 1
console.log(callCount); // 1

// Insert a PAID order — query re-executes but result is the same
await orders.insert({ customerId: 'id-2', amount: 200, status: 'paid' });
await store.settle();
console.log(callCount); // 1 — re-evaluated, but deepEqual prevented callback
```

The query re-executed when the paid order was inserted (because `count()` creates a bucket-level dependency), but `deepEqual` detected the result hadn't changed and suppressed the callback.

## Mixed Dependencies

A query can have both record-level and bucket-level dependencies, even on the same bucket:

```typescript
store.defineQuery(
  'customerDashboard',
  async (ctx, params: { customerId: string }) => {
    // Record-level dependency on 'customers'
    const customer = await ctx.bucket('customers').get(params.customerId);

    // Bucket-level dependency on 'orders'
    const customerOrders = await ctx.bucket('orders').where({
      customerId: params.customerId,
    });

    return {
      name: customer?.name,
      orderCount: customerOrders.length,
      totalSpent: customerOrders.reduce((sum, o) => sum + (o.amount as number), 0),
    };
  },
);
```

```text
  Dependencies:
  ┌──────────────────────────────────────┐
  │  recordLevel:                        │
  │    customers -> { params.customerId }│
  │                                      │
  │  bucketLevel:                        │
  │    { orders }                        │
  └──────────────────────────────────────┘
```

This query re-evaluates when:
- The specific customer record (by `params.customerId`) changes — record-level
- Any record in `orders` changes — bucket-level
- It does **not** re-evaluate when a different customer record changes

### Bucket-Level Subsumes Record-Level

If a query uses both `get()` and `where()` on the same bucket, the bucket-level dependency takes precedence for invalidation:

```typescript
store.defineQuery('mixed', async (ctx, params: { id: string }) => {
  // Record-level: get(id)
  const record = await ctx.bucket('customers').get(params.id);
  // Bucket-level: where() on the same bucket
  const allPro = await ctx.bucket('customers').where({ tier: 'pro' });
  return { record, proCount: allPro.length };
});
```

```text
  Dependencies:
  ┌──────────────────────────────────────┐
  │  recordLevel:                        │
  │    customers -> { params.id }        │
  │                                      │
  │  bucketLevel:                        │
  │    { customers }                     │
  └──────────────────────────────────────┘

  Effective behavior:
    Any change to 'customers' triggers re-evaluation
    (bucket-level matches all mutations, making record-level redundant)
```

## The Invalidation Index

The store maintains two internal indexes to efficiently find affected subscriptions when data changes:

```text
  Bucket-Level Index                Record-Level Index
  ┌──────────────────────┐          ┌──────────────────────────────┐
  │  orders -> { sub1,   │          │  customers                   │
  │             sub3 }   │          │    alice-id -> { sub2 }      │
  │                      │          │    bob-id   -> { sub4 }      │
  │  customers -> { sub5 }│          │                              │
  └──────────────────────┘          │  orders                      │
                                    │    (none — all bucket-level) │
                                    └──────────────────────────────┘
```

When `orders` record with key `42` is updated, the store:
1. Looks up `bucketLevelIndex['orders']` → finds `{ sub1, sub3 }`
2. Looks up `recordLevelIndex['orders'][42]` → finds `{}` (empty)
3. Merges: `{ sub1, sub3 }` — these subscriptions need re-evaluation

When `customers` record `alice-id` is updated:
1. Looks up `bucketLevelIndex['customers']` → finds `{ sub5 }`
2. Looks up `recordLevelIndex['customers']['alice-id']` → finds `{ sub2 }`
3. Merges: `{ sub2, sub5 }` — these subscriptions need re-evaluation

This two-index lookup is O(1) per bucket and O(1) per key, making invalidation efficient even with many subscriptions.

## `deepEqual()` — Result Comparison

After re-execution, the store compares the new result to the previous one. If they are deeply equal, the callback is skipped:

```typescript
store.defineQuery('tierCounts', async (ctx) => {
  const bucket = ctx.bucket('customers');
  return {
    free: await bucket.count({ tier: 'free' }),
    pro: await bucket.count({ tier: 'pro' }),
    enterprise: await bucket.count({ tier: 'enterprise' }),
  };
});

let updates = 0;
await store.subscribe('tierCounts', () => {
  updates++;
});

// Insert a free customer
await customers.insert({ name: 'Alice', tier: 'free' });
await store.settle();
console.log(updates); // 1

// Update Alice's name (tier unchanged)
await customers.update((await customers.findOne({ name: 'Alice' }))!.id, { name: 'Alicia' });
await store.settle();
// Query re-executed (bucket-level dep on customers)
// Result: { free: 1, pro: 0, enterprise: 0 } — same as before
console.log(updates); // 1 — deepEqual prevented callback
```

### What `deepEqual` Compares

The deep equality check handles:

| Type | Comparison |
|---|---|
| Primitives (`string`, `number`, `boolean`, `null`, `undefined`) | `===` |
| `NaN` | `NaN === NaN` → `true` |
| `Date` | `.getTime()` comparison |
| `RegExp` | `.source` + `.flags` comparison |
| Arrays | Element-by-element recursive comparison |
| Plain objects | Key-by-key recursive comparison (same key count, same keys, same values) |

This means callback suppression works correctly for:
- Scalar results (`number`, `string`)
- Array results (lists of records)
- Object results (aggregation objects)
- Nested structures (objects containing arrays of objects)

## Dynamic Dependencies

Dependencies are recaptured on every re-evaluation. If query logic is conditional, the dependency set can change between executions:

```typescript
const alice = await customers.insert({ name: 'Alice', tier: 'pro' });
const bob = await customers.insert({ name: 'Bob', tier: 'free' });

let targetId = alice.id as string;

store.defineQuery('dynamicTarget', async (ctx) => {
  return ctx.bucket('customers').get(targetId);
});

const results: any[] = [];
await store.subscribe('dynamicTarget', (result) => {
  results.push(result);
});

// Update Alice — triggers callback (tracked record)
await customers.update(alice.id, { name: 'Alicia' });
await store.settle();
console.log(results.length); // 1
console.log(results[0].name); // Alicia

// Switch target to Bob
targetId = bob.id as string;

// Update Alice again — this still triggers re-evaluation
// because the store hasn't re-captured dependencies yet
// But the query now reads Bob, so deps will be updated
await customers.update(alice.id, { name: 'Alice' });
await store.settle();
// After re-evaluation, dependencies are now: customers -> { bob.id }
// Result changed (now returns Bob), so callback fires
console.log(results.length); // 2
console.log(results[1].name); // Bob

// Now updating Alice won't trigger re-evaluation
// because the dependency index points to Bob
await customers.update(alice.id, { tier: 'enterprise' });
await store.settle();
console.log(results.length); // 2 — Alice change is not tracked anymore
```

### How Dynamic Dependencies Update

```text
  Initial subscription:
    targetId = alice.id
    Query reads: get(alice.id)
    Dependencies: customers -> { alice.id }
                                                    ┌───────────────┐
  After Alice changes, re-evaluation:               │ OLD deps      │
    targetId = bob.id (changed externally)          │ alice.id      │
    Query reads: get(bob.id)                        └───────┬───────┘
    New dependencies: customers -> { bob.id }               │
                                                            v
    Store detects dependency change                 ┌───────────────┐
    Removes old index: alice.id -> sub              │ NEW deps      │
    Adds new index: bob.id -> sub                   │ bob.id        │
                                                    └───────────────┘
  Future mutations:
    Alice changes -> no re-evaluation (not indexed)
    Bob changes   -> re-evaluation (indexed)
```

Dynamic dependencies are essential for queries that navigate relationships. For example, a query that first reads a customer, then looks up their orders by ID — if the customer changes, the set of orders changes too.

## Cross-Bucket Dependency Patterns

### Pattern 1: Single Bucket, Record-Level Only

```typescript
// Watches exactly two records — minimal invalidation surface
store.defineQuery('twoCustomers', async (ctx, params: { id1: string; id2: string }) => {
  const a = await ctx.bucket('customers').get(params.id1);
  const b = await ctx.bucket('customers').get(params.id2);
  return [a, b];
});
// Dependencies: recordLevel { customers -> { id1, id2 } }
// Re-evaluates only when id1 or id2 changes
```

### Pattern 2: Single Bucket, Bucket-Level

```typescript
// Aggregates the entire bucket — any change triggers re-evaluation
store.defineQuery('orderStats', async (ctx) => {
  const bucket = ctx.bucket('orders');
  return {
    total: await bucket.count(),
    revenue: await bucket.sum('amount'),
    avgOrder: await bucket.avg('amount'),
  };
});
// Dependencies: bucketLevel { orders }
// Re-evaluates on any orders mutation
```

### Pattern 3: Multiple Buckets, Mixed Levels

```typescript
// Record-level on customers, bucket-level on orders
store.defineQuery('customerReport', async (ctx, params: { customerId: string }) => {
  const customer = await ctx.bucket('customers').get(params.customerId);
  const customerOrders = await ctx.bucket('orders').where({
    customerId: params.customerId,
  });
  const topProduct = customerOrders.length > 0
    ? await ctx.bucket('products').get(customerOrders[0].productSku as string)
    : null;
  return { customer, orders: customerOrders, topProduct };
});
// Dependencies:
//   recordLevel: { customers -> { customerId }, products -> { productSku } }
//   bucketLevel: { orders }
```

### Pattern 4: Conditional Dependencies

```typescript
// Dependencies change based on data
store.defineQuery('conditionalQuery', async (ctx, params: { customerId: string }) => {
  const customer = await ctx.bucket('customers').get(params.customerId);
  if (!customer) return null;

  // Only reads orders if customer exists — dependency is conditional
  if (customer.tier === 'enterprise') {
    return ctx.bucket('orders').where({ customerId: params.customerId });
  }

  return [];
});
// If customer exists and is enterprise:
//   recordLevel: { customers -> { customerId } }
//   bucketLevel: { orders }
// If customer doesn't exist or isn't enterprise:
//   recordLevel: { customers -> { customerId } }
//   bucketLevel: (empty) — orders bucket not accessed
```

## Complete Working Example

Demonstrating dependency tracking precision with counters:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'deps-tracking-demo' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:   { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
      role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
    },
  });

  await store.defineBucket('posts', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      authorId: { type: 'string', required: true },
      title:    { type: 'string', required: true },
      draft:    { type: 'boolean', default: true },
    },
    indexes: ['authorId'],
  });

  const users = store.bucket('users');
  const posts = store.bucket('posts');

  const alice = await users.insert({ name: 'Alice', role: 'admin' });
  const bob = await users.insert({ name: 'Bob' });

  // Query 1: record-level — watches one specific user
  store.defineQuery('watchUser', async (ctx, params: { userId: string }) => {
    return ctx.bucket('users').get(params.userId);
  });

  // Query 2: bucket-level — counts all published posts
  store.defineQuery('publishedCount', async (ctx) => {
    const all = await ctx.bucket('posts').all();
    return all.filter((p) => !p.draft).length;
  });

  let userUpdates = 0;
  let postUpdates = 0;

  const unsub1 = await store.subscribe(
    'watchUser',
    { userId: alice.id as string },
    (user) => {
      userUpdates++;
      console.log(`[user #${userUpdates}] ${(user as any).name} (${(user as any).role})`);
    },
  );

  const unsub2 = await store.subscribe('publishedCount', (count) => {
    postUpdates++;
    console.log(`[posts #${postUpdates}] Published: ${count}`);
  });

  // --- Test record-level precision ---

  // Update Alice — triggers watchUser
  await users.update(alice.id, { name: 'Alicia' });
  await store.settle();
  // [user #1] Alicia (admin)

  // Update Bob — does NOT trigger watchUser (different record)
  await users.update(bob.id, { role: 'admin' });
  await store.settle();
  console.log(`User updates after Bob change: ${userUpdates}`); // 1

  // --- Test bucket-level with deepEqual ---

  // Insert a draft post — query re-executes, but published count unchanged
  await posts.insert({ authorId: alice.id as string, title: 'Draft', draft: true });
  await store.settle();
  console.log(`Post updates after draft insert: ${postUpdates}`); // 0

  // Publish the post — count changes
  await posts.update(1, { draft: false });
  await store.settle();
  // [posts #1] Published: 1

  // Insert another draft — count still 1, callback suppressed
  await posts.insert({ authorId: bob.id as string, title: 'Another Draft', draft: true });
  await store.settle();
  console.log(`Post updates after second draft: ${postUpdates}`); // 1

  console.log(`\nFinal: ${userUpdates} user updates, ${postUpdates} post updates`);
  // Final: 1 user updates, 1 post updates

  unsub1();
  unsub2();
  await store.stop();
}

main();
```

## Exercise

Given the setup from this chapter, predict the behavior and verify:

1. Define a query `'productLookup'` that uses `get(sku)` to fetch a single product by SKU.
2. Define a query `'expensiveOrders'` that uses `where()` to find orders with `status: 'paid'`.
3. Subscribe to both queries.
4. Insert a product with SKU `'WIDGET-1'`. Does `productLookup` callback fire? Does `expensiveOrders` callback fire?
5. Insert an order with `status: 'pending'`. Does `expensiveOrders` callback fire?
6. Update the pending order to `status: 'paid'`. Does `expensiveOrders` callback fire?
7. Insert a new product with SKU `'GADGET-2'`. Does `productLookup` callback fire?

<details>
<summary>Solution</summary>

```typescript
// 1. Record-level dependency on products
store.defineQuery('productLookup', async (ctx) => {
  return ctx.bucket('products').get('WIDGET-1');
});

// 2. Bucket-level dependency on orders
store.defineQuery('expensiveOrders', async (ctx) => {
  return ctx.bucket('orders').where({ status: 'paid' });
});

let productCalls = 0;
let orderCalls = 0;

const unsub1 = await store.subscribe('productLookup', () => { productCalls++; });
const unsub2 = await store.subscribe('expensiveOrders', () => { orderCalls++; });

// 4. Insert product WIDGET-1
await products.insert({ sku: 'WIDGET-1', name: 'Widget', price: 10 });
await store.settle();
console.log(`Product calls: ${productCalls}`); // 1 — the watched record was created
console.log(`Order calls: ${orderCalls}`);     // 0 — products bucket is not a dependency

// 5. Insert pending order
await orders.insert({ customerId: 'x', amount: 100, status: 'pending' });
await store.settle();
// expensiveOrders re-executes (bucket-level dep on orders)
// But result is still [] (no paid orders) — deepEqual suppresses callback
console.log(`Order calls: ${orderCalls}`); // 0

// 6. Update to paid
await orders.update(1, { status: 'paid' });
await store.settle();
// expensiveOrders re-executes, result changed from [] to [record]
console.log(`Order calls: ${orderCalls}`); // 1

// 7. Insert GADGET-2
await products.insert({ sku: 'GADGET-2', name: 'Gadget', price: 20 });
await store.settle();
// productLookup depends on record 'WIDGET-1', not 'GADGET-2'
// Record-level tracking — different key, no re-evaluation
console.log(`Product calls: ${productCalls}`); // 1 — unchanged

unsub1();
unsub2();
```

</details>

## Summary

- **Record-level dependencies** (`get(key)`) track specific keys — the query re-evaluates only when those exact records change
- **Bucket-level dependencies** (all other methods) track entire buckets — any mutation triggers re-evaluation
- The store maintains a **two-index structure**: bucket-level index (bucket → subscriptions) and record-level index (bucket + key → subscriptions) for O(1) invalidation lookup
- **`deepEqual()`** compares results after re-evaluation — the callback fires only when the result actually differs, handling primitives, arrays, objects, dates, and nested structures
- **Dynamic dependencies** are recaptured on every re-evaluation — if query logic changes which data it reads, the dependency index updates accordingly
- Mixed dependencies (record-level on one bucket, bucket-level on another) give fine-grained control over invalidation
- **Bucket-level subsumes record-level** on the same bucket — once `where()` or any scanning method is used, all mutations in that bucket trigger re-evaluation
- Dependency tracking is **automatic and implicit** — you write normal query code and the store instruments it behind the scenes through `QueryContext`

## API Reference

- [Reactive Queries](../../reference/reactive-queries.md) — `QueryDependencies`, bucket-level vs record-level tracking, deep equality

---

Next: [Event System](../06-events/01-event-system.md)
