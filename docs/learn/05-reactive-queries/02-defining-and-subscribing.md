# Defining and Subscribing

You understand why reactive queries exist. Now it's time to use them. This chapter covers the full API: defining queries with `defineQuery()`, subscribing to live updates with `subscribe()`, running one-off queries with `runQuery()`, passing parameters to queries, and cleaning up subscriptions.

## What You'll Learn

- How to define a reactive query with `store.defineQuery()`
- How `subscribe()` starts a live subscription and returns an unsubscribe function
- How `runQuery()` executes a query once without subscribing
- How parameterized queries accept arguments to produce filtered results
- How `store.settle()` ensures all pending re-evaluations complete
- How errors behave in query definitions and during re-evaluation

## Setup

All examples in this chapter use the following store:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'reactive-demo' });

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

const customers = store.bucket('customers');
const orders = store.bucket('orders');
```

## `defineQuery()` — Register a Query Function

`defineQuery(name, fn)` registers a named query function. The function receives a `QueryContext` as its first argument, which provides read-only access to all buckets:

```typescript
store.defineQuery('totalCustomers', async (ctx) => {
  return ctx.bucket('customers').count();
});
```

The query function:
- Must be `async` (returns a `Promise`)
- Receives a `QueryContext` — not direct bucket handles
- Can read from multiple buckets in a single query
- Must not mutate data — `QueryContext` provides read-only methods only

### QueryContext API

The `ctx.bucket(name)` method returns a read-only `QueryBucket` with these methods:

| Method | Returns | Description |
|---|---|---|
| `get(key)` | `StoreRecord \| undefined` | Retrieve one record by primary key |
| `all()` | `StoreRecord[]` | All records in the bucket |
| `where(filter)` | `StoreRecord[]` | Records matching the filter |
| `findOne(filter)` | `StoreRecord \| undefined` | First record matching the filter |
| `count(filter?)` | `number` | Count of matching records |
| `first(n)` | `StoreRecord[]` | First n records |
| `last(n)` | `StoreRecord[]` | Last n records |
| `paginate(options)` | `PaginatedResult` | Cursor-based pagination |
| `sum(field, filter?)` | `number` | Sum of a numeric field |
| `avg(field, filter?)` | `number` | Average of a numeric field |
| `min(field, filter?)` | `number \| undefined` | Minimum value |
| `max(field, filter?)` | `number \| undefined` | Maximum value |

These are the same methods available on `BucketHandle`, but through a read-only interface that tracks dependencies.

### Query Name Must Be Unique

Defining two queries with the same name throws a `QueryAlreadyDefinedError`:

```typescript
store.defineQuery('stats', async (ctx) => ctx.bucket('customers').count());

try {
  store.defineQuery('stats', async (ctx) => ctx.bucket('orders').count());
} catch (err) {
  console.log(err.message); // Query "stats" is already defined
}
```

## `subscribe()` — Live Updates

`subscribe(name, callback)` starts a live subscription. It executes the query immediately, stores the initial result, and calls the callback whenever the result changes:

```typescript
store.defineQuery('customerCount', async (ctx) => {
  return ctx.bucket('customers').count();
});

const unsub = await store.subscribe('customerCount', (count) => {
  console.log(`Customers: ${count}`);
});

// No callback yet — subscribe does NOT call callback for the initial result

await customers.insert({ name: 'Alice' });
await store.settle();
// Customers: 1

await customers.insert({ name: 'Bob' });
await store.settle();
// Customers: 2
```

### Subscribe Returns an Unsubscribe Function

The return value of `subscribe()` is a function that stops the subscription:

```typescript
const unsub = await store.subscribe('customerCount', (count) => {
  console.log(`Customers: ${count}`);
});

await customers.insert({ name: 'Alice' });
await store.settle();
// Customers: 1

// Stop listening
unsub();

await customers.insert({ name: 'Bob' });
await store.settle();
// No output — subscription is gone
```

Always call the unsubscribe function when the consumer's lifetime ends. Forgetting to unsubscribe creates a memory leak.

### Multiple Subscribers

Multiple callbacks can subscribe to the same query. Each subscription is independent — it tracks its own result and dependencies:

```typescript
store.defineQuery('pendingCount', async (ctx) => {
  return ctx.bucket('orders').count({ status: 'pending' });
});

const unsub1 = await store.subscribe('pendingCount', (count) => {
  console.log(`[widget] Pending: ${count}`);
});

const unsub2 = await store.subscribe('pendingCount', (count) => {
  console.log(`[header] ${count} orders pending`);
});

await orders.insert({ customerId: 'some-id', amount: 100 });
await store.settle();
// [widget] Pending: 1
// [header] 1 orders pending

