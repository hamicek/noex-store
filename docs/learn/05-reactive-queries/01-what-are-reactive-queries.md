# What Are Reactive Queries?

Your dashboard shows a list of pending orders. A teammate inserts a new order from another part of the system. Your dashboard still shows the old count. You click refresh — now it updates. A minute later someone cancels an order. Stale again. You set up a polling interval, but now you're choosing between wasted CPU cycles (polling too often) and stale data (polling too slowly). And when you have ten components each polling different buckets, the overhead adds up fast.

noex-store solves this with **reactive queries** — functions that automatically re-execute when the data they read changes, and push updated results to subscribers. No polling, no manual refresh, no event wiring. You define a query once, subscribe to it, and the store handles the rest.

## What You'll Learn

- Why polling and manual event wiring fail for real-time data
- How reactive queries differ from events and polling
- The subscription lifecycle: define, subscribe, receive updates, unsubscribe
- How the store knows which queries to re-run when data changes
- What "Convex-style" reactivity means and why it matters
- When reactive queries are the right tool vs events or manual reads

## The Problem: Keeping Data in Sync

Consider a simple dashboard that shows order statistics:

```typescript
// Manual approach — query once, hope for the best
const orders = store.bucket('orders');

const pending = await orders.where({ status: 'pending' });
const total = await orders.count();

renderDashboard({ pendingCount: pending.length, totalOrders: total });

// New order inserted elsewhere — dashboard is now stale
// No mechanism to detect this and re-render
```

There are three common attempts to fix this:

### Approach 1: Polling

```typescript
setInterval(async () => {
  const pending = await orders.where({ status: 'pending' });
  const total = await orders.count();
  renderDashboard({ pendingCount: pending.length, totalOrders: total });
}, 1000);
```

**Problems:**
- Wastes resources when nothing changed (most polls return identical data)
- Still stale between intervals — 1 second is not instant
- Multiple components polling creates redundant work
- No clean way to stop polling when the component unmounts

### Approach 2: Manual Event Wiring

```typescript
let pendingCount = 0;
let totalOrders = 0;

// Initial load
const pending = await orders.where({ status: 'pending' });
pendingCount = pending.length;
totalOrders = await orders.count();
renderDashboard({ pendingCount, totalOrders });

// Listen to every mutation and re-query
await store.on('bucket.orders.*', async () => {
  const pending = await orders.where({ status: 'pending' });
  pendingCount = pending.length;
  totalOrders = await orders.count();
  renderDashboard({ pendingCount, totalOrders });
});
```

**Problems:**
- Re-queries on every mutation, even ones that don't affect the result
- Have to manually track which buckets to listen to
- Duplicated query logic between initial load and event handler
- Hard to compose — a query reading from three buckets needs three event subscriptions
- No deduplication — if the result didn't change, you still re-render

### Approach 3: Reactive Queries

```typescript
store.defineQuery('dashboardStats', async (ctx) => {
  const orders = ctx.bucket('orders');
  const pending = await orders.where({ status: 'pending' });
  const total = await orders.count();
  return { pendingCount: pending.length, totalOrders: total };
});

await store.subscribe('dashboardStats', (stats) => {
  renderDashboard(stats);
});
```

**Advantages:**
- Query logic defined once — no duplication
- Store automatically detects which buckets the query reads
- Re-executes only when relevant data changes
- Callback fires only when the result actually differs (deep equality check)
- Clean unsubscribe for teardown

## Comparison: Three Approaches

| | Polling | Events + Manual Query | Reactive Queries |
|---|---|---|---|
| **Freshness** | Delayed (interval) | Immediate | Immediate |
| **Wasted work** | High (most polls redundant) | Medium (re-queries on all mutations) | Low (re-queries only on relevant changes) |
| **Query duplication** | Yes (in interval callback) | Yes (initial + event handler) | No (single definition) |
| **Multi-bucket** | One interval per bucket | One listener per bucket | Automatic tracking |
| **Result deduplication** | None | None | Built-in (deepEqual) |
| **Teardown** | clearInterval | Multiple unsub calls | Single unsub call |

