# Using Transactions

You understand why transactions exist. Now you need to use them. The API is small — `store.transaction()` gives you a callback with a transaction context, and `tx.bucket()` returns handles that look like regular bucket handles but buffer writes locally. Reads see your buffered writes immediately (read-your-own-writes), and everything commits atomically when the callback returns.

This chapter covers the full transaction API: writing, reading, returning values, error handling, and the rules that govern what you can do inside a transaction.

## What You'll Learn

- How `store.transaction()` creates and commits a transaction
- How `tx.bucket()` provides transactional bucket handles
- How write operations (insert, update, delete) are buffered
- How read operations see buffered writes (read-your-own-writes)
- How to return values from transactions
- What happens when the callback throws

## Setup

All examples in this chapter use the following store:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'transactions-demo' });

await store.defineBucket('customers', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', required: true, format: 'email' },
    tier:  { type: 'string', enum: ['basic', 'premium', 'vip'], default: 'basic' },
  },
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    customerId: { type: 'string', required: true },
    total:      { type: 'number', required: true, min: 0 },
    status:     { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
  },
  indexes: ['customerId', 'status'],
});

await store.defineBucket('loyaltyPoints', {
  key: 'customerId',
  schema: {
    customerId: { type: 'string', required: true },
    points:     { type: 'number', required: true, min: 0 },
  },
});

const customers = store.bucket('customers');
const orders = store.bucket('orders');
const loyaltyPoints = store.bucket('loyaltyPoints');
```

## The Transaction Lifecycle

```text
  store.transaction(async (tx) => { ... })
      |
      v
  1. Create TransactionContext
      |
      v
  2. Execute user callback
     - tx.bucket('name') -> TransactionBucketHandle
     - handle.insert/update/delete -> buffered locally
     - handle.get/all/where -> reads overlay + real store
      |
      v
  3. Callback returns
      |
      v
  4. Commit: apply all buffered writes atomically
      |
      v
  5. Publish events (only after all buckets succeed)
      |
      v
  6. Return result to caller
```

## Getting Bucket Handles

Inside a transaction, you access buckets through `tx.bucket()` instead of `store.bucket()`. The transaction handle buffers writes and overlays them on reads:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const txOrders = await tx.bucket('orders');

  // txCustomers and txOrders are TransactionBucketHandle instances.
  // They have the same read/write API as regular BucketHandle,
  // but all writes are buffered until commit.
});
```

Key differences from regular `store.bucket()`:

| Aspect | `store.bucket()` | `tx.bucket()` |
|--------|-------------------|---------------|
| Returns | `BucketHandle` | `TransactionBucketHandle` |
| Writes | Applied immediately | Buffered until commit |
| Reads | Always from real store | Overlay (buffer) + real store |
| Call style | Synchronous | `await` (async) |
| Caching | Handle is reusable across calls | Handle is cached within the transaction |

Calling `tx.bucket('customers')` twice returns the same handle — the transaction caches it on first access.

## Write Operations

All three write operations — `insert`, `update`, and `delete` — work identically to their `BucketHandle` counterparts, except writes are buffered:

### Insert

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  const customer = await txCustomers.insert({
    name: 'Alice',
    email: 'alice@example.com',
  });

  console.log(customer.id);        // Generated UUID
  console.log(customer._version);   // 1
  console.log(customer.tier);       // 'basic' (default)

  // The record is NOT in the real store yet.
  // It exists only in the transaction buffer.
});
// After the callback returns, commit applies the insert.
// Now the record is in the real store.
```

### Update

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  // Assume Alice was inserted in a previous operation
  await txCustomers.update(aliceId, { tier: 'premium' });

  // The update is buffered. The real store still shows tier: 'basic'.
});
// After commit, the real store shows tier: 'premium'.
```

Updating a record that doesn't exist throws an error:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  await txCustomers.update('nonexistent', { tier: 'vip' });
  // Error: Record with key "nonexistent" not found in bucket "customers"
});
```

### Delete

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  await txCustomers.delete(aliceId);

  // Buffered. Alice is still in the real store.
});
// After commit, Alice is gone from the real store.
```