unsub1();
unsub2();
```

### Callback Fires Only on Change

The store compares the new result against the previous one using deep equality. If the result is identical, the callback is skipped:

```typescript
store.defineQuery('pendingOrders', async (ctx) => {
  return ctx.bucket('orders').where({ status: 'pending' });
});

let callCount = 0;
await store.subscribe('pendingOrders', () => {
  callCount++;
});

// Insert a PAID order — the pending set is unchanged
await orders.insert({ customerId: 'id-1', amount: 50, status: 'paid' });
await store.settle();
// callCount is still 0 — result did not change (pending set is still empty)

// Insert a PENDING order — the pending set changed
await orders.insert({ customerId: 'id-2', amount: 75 });
await store.settle();
// callCount is now 1 — result changed
```

Note: the query still re-executes on any change to the `orders` bucket (because `where()` creates a bucket-level dependency). But the callback fires only if the re-execution produces a different result.

## `runQuery()` — One-Time Execution

`runQuery(name, params?)` executes a query once and returns the result directly. No subscription is created, no callback is registered:

```typescript
store.defineQuery('totalRevenue', async (ctx) => {
  return ctx.bucket('orders').sum('amount');
});

const revenue = await store.runQuery('totalRevenue');
console.log(`Revenue: $${revenue}`); // Revenue: $0

await orders.insert({ customerId: 'id-1', amount: 100 });
await orders.insert({ customerId: 'id-2', amount: 250 });

const updated = await store.runQuery('totalRevenue');
console.log(`Revenue: $${updated}`); // Revenue: $350
```

Use `runQuery()` for:
- API endpoints that need a snapshot of data
- CLI tools where subscriptions don't make sense
- Tests that need to assert a query's result at a specific point

### Undefined Query

Both `subscribe()` and `runQuery()` throw `QueryNotDefinedError` if the query name doesn't exist:

```typescript
try {
  await store.runQuery('nonExistent');
} catch (err) {
  console.log(err.message); // Query "nonExistent" is not defined
}
```

## Parameterized Queries

Queries can accept parameters as a second argument. This lets you define a single query that produces different results based on input:

```typescript
store.defineQuery('ordersByStatus', async (ctx, params: { status: string }) => {
  return ctx.bucket('orders').where({ status: params.status });
});

// Subscribe with specific params
const unsub = await store.subscribe(
  'ordersByStatus',
  { status: 'pending' },
  (result) => {
    console.log(`Pending orders: ${result.length}`);
  },
);

await orders.insert({ customerId: 'id-1', amount: 50 });
await store.settle();
// Pending orders: 1

await orders.insert({ customerId: 'id-2', amount: 100, status: 'paid' });
await store.settle();
// No output — paid order doesn't change the pending count

unsub();
```

### Multiple Subscriptions with Different Parameters

Each `(queryName, params)` combination is an independent subscription with its own result and dependencies:

```typescript
store.defineQuery('customersByTier', async (ctx, params: { tier: string }) => {
  return ctx.bucket('customers').where({ tier: params.tier });
});

const unsubFree = await store.subscribe(
  'customersByTier',
  { tier: 'free' },
  (result) => {
    console.log(`Free customers: ${result.length}`);
  },
);

const unsubPro = await store.subscribe(
  'customersByTier',
  { tier: 'pro' },
  (result) => {
    console.log(`Pro customers: ${result.length}`);
  },
);

await customers.insert({ name: 'Alice', tier: 'free' });
await store.settle();
// Free customers: 1
// (pro callback may or may not fire — depends on deepEqual result)

await customers.insert({ name: 'Bob', tier: 'pro' });
await store.settle();
// Pro customers: 1

unsubFree();
unsubPro();
```

### `runQuery()` with Parameters

```typescript
store.defineQuery('customerByName', async (ctx, params: { name: string }) => {
  return ctx.bucket('customers').findOne({ name: params.name });
});

await customers.insert({ name: 'Alice', tier: 'enterprise' });

const alice = await store.runQuery('customerByName', { name: 'Alice' });
console.log(alice?.tier); // enterprise
```

## `store.settle()` — Wait for Re-Evaluations

Reactive re-evaluations are asynchronous. After mutating data, pending re-evaluations run in the background. `store.settle()` waits for all of them to complete:

```typescript
store.defineQuery('count', async (ctx) => ctx.bucket('customers').count());

await store.subscribe('count', (n) => console.log(`Count: ${n}`));

await customers.insert({ name: 'Alice' });
// Re-evaluation is queued but may not have completed yet