## How Reactive Queries Work

The reactive query system has three phases:

```text
  Phase 1: DEFINE                Phase 2: SUBSCRIBE               Phase 3: REACT
  ┌───────────────────┐          ┌───────────────────────────┐     ┌──────────────────────┐
  │                   │          │                           │     │                      │
  │  defineQuery(     │          │  subscribe(               │     │  Data changes in     │
  │    'stats',       │          │    'stats',               │     │  'orders' bucket     │
  │    async (ctx) => │          │    (result) => { ... }    │     │                      │
  │      ...          │          │  )                        │     │  Store detects that   │
  │  )                │          │                           │     │  'stats' reads from  │
  │                   │   ───>   │  1. Execute query         │     │  'orders'            │
  │  Registers the    │          │  2. Track dependencies    │  >  │                      │
  │  query function   │          │  3. Store initial result  │     │  Re-execute query    │
  │  by name          │          │  4. Return unsubscribe fn │     │  Compare results     │
  │                   │          │                           │     │  Call callback if     │
  │                   │          │                           │     │  result changed       │
  └───────────────────┘          └───────────────────────────┘     └──────────────────────┘
```

### Phase 1: Define

`defineQuery(name, fn)` registers a named query function. The function receives a `QueryContext` that provides read-only access to buckets. It does not execute immediately.

### Phase 2: Subscribe

`subscribe(name, callback)` executes the query for the first time. During execution, the store tracks every bucket method the query calls — this builds the **dependency set**. The initial result is stored internally, and the unsubscribe function is returned.

Note: the callback is **not** called with the initial result. It only fires on subsequent changes.

### Phase 3: React

When data changes in any bucket, the store checks which subscriptions depend on that bucket. For each affected subscription, the query re-executes, a new dependency set is captured, and the new result is compared to the previous one using `deepEqual()`. The callback fires only if the result actually changed.

## Dependency Tracking: The Key Insight

The reactive system's most important feature is **automatic dependency tracking**. You don't declare which buckets a query reads — the store figures it out by observing which methods you call:

```typescript
store.defineQuery('ordersByRegion', async (ctx, params: { region: string }) => {
  // The store sees this call and records: "this query depends on 'orders'"
  const orders = await ctx.bucket('orders').where({ region: params.region });

  // The store sees this call and records: "this query also depends on 'customers'"
  const customerIds = [...new Set(orders.map((o) => o.customerId))];
  const customers = await Promise.all(
    customerIds.map((id) => ctx.bucket('customers').get(id)),
  );

  return { orders, customers: customers.filter(Boolean) };
});
```

This query depends on two buckets: `orders` (bucket-level, because it uses `where()`) and `customers` (record-level, because it uses `get()` with specific keys). The store tracks both and re-evaluates only when one of these dependencies is affected. A change to an unrelated bucket like `products` has zero effect.

Dependencies are **dynamic** — they're recaptured on every re-execution. If a query conditionally reads from different buckets based on the data, the dependency set updates accordingly.

## When to Use Reactive Queries

Reactive queries are the right choice when:

- **Multiple consumers need the same derived data** — define once, subscribe many times
- **Data changes frequently** and you need instant updates without polling
- **Queries span multiple buckets** and you want automatic dependency tracking
- **Result deduplication matters** — avoid unnecessary re-renders when the output is the same

Events (`store.on()`) are better when:

- You need to react to **individual mutations** (the specific record that changed)
- You need **before/after state** (events carry `oldRecord` and `newRecord`)
- You're building **side effects** like audit logs or notifications
- You care about **which operation happened**, not the aggregate result

A one-time `runQuery()` is better when:

- You need the result **once** without ongoing updates
- You're building a request/response API endpoint
- The query runs in a context where subscriptions don't make sense (e.g., a CLI tool)

## Complete Working Example