Deleting a record that doesn't exist is a no-op — it doesn't throw:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  await txCustomers.delete('nonexistent'); // No error
});
```

## Read-Your-Own-Writes

The defining feature of transaction reads: they see your buffered writes. When you read inside a transaction, the handle checks the buffer first and falls through to the real store only for unbuffered records.

### How the Overlay Works

```text
  txCustomers.get(key)
      |
      v
  Check buffer:
  +----------------------------+
  | Deleted in this tx?        |  --> return undefined
  | Inserted/updated in tx?    |  --> return buffered record
  | Not in buffer?             |  --> query real BucketServer
  +----------------------------+
```

### get()

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  // Insert a new customer (buffered)
  const alice = await txCustomers.insert({
    name: 'Alice',
    email: 'alice@example.com',
  });

  // Read it back — returns the buffered record
  const found = await txCustomers.get(alice.id);
  console.log(found?.name); // 'Alice'

  // Update it (buffered)
  await txCustomers.update(alice.id, { tier: 'premium' });

  // Read again — returns the updated buffered record
  const updated = await txCustomers.get(alice.id);
  console.log(updated?.tier); // 'premium'

  // Delete it (buffered)
  await txCustomers.delete(alice.id);

  // Read again — returns undefined (deleted in this tx)
  const deleted = await txCustomers.get(alice.id);
  console.log(deleted); // undefined
});
```

### all()

`all()` merges the real store with the buffer: it removes deleted records, replaces updated records, and appends inserted records:

```typescript
// Pre-existing records in the store
await customers.insert({ id: 'c1', name: 'Bob', email: 'bob@example.com' });
await customers.insert({ id: 'c2', name: 'Carol', email: 'carol@example.com' });

await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  await txCustomers.insert({ name: 'Dave', email: 'dave@example.com' });
  await txCustomers.update('c1', { tier: 'vip' });
  await txCustomers.delete('c2');

  const all = await txCustomers.all();
  // Contains:
  //   Bob (updated to vip) — overlay replaces real record
  //   Dave — inserted in buffer, appended to results
  //   Carol is NOT included — deleted in buffer
  console.log(all.length); // 2
});
```

### where(), findOne(), count()

These methods build on top of `all()` with overlay applied:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  await txCustomers.insert({ name: 'Eve', email: 'eve@example.com', tier: 'premium' });

  // where() sees the buffered insert
  const premiums = await txCustomers.where({ tier: 'premium' });
  console.log(premiums.length); // Includes Eve

  // findOne() sees the buffered insert
  const eve = await txCustomers.findOne({ name: 'Eve' });
  console.log(eve?.email); // 'eve@example.com'

  // count() sees the buffered insert
  const total = await txCustomers.count();
  console.log(total); // Includes Eve in the count
});
```

## Returning Values

`store.transaction()` returns whatever the callback returns:

```typescript
const customerId = await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const txPoints = await tx.bucket('loyaltyPoints');

  const customer = await txCustomers.insert({
    name: 'Frank',
    email: 'frank@example.com',
  });

  await txPoints.insert({
    customerId: customer.id,
    points: 100,
  });

  return customer.id;
});

console.log(customerId); // The UUID generated inside the transaction
```

The return type is inferred from the callback:

```typescript
// TypeScript infers: Promise<{ customerId: string; orderId: number }>
const result = await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const txOrders = await tx.bucket('orders');

  const customer = await txCustomers.insert({
    name: 'Grace',
    email: 'grace@example.com',
  });

  const order = await txOrders.insert({
    customerId: customer.id as string,
    total: 99.99,
  });

  return {
    customerId: customer.id as string,
    orderId: order.id as number,
  };
});
```

## Error Handling

### Callback Throws — No Writes Applied

If your callback throws an error, the transaction never commits. The buffer is discarded and the store remains unchanged:

```typescript
try {
  await store.transaction(async (tx) => {
    const txCustomers = await tx.bucket('customers');

    await txCustomers.insert({
      name: 'Hank',
      email: 'hank@example.com',
    });

    // Business logic error
    throw new Error('Something went wrong');
  });
} catch (err) {
  console.log(err.message); // 'Something went wrong'
}

// Hank was never inserted — the buffer was discarded
const hank = await customers.findOne({ name: 'Hank' });
console.log(hank); // undefined
```

```text
  Transaction callback
  +------------------------------------+
  |                                    |
  |  insert(Hank)  -> buffered         |
  |                                    |
  |  throw Error   -> callback exits   |
  |                                    |
  +------------------------------------+
      |
      v
  commit() never called
  Buffer discarded
  Store unchanged