await store.settle();
// Now all callbacks have fired — Count: 1
```

In production code, you generally don't need `settle()` — callbacks fire asynchronously and updates flow naturally. In tests, `settle()` is essential for deterministic assertions.

## Cross-Bucket Queries

A query can read from any number of buckets:

```typescript
store.defineQuery(
  'customerWithOrders',
  async (ctx, params: { customerId: string }) => {
    const customer = await ctx.bucket('customers').get(params.customerId);
    if (!customer) return null;

    const customerOrders = await ctx.bucket('orders').where({
      customerId: params.customerId,
    });

    const totalSpent = customerOrders.reduce((sum, o) => sum + (o.amount as number), 0);

    return {
      name: customer.name,
      tier: customer.tier,
      orderCount: customerOrders.length,
      totalSpent,
    };
  },
);

const alice = await customers.insert({ name: 'Alice', tier: 'pro' });

const unsub = await store.subscribe(
  'customerWithOrders',
  { customerId: alice.id as string },
  (result) => {
    console.log(result);
  },
);

await orders.insert({ customerId: alice.id as string, amount: 100 });
await store.settle();
// { name: 'Alice', tier: 'pro', orderCount: 1, totalSpent: 100 }

await orders.insert({ customerId: alice.id as string, amount: 200 });
await store.settle();
// { name: 'Alice', tier: 'pro', orderCount: 2, totalSpent: 300 }

await customers.update(alice.id, { tier: 'enterprise' });
await store.settle();
// { name: 'Alice', tier: 'enterprise', orderCount: 2, totalSpent: 300 }

unsub();
```

This query depends on both `customers` (record-level via `get()`) and `orders` (bucket-level via `where()`). The store tracks both dependencies and re-evaluates when either changes.

## Error Handling

### Errors During Initial Subscription

If the query function throws during the initial `subscribe()` call, the error propagates to the caller and no subscription is created:

```typescript
store.defineQuery('failing', async () => {
  throw new Error('Something broke');
});

try {
  await store.subscribe('failing', () => {});
} catch (err) {
  console.log(err.message); // Something broke
}
// No subscription was created
```

### Errors During Re-Evaluation

If a query function throws during a subsequent re-evaluation (triggered by a data change), the error is swallowed and the subscription stays alive. The callback is not called, and the previous result is retained:

```typescript
let shouldFail = false;

store.defineQuery('fragile', async (ctx) => {
  if (shouldFail) throw new Error('Temporary failure');
  return ctx.bucket('customers').count();
});

await store.subscribe('fragile', (count) => {
  console.log(`Count: ${count}`);
});

await customers.insert({ name: 'Alice' });
await store.settle();
// Count: 1

shouldFail = true;
await customers.insert({ name: 'Bob' });
await store.settle();
// No output — error swallowed, subscription survives

shouldFail = false;
await customers.insert({ name: 'Carol' });
await store.settle();
// Count: 3 — subscription recovered
```

This resilience means a transient failure (like a temporary network issue in a custom adapter) doesn't permanently break subscriptions.

## Complete Working Example

A product catalog with live statistics and filtered views:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'subscribe-demo' });

  await store.defineBucket('products', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      name:     { type: 'string', required: true },
      category: { type: 'string', enum: ['electronics', 'clothing', 'books'], required: true },
      price:    { type: 'number', required: true, min: 0 },
      inStock:  { type: 'boolean', default: true },
    },
    indexes: ['category'],
  });

  const products = store.bucket('products');

  // --- Define queries ---

  // 1. Total product count
  store.defineQuery('productCount', async (ctx) => {
    return ctx.bucket('products').count();
  });

  // 2. Products by category (parameterized)
  store.defineQuery('byCategory', async (ctx, params: { category: string }) => {
    return ctx.bucket('products').where({ category: params.category });
  });

  // 3. Price statistics
  store.defineQuery('priceStats', async (ctx) => {
    const bucket = ctx.bucket('products');
    const avg = await bucket.avg('price');
    const min = await bucket.min('price');
    const max = await bucket.max('price');
    const total = await bucket.sum('price');
    return { avg: Math.round(avg * 100) / 100, min, max, total };
  });

  // --- Subscribe ---

  const unsub1 = await store.subscribe('productCount', (count) => {
    console.log(`[count] ${count} products`);
  });

  const unsub2 = await store.subscribe(
    'byCategory',
    { category: 'electronics' },
    (result) => {
      console.log(`[electronics] ${result.map((p: any) => p.name).join(', ')}`);
    },
  );

  const unsub3 = await store.subscribe('priceStats', (stats) => {
    console.log(`[prices] avg=$${stats.avg} min=$${stats.min} max=$${stats.max}`);
  });

  // --- Mutate data ---

  await products.insert({ name: 'Laptop', category: 'electronics', price: 999 });
  await store.settle();
  // [count] 1 products
  // [electronics] Laptop
  // [prices] avg=$999 min=$999 max=$999

  await products.insert({ name: 'T-Shirt', category: 'clothing', price: 25 });
  await store.settle();
  // [count] 2 products
  // [prices] avg=$512 min=$25 max=$999
  // (electronics callback does not fire — result unchanged)

  await products.insert({ name: 'Keyboard', category: 'electronics', price: 75 });
  await store.settle();
  // [count] 3 products
  // [electronics] Laptop, Keyboard
  // [prices] avg=$366.33 min=$25 max=$999

  // --- One-time query ---
  const bookCount = await store.runQuery('byCategory', { category: 'books' });
  console.log(`\nBooks (one-time): ${(bookCount as any[]).length}`);
  // Books (one-time): 0

  // --- Cleanup ---
  unsub1();
  unsub2();
  unsub3();
  await store.stop();
}

main();
```