A live dashboard that reacts to order changes:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'reactive-intro' });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:     { type: 'number', generated: 'autoincrement' },
      item:   { type: 'string', required: true },
      status: { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
      total:  { type: 'number', required: true, min: 0 },
    },
    indexes: ['status'],
  });

  const orders = store.bucket('orders');

  // Define a reactive query
  store.defineQuery('orderSummary', async (ctx) => {
    const bucket = ctx.bucket('orders');
    const pending = await bucket.count({ status: 'pending' });
    const paid = await bucket.count({ status: 'paid' });
    const shipped = await bucket.count({ status: 'shipped' });
    const total = await bucket.count();
    return { pending, paid, shipped, total };
  });

  // Subscribe — callback fires only when the result changes
  const unsub = await store.subscribe('orderSummary', (stats) => {
    console.log('[dashboard]', stats);
  });

  // Initial state: no callback yet (subscribe doesn't call callback for initial result)

  await orders.insert({ item: 'Laptop', total: 999 });
  await store.settle();
  // [dashboard] { pending: 1, paid: 0, shipped: 0, total: 1 }

  await orders.insert({ item: 'Mouse', total: 25 });
  await store.settle();
  // [dashboard] { pending: 2, paid: 0, shipped: 0, total: 2 }

  await orders.update(1, { status: 'paid' });
  await store.settle();
  // [dashboard] { pending: 1, paid: 1, shipped: 0, total: 2 }

  await orders.update(1, { status: 'shipped' });
  await store.settle();
  // [dashboard] { pending: 1, paid: 0, shipped: 1, total: 2 }

  // Cleanup
  unsub();
  await store.stop();
}

main();
```

## Exercise

You have a store with `tasks` and `users` buckets. Without implementing reactive queries yet (that's next chapter), answer these conceptual questions:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    title:    { type: 'string', required: true },
    assignee: { type: 'string', required: true },
    done:     { type: 'boolean', default: false },
  },
  indexes: ['assignee'],
});

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
  },
});
```

Consider a reactive query that counts incomplete tasks per user:

```typescript
store.defineQuery('incompleteTasks', async (ctx) => {
  const tasks = await ctx.bucket('tasks').where({ done: false });
  return tasks.length;
});
```

1. Which buckets does this query depend on?
2. At what level — bucket-level or record-level?
3. If a new task is inserted with `done: true`, will the callback fire?
4. If a user's name is updated, will the callback fire?
5. If a task is deleted, will the query re-execute? Will the callback fire if the deleted task had `done: true`?

<details>
<summary>Solution</summary>

1. Only `tasks` — the query calls `ctx.bucket('tasks').where(...)` but never accesses `users`.
2. Bucket-level — `where()` creates a bucket-level dependency (any change in the bucket triggers re-evaluation).
3. Yes, the query will re-execute (any change to `tasks` triggers it). But the callback will fire only if the count actually changed. Since the new task has `done: true`, `where({ done: false })` returns the same set, so `deepEqual` detects no change — **callback does not fire**.
4. No — the query does not depend on the `users` bucket at all. Changes to `users` have zero effect.
5. Yes, the query will re-execute (deletion is a change to `tasks`). If the deleted task had `done: true`, the incomplete count is unchanged, so `deepEqual` returns `true` — **callback does not fire**. If the deleted task had `done: false`, the count decreases, so the callback fires.

</details>

## Summary

- **Polling** wastes resources and introduces latency; **manual event wiring** duplicates logic and re-queries on every mutation
- **Reactive queries** define a query function once and automatically re-execute when the underlying data changes
- The subscription lifecycle is: `defineQuery()` to register, `subscribe()` to start receiving updates, unsubscribe to stop
- The store **tracks dependencies automatically** by observing which bucket methods the query calls during execution
- Callbacks fire only when the result actually changes, verified by **deep equality comparison** (`deepEqual`)
- Dependencies are **dynamic** — they are recaptured on every re-execution, adapting to conditional query logic
- Use reactive queries for live dashboards and derived data; use events for side effects and mutation-level reactions; use `runQuery()` for one-time reads
- `store.settle()` waits for all pending re-evaluations — essential for deterministic testing

---

Next: [Defining and Subscribing](./02-defining-and-subscribing.md)
