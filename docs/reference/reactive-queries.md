# Reactive Queries API Reference

> Automatic, dependency-tracked queries that re-evaluate when their underlying data changes and notify subscribers only when results actually differ.

## Overview

Reactive queries let you define named read-only computations over bucket data and subscribe to their results. The system automatically tracks which buckets and records each query reads, re-evaluates the query when those dependencies change, and invokes the subscriber callback only when the new result is structurally different from the previous one (deep equality check).

Queries are registered with `store.defineQuery()`, consumed with `store.subscribe()` or `store.runQuery()`, and cleaned up by calling the returned unsubscribe function or `store.stop()`.

## API

### Defining Queries

---

### `store.defineQuery(name, fn): void`

Registers a named reactive query. The query function receives a [`QueryContext`](#querycontext) and optional parameters, and must return a result asynchronously. Only read operations are allowed inside a query — mutations (insert, update, delete) are not available on the [`QueryBucket`](#querybucket) interface.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | — | Unique name for the query |
| `fn` | [`QueryFn<TParams, TResult>`](#queryfntparams-tresult) | — | Async function `(ctx, params?) => Promise<TResult>` |

**Returns:** `void`

**Throws:** `QueryAlreadyDefinedError` — a query with the same name is already defined

**Example:**

```typescript
// Query without parameters
store.defineQuery('vipCustomers', async (ctx) => {
  return ctx.bucket('customers').where({ tier: 'vip' });
});

// Query with parameters
store.defineQuery('customerOrders', async (ctx, params: { customerId: string }) => {
  return ctx.bucket('orders').where({ customerId: params.customerId });
});
```

---

### Subscribing to Queries

---

### `store.subscribe(queryName, callback): Promise<() => void>`

Subscribes to a reactive query without parameters. The query is evaluated immediately during the subscribe call to establish the initial result and dependency set. The callback is **not** invoked on the initial subscribe — it fires only on subsequent re-evaluations that produce a structurally different result.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `queryName` | `string` | — | Name of a defined query |
| `callback` | `(result: TResult) => void` | — | Called when the query result changes |

**Returns:** `Promise<() => void>` — unsubscribe function (idempotent, safe to call multiple times)

**Throws:** `QueryNotDefinedError` — the query has not been defined

### `store.subscribe(queryName, params, callback): Promise<() => void>`

Subscribes to a reactive query with parameters. Each unique set of parameters creates an independent subscription with its own dependency tracking and result comparison.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `queryName` | `string` | — | Name of a defined query |
| `params` | `TParams` | — | Parameters passed to the query function |
| `callback` | `(result: TResult) => void` | — | Called when the query result changes |

**Returns:** `Promise<() => void>` — unsubscribe function

**Example:**

```typescript
// Without params
const unsub = await store.subscribe('vipCustomers', (vips) => {
  console.log('VIP customers changed:', vips.length);
});

// With params — each param set is independent
const unsubAlice = await store.subscribe(
  'customerOrders',
  { customerId: 'alice-1' },
  (orders) => console.log('Alice orders:', orders.length),
);

const unsubBob = await store.subscribe(
  'customerOrders',
  { customerId: 'bob-1' },
  (orders) => console.log('Bob orders:', orders.length),
);

// Stop listening
unsub();
unsubAlice();
unsubBob();
```

---

### `store.runQuery(queryName, params?): Promise<TResult>`

Executes a query once and returns the result. Does not create a subscription and does not track dependencies — purely a one-shot execution.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `queryName` | `string` | — | Name of a defined query |
| `params` | `unknown` | `undefined` | Optional parameters passed to the query function |

**Returns:** `Promise<TResult>` — the query result

**Throws:** `QueryNotDefinedError` — the query has not been defined

**Example:**

```typescript
const vips = await store.runQuery<StoreRecord[]>('vipCustomers');

const orders = await store.runQuery<StoreRecord[]>(
  'customerOrders',
  { customerId: 'alice-1' },
);
```

---

### `store.settle(): Promise<void>`

Waits for all pending reactive query re-evaluations to complete. Essential in tests and sequential flows to ensure all subscriber callbacks have fired after a mutation.

**Parameters:** none

**Returns:** `Promise<void>`

**Example:**

```typescript
await store.bucket('customers').insert({ name: 'Charlie', tier: 'vip' });
await store.settle(); // all reactive queries have been re-evaluated
```

---

## QueryContext

### `ctx.bucket(name): QueryBucket`

Returns a read-only [`QueryBucket`](#querybucket) for the named bucket. Dependencies are tracked at the **method-call level**, not at the bucket-access level — calling `ctx.bucket('users')` alone does not create any dependency. You must call a read method on the returned `QueryBucket` for the dependency to be registered.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | — | Name of a defined bucket |

**Returns:** [`QueryBucket`](#querybucket) — read-only bucket interface with dependency tracking

**Example:**

```typescript
store.defineQuery('summary', async (ctx) => {
  const users = ctx.bucket('users');    // no dependency yet
  const all = await users.all();        // bucket-level dependency on 'users'
  return { total: all.length };
});
```

---

## QueryBucket

Read-only bucket interface available inside query functions. Exposes the same read operations as [`BucketHandle`](./bucket-handle.md) but without any mutation methods. Each method call registers a dependency that determines when the query will be re-evaluated.

### Dependency Levels

Methods on `QueryBucket` register dependencies at two distinct levels:

| Level | Methods | Re-evaluation trigger |
|-------|---------|----------------------|
| **Record-level** | `get` | Only when the specific key changes |
| **Bucket-level** | `all`, `where`, `findOne`, `count`, `first`, `last`, `paginate`, `sum`, `avg`, `min`, `max` | When **any** record in the bucket changes |

---

### `bucket.get(key): Promise<StoreRecord | undefined>`

Reads a single record by primary key. Registers a **record-level** dependency — re-evaluation triggers only when this specific key is inserted, updated, or deleted.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | `unknown` | — | Primary key of the record |

**Returns:** `Promise<StoreRecord | undefined>` — the record, or `undefined` if not found

---

### `bucket.all(): Promise<StoreRecord[]>`

Returns all records in the bucket. Registers a **bucket-level** dependency.

---

### `bucket.where(filter): Promise<StoreRecord[]>`

Returns records matching the filter (AND logic across properties). Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | `Record<string, unknown>` | — | Key-value pairs that records must match |

---

### `bucket.findOne(filter): Promise<StoreRecord | undefined>`

Returns the first record matching the filter. Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | `Record<string, unknown>` | — | Key-value pairs to match |

---

### `bucket.count(filter?): Promise<number>`

Returns the number of matching records (or all records if no filter). Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter |

---

### `bucket.first(n): Promise<StoreRecord[]>`

Returns the first N records (ordered set buckets). Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `n` | `number` | — | Number of records to return |

---

### `bucket.last(n): Promise<StoreRecord[]>`

Returns the last N records (ordered set buckets). Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `n` | `number` | — | Number of records to return |

---

### `bucket.paginate(options): Promise<PaginatedResult>`

Cursor-based pagination. Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `options` | [`PaginateOptions`](./bucket-handle.md#paginateoptions) | — | Pagination cursor and limit |

---

### `bucket.sum(field, filter?): Promise<number>`

Sum of a numeric field. Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `field` | `string` | — | Name of the numeric field |
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter |

---

### `bucket.avg(field, filter?): Promise<number>`

Average of a numeric field. Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `field` | `string` | — | Name of the numeric field |
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter |

---

### `bucket.min(field, filter?): Promise<number | undefined>`

Minimum value of a numeric field. Returns `undefined` if no matching records. Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `field` | `string` | — | Name of the numeric field |
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter |

---

### `bucket.max(field, filter?): Promise<number | undefined>`

Maximum value of a numeric field. Returns `undefined` if no matching records. Registers a **bucket-level** dependency.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `field` | `string` | — | Name of the numeric field |
| `filter` | `Record<string, unknown>` | `undefined` | Optional filter |

---

## Dependency Tracking

Reactive queries use a **two-level dependency model** to minimize unnecessary re-evaluations.

### How It Works

1. When a query function executes, each read method call on a `QueryBucket` records a dependency.
2. When a bucket change occurs (insert, update, delete), the query manager checks which subscriptions depend on that bucket and key.
3. Affected subscriptions are re-evaluated asynchronously.
4. After re-evaluation, the new result is compared to the previous one using deep equality. The callback fires **only** if the result actually changed.

### Record-Level Dependencies

Only `get(key)` creates record-level dependencies. The query is re-evaluated only when the specific key it accessed is modified.

```typescript
store.defineQuery('singleUser', async (ctx, params: { id: string }) => {
  return ctx.bucket('users').get(params.id);
});

const unsub = await store.subscribe('singleUser', { id: 'u1' }, (user) => {
  console.log('User u1 changed:', user);
});

// This triggers re-evaluation — key 'u1' was accessed
await store.bucket('users').update('u1', { name: 'Updated' });
await store.settle();

// This does NOT trigger re-evaluation — key 'u2' was not accessed
await store.bucket('users').update('u2', { name: 'Other' });
await store.settle();
```

### Bucket-Level Dependencies

All other read methods (`where`, `all`, `findOne`, `count`, `first`, `last`, `paginate`, `sum`, `avg`, `min`, `max`) create bucket-level dependencies. Any change in the bucket triggers re-evaluation.

```typescript
store.defineQuery('orderTotal', async (ctx) => {
  return ctx.bucket('orders').sum('amount');
});

// Any insert/update/delete in 'orders' triggers re-evaluation
await store.bucket('orders').insert({ amount: 50, product: 'Widget' });
await store.settle();
```

### Mixed Dependencies

A single query can have both record-level and bucket-level dependencies, even on the same bucket. If a bucket appears at both levels, the bucket-level dependency takes precedence (any change triggers re-evaluation).

```typescript
store.defineQuery('customerWithOrders', async (ctx, params: { id: string }) => {
  // Record-level: only changes to this specific customer
  const customer = await ctx.bucket('customers').get(params.id);
  // Bucket-level: any change in orders
  const orders = await ctx.bucket('orders').where({ customerId: params.id });
  return { customer, orders };
});
```

Dependencies for this query:
- `customers` — record-level (only the specific `id`)
- `orders` — bucket-level (any change)

### Dynamic Dependencies

Dependencies are re-computed on every evaluation. If a query conditionally reads from a bucket, the dependency set can change between evaluations.

```typescript
store.defineQuery('conditionalOrders', async (ctx) => {
  const vips = await ctx.bucket('customers').where({ tier: 'vip' });
  if (vips.length > 0) {
    return ctx.bucket('orders').all(); // only accessed when VIPs exist
  }
  return [];
});
```

- When no VIPs exist: depends only on `customers` (bucket-level)
- After a VIP is added: depends on both `customers` and `orders` (both bucket-level)
- If all VIPs are removed: back to depending only on `customers`

The dependency index is automatically updated after each re-evaluation.

---

## Deep Equality

Subscriber callbacks fire only when the query result has **structurally changed**. Two results are considered equal if they have the same shape and values, checked recursively:

| Type | Comparison |
|------|------------|
| Primitives | `===` (strict equality) |
| `NaN` | `NaN === NaN` (treated as equal) |
| `Date` | `.getTime()` comparison |
| `RegExp` | `.source` and `.flags` comparison |
| Arrays | Length + element-wise recursive comparison |
| Plain objects | Key count + value-wise recursive comparison |

This prevents unnecessary callback invocations when a query re-evaluates but produces the same result — for example, a `count()` that returns `5` before and after an unrelated update in the same bucket.

---

## Error Resilience

If a query function throws during re-evaluation, the subscription remains alive and the callback is skipped. The next bucket change will trigger another re-evaluation attempt, allowing the query to recover from transient errors.

```typescript
let failOnce = true;

store.defineQuery('resilient', async (ctx) => {
  if (failOnce) {
    failOnce = false;
    throw new Error('Transient failure');
  }
  return ctx.bucket('data').all();
});

const unsub = await store.subscribe('resilient', (data) => {
  // This callback will be skipped during the failed evaluation,
  // but will fire when the query succeeds on a subsequent change.
  console.log('Data:', data);
});
```

---

## Unsubscribe Behavior

The unsubscribe function returned by `store.subscribe()` is **idempotent** — calling it multiple times is safe and has no additional effect. Upon first call it:

1. Removes the subscription from the internal registry
2. Removes all dependency index entries for that subscription
3. Prevents any further callback invocations, even if a re-evaluation is in progress

```typescript
const unsub = await store.subscribe('vipCustomers', (vips) => {
  console.log(vips);
});

unsub(); // removes subscription and cleans up
unsub(); // safe no-op
```

---

## Types

### `QueryFn<TParams, TResult>`

Query function signature. A pure async function that reads from buckets via `QueryContext`.

```typescript
type QueryFn<TParams = void, TResult = unknown> =
  TParams extends void
    ? (ctx: QueryContext) => Promise<TResult>
    : (ctx: QueryContext, params: TParams) => Promise<TResult>;
```

When `TParams` is `void` (the default), the function accepts only `ctx`. When `TParams` is specified, the function requires a second `params` argument.

---

### `QueryContext`

Execution context passed to query functions. Provides read-only access to buckets with automatic dependency tracking.

```typescript
interface QueryContext {
  bucket(name: string): QueryBucket;
}
```

---

### `QueryBucket`

Read-only bucket interface available inside query functions. Exposes all read operations from [`BucketHandle`](./bucket-handle.md) without any mutation methods.

```typescript
interface QueryBucket {
  get(key: unknown): Promise<StoreRecord | undefined>;
  all(): Promise<StoreRecord[]>;
  where(filter: Record<string, unknown>): Promise<StoreRecord[]>;
  findOne(filter: Record<string, unknown>): Promise<StoreRecord | undefined>;
  count(filter?: Record<string, unknown>): Promise<number>;
  first(n: number): Promise<StoreRecord[]>;
  last(n: number): Promise<StoreRecord[]>;
  paginate(options: PaginateOptions): Promise<PaginatedResult>;
  sum(field: string, filter?: Record<string, unknown>): Promise<number>;
  avg(field: string, filter?: Record<string, unknown>): Promise<number>;
  min(field: string, filter?: Record<string, unknown>): Promise<number | undefined>;
  max(field: string, filter?: Record<string, unknown>): Promise<number | undefined>;
}
```

---

### `QueryDependencies`

Structure representing the dependencies collected during a query execution.

```typescript
interface QueryDependencies {
  /** Buckets with bucket-level dependencies — any change triggers re-evaluation. */
  readonly bucketLevel: ReadonlySet<string>;
  /** Buckets with record-level dependencies — only specific key changes trigger re-evaluation.
   *  Map<bucketName, Set<primaryKey>> */
  readonly recordLevel: ReadonlyMap<string, ReadonlySet<unknown>>;
}
```

---

### `QueryAlreadyDefinedError`

Thrown when attempting to define a query with a name that is already registered.

```typescript
class QueryAlreadyDefinedError extends Error {
  readonly query: string; // the duplicate query name
}
```

---

### `QueryNotDefinedError`

Thrown when attempting to subscribe to or run a query that has not been defined.

```typescript
class QueryNotDefinedError extends Error {
  readonly query: string; // the missing query name
}
```

## See Also

- [Store API](./store.md) — `defineQuery()`, `subscribe()`, `runQuery()`, and `settle()` on the store instance
- [BucketHandle API](./bucket-handle.md) — full CRUD and read operations that `QueryBucket` mirrors (read-only subset)
- [Errors](./errors.md) — complete catalog of error classes including `QueryAlreadyDefinedError` and `QueryNotDefinedError`
- **Learn:** [What Are Reactive Queries](../learn/05-reactive-queries/01-what-are-reactive-queries.md) — conceptual introduction to reactive queries
- **Learn:** [Defining and Subscribing](../learn/05-reactive-queries/02-defining-and-subscribing.md) — step-by-step tutorial
- **Learn:** [Dependency Tracking](../learn/05-reactive-queries/03-dependency-tracking.md) — deep dive into how dependencies work
- **Source:** [`src/reactive/query-manager.ts`](../../src/reactive/query-manager.ts)
- **Source:** [`src/reactive/query-context.ts`](../../src/reactive/query-context.ts)
- **Source:** [`src/types/query.ts`](../../src/types/query.ts)