## Exercise

Given the setup from this chapter, define and use the following reactive queries:

1. Define a query `'highValueOrders'` that returns all orders with `amount` greater than 200. Since `where()` only supports strict equality, retrieve all orders with `all()` and filter in the query function.
2. Define a parameterized query `'orderTotal'` that takes `{ customerId: string }` and returns the sum of all order amounts for that customer.
3. Subscribe to `'highValueOrders'` and log the count of high-value orders.
4. Subscribe to `'orderTotal'` for two different customer IDs and log each total.
5. Insert orders for both customers, then use `runQuery()` to verify the `'orderTotal'` result for one of them.

<details>
<summary>Solution</summary>

```typescript
// 1. High-value orders (no params, bucket-level dependency)
store.defineQuery('highValueOrders', async (ctx) => {
  const all = await ctx.bucket('orders').all();
  return all.filter((o) => (o.amount as number) > 200);
});

// 2. Parameterized order total per customer
store.defineQuery('orderTotal', async (ctx, params: { customerId: string }) => {
  const customerOrders = await ctx.bucket('orders').where({
    customerId: params.customerId,
  });
  return customerOrders.reduce((sum, o) => sum + (o.amount as number), 0);
});

// 3. Subscribe to high-value orders
const unsubHigh = await store.subscribe('highValueOrders', (result) => {
  console.log(`High-value orders: ${result.length}`);
});

// 4. Subscribe to order totals for two customers
const alice = await customers.insert({ name: 'Alice' });
const bob = await customers.insert({ name: 'Bob' });

const unsubAlice = await store.subscribe(
  'orderTotal',
  { customerId: alice.id as string },
  (total) => {
    console.log(`Alice total: $${total}`);
  },
);

const unsubBob = await store.subscribe(
  'orderTotal',
  { customerId: bob.id as string },
  (total) => {
    console.log(`Bob total: $${total}`);
  },
);

// 5. Insert orders and verify
await orders.insert({ customerId: alice.id as string, amount: 300 });
await orders.insert({ customerId: bob.id as string, amount: 150 });
await orders.insert({ customerId: alice.id as string, amount: 500 });
await store.settle();
// High-value orders: 2
// Alice total: $800
// Bob total: $150

const aliceTotal = await store.runQuery('orderTotal', { customerId: alice.id as string });
console.log(`Verified Alice total: $${aliceTotal}`); // Verified Alice total: $800

// Cleanup
unsubHigh();
unsubAlice();
unsubBob();
```

</details>

## Summary

- **`store.defineQuery(name, fn)`** registers a named query function that receives a read-only `QueryContext` — names must be unique
- **`store.subscribe(name, callback)`** starts a live subscription: executes the query, tracks dependencies, and calls the callback on subsequent changes
- **The callback is not called for the initial result** — only for changes after subscription
- **`store.runQuery(name, params?)`** executes a query once without creating a subscription — use for snapshots and tests
- **Parameterized queries** accept a second argument: `subscribe(name, params, callback)` — each `(name, params)` pair is an independent subscription
- **`store.settle()`** waits for all pending re-evaluations — essential in tests, rarely needed in production
- **Errors during initial subscribe** propagate to the caller; **errors during re-evaluation** are swallowed and the subscription survives
- **Cross-bucket queries** read from multiple buckets and the store tracks dependencies on all of them automatically

## API Reference

- [Reactive Queries](../../reference/reactive-queries.md) — `QueryFn`, `QueryContext`, parameterized queries
- [Store API](../../reference/store.md) — `defineQuery()`, `subscribe()`, `runQuery()`, `settle()`

---

Next: [Dependency Tracking](./03-dependency-tracking.md)