```

### Undefined Bucket

Requesting a bucket that hasn't been defined throws immediately:

```typescript
await store.transaction(async (tx) => {
  await tx.bucket('nonexistent');
  // Error: Bucket "nonexistent" is not defined
});
```

## Multi-Bucket Transactions

The real power of transactions is coordinating writes across multiple buckets:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const txOrders = await tx.bucket('orders');
  const txPoints = await tx.bucket('loyaltyPoints');

  // Create customer
  const customer = await txCustomers.insert({
    name: 'Iris',
    email: 'iris@example.com',
    tier: 'premium',
  });

  // Create order linked to customer
  const order = await txOrders.insert({
    customerId: customer.id as string,
    total: 500,
  });

  // Initialize loyalty points
  await txPoints.insert({
    customerId: customer.id as string,
    points: Math.floor((order.total as number) * 0.1), // 10% of order total
  });
});

// All three records exist, or none of them do.
```

If the loyalty points insert fails (e.g., validation error), neither the customer nor the order is created. The store handles the rollback automatically.

## Empty Transactions

A transaction with no writes is a no-op — it commits instantly without touching any bucket:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const all = await txCustomers.all();
  // Read-only — no writes buffered
  console.log(`Found ${all.length} customers`);
});
// No commit sent to any bucket. No events published.
```

This is safe but unnecessary — if you only need reads, use regular `store.bucket()` handles instead.

## Complete Working Example

An order processing system that creates a customer, places an order, and awards loyalty points atomically:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'tx-example' });

  await store.defineBucket('customers', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true, format: 'email' },
      tier:  { type: 'string', enum: ['basic', 'premium', 'vip'], default: 'basic' },
    },
  });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:         { type: 'number', generated: 'autoincrement' },
      customerId: { type: 'string', required: true },
      total:      { type: 'number', required: true, min: 0 },
      status:     { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
    },
    indexes: ['customerId', 'status'],
  });

  await store.defineBucket('loyaltyPoints', {
    key: 'customerId',
    schema: {
      customerId: { type: 'string', required: true },
      points:     { type: 'number', required: true, min: 0 },
    },
  });

  const customers = store.bucket('customers');
  const ordersBucket = store.bucket('orders');
  const points = store.bucket('loyaltyPoints');

  // --- Atomic order processing ---

  const result = await store.transaction(async (tx) => {
    const txCustomers = await tx.bucket('customers');
    const txOrders = await tx.bucket('orders');
    const txPoints = await tx.bucket('loyaltyPoints');

    // 1. Create customer
    const customer = await txCustomers.insert({
      name: 'Alice',
      email: 'alice@example.com',
      tier: 'premium',
    });
    console.log(`Created customer: ${customer.name} (${customer.id})`);

    // 2. Place order
    const order = await txOrders.insert({
      customerId: customer.id as string,
      total: 250,
    });
    console.log(`Created order #${order.id}: $${order.total}`);

    // 3. Award loyalty points (10% of order total)
    const earned = Math.floor((order.total as number) * 0.1);
    await txPoints.insert({
      customerId: customer.id as string,
      points: earned,
    });
    console.log(`Awarded ${earned} loyalty points`);

    // 4. Read back within the transaction (read-your-own-writes)
    const customerOrders = await txOrders.where({
      customerId: customer.id as string,
    });
    console.log(`Customer has ${customerOrders.length} order(s) in this tx`);

    return { customerId: customer.id as string, orderId: order.id as number };
  });

  console.log(`\nTransaction committed:`);
  console.log(`  Customer: ${result.customerId}`);
  console.log(`  Order: #${result.orderId}`);

  // --- Verify from outside the transaction ---

  const customer = await customers.get(result.customerId);
  console.log(`\nVerification:`);
  console.log(`  Customer: ${customer?.name} (${customer?.tier})`);

  const customerOrders = await ordersBucket.where({
    customerId: result.customerId,
  });
  console.log(`  Orders: ${customerOrders.length}`);

  const customerPoints = await points.get(result.customerId);
  console.log(`  Points: ${customerPoints?.points}`);

  // --- Failed transaction — nothing written ---

  try {
    await store.transaction(async (tx) => {
      const txOrders = await tx.bucket('orders');

      await txOrders.insert({
        customerId: result.customerId,
        total: 1000,
      });

      throw new Error('Payment declined');
    });
  } catch (err) {
    console.log(`\nTransaction failed: ${(err as Error).message}`);
  }

  // Order count unchanged
  const ordersAfter = await ordersBucket.where({
    customerId: result.customerId,
  });
  console.log(`Orders after failed tx: ${ordersAfter.length}`); // Still 1

  await store.stop();
}

main();
```

## Exercise

Given the following store:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('products', {
  key: 'sku',
  schema: {
    sku:   { type: 'string', required: true },
    name:  { type: 'string', required: true },
    stock: { type: 'number', required: true, min: 0 },
    price: { type: 'number', required: true, min: 0 },
  },
});

await store.defineBucket('cart', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    sku:      { type: 'string', required: true },
    quantity: { type: 'number', required: true, min: 1 },
    userId:   { type: 'string', required: true },
  },
  indexes: ['userId', 'sku'],
});

const products = store.bucket('products');
const cart = store.bucket('cart');

await products.insert({ sku: 'LAPTOP', name: 'Laptop', stock: 5, price: 999 });
await products.insert({ sku: 'MOUSE', name: 'Mouse', stock: 20, price: 29 });
```

Write a function `addToCart(userId: string, sku: string, quantity: number)` that:

1. Uses a transaction to atomically deduct stock and add a cart item
2. Reads the product inside the transaction to check stock
3. Throws an error if there isn't enough stock (without modifying anything)
4. Returns the created cart item
5. After the transaction, verify the stock was deducted by reading from outside

<details>
<summary>Solution</summary>

```typescript
async function addToCart(userId: string, sku: string, quantity: number) {
  return await store.transaction(async (tx) => {
    const txProducts = await tx.bucket('products');
    const txCart = await tx.bucket('cart');

    // 1. Read product (from real store, since we haven't buffered it)
    const product = await txProducts.get(sku);
    if (product === undefined) {
      throw new Error(`Product ${sku} not found`);
    }

    // 2. Check stock
    const currentStock = product.stock as number;
    if (currentStock < quantity) {
      throw new Error(
        `Insufficient stock for ${product.name}: requested ${quantity}, available ${currentStock}`,
      );
    }

    // 3. Deduct stock (buffered)
    await txProducts.update(sku, { stock: currentStock - quantity });

    // 4. Add cart item (buffered)
    const cartItem = await txCart.insert({ sku, quantity, userId });

    // 5. Verify within tx (read-your-own-writes)
    const updatedProduct = await txProducts.get(sku);
    console.log(`Stock after deduction (in tx): ${updatedProduct?.stock}`);

    return cartItem;
  });
}

// Test it
const item = await addToCart('user-1', 'LAPTOP', 2);
console.log(`Cart item #${item.id}: ${item.quantity}x ${item.sku}`);

// Verify outside the transaction
const laptop = await products.get('LAPTOP');
console.log(`Laptop stock: ${laptop?.stock}`); // 3

// Try to buy more than available
try {
  await addToCart('user-2', 'LAPTOP', 10);
} catch (err) {
  console.log((err as Error).message);
  // Insufficient stock for Laptop: requested 10, available 3
}

// Stock unchanged after failed transaction
const laptopAfter = await products.get('LAPTOP');
console.log(`Laptop stock (unchanged): ${laptopAfter?.stock}`); // Still 3
```

</details>

## Summary

- **`store.transaction(fn)`** creates a transaction, executes the callback, and commits atomically when the callback returns
- **`tx.bucket(name)`** returns a `TransactionBucketHandle` — same API as `BucketHandle` but writes are buffered
- **Insert, update, and delete** are buffered locally — no writes reach the store until commit
- **Read-your-own-writes**: `get()`, `all()`, `where()`, `findOne()`, and `count()` check the buffer first, then fall through to the real store
- The transaction **returns whatever the callback returns** — TypeScript infers the type automatically
- If the callback **throws**, the buffer is discarded and no writes are applied
- **Multi-bucket transactions** coordinate writes across any number of buckets atomically
- **Empty transactions** (no writes) are a no-op — use regular bucket handles for read-only work
- `tx.bucket()` is async and cached — calling it twice with the same name returns the same handle

---

Next: [Optimistic Locking](./03-optimistic-locking.md)
