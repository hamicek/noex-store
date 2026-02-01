# Why Transactions?

Your e-commerce store processes an order: deduct inventory from the `products` bucket, create a record in `orders`, and credit loyalty points in `accounts`. The first two operations succeed, but the third fails — a validation error on the points field. Now you have an order without loyalty points, and the inventory is already gone. Rolling back manually means writing compensating logic at every call site, and one missed edge case means corrupted data.

noex-store transactions wrap multiple bucket operations into an atomic unit. Either everything commits or nothing does. The store handles buffering, validation, conflict detection, and rollback automatically.

## What You'll Learn

- Why individual bucket operations can leave your data in an inconsistent state
- How manual error handling fails to guarantee consistency
- What atomicity means in the context of cross-bucket writes
- When to use transactions and when they're unnecessary
- How noex-store transactions differ from traditional database transactions

## The Problem: Non-Atomic Cross-Bucket Writes

Consider a simple funds transfer between two accounts:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'transfer-demo' });

await store.defineBucket('accounts', {
  key: 'id',
  schema: {
    id:      { type: 'string', required: true },
    owner:   { type: 'string', required: true },
    balance: { type: 'number', required: true, min: 0 },
  },
});

const accounts = store.bucket('accounts');

await accounts.insert({ id: 'alice', owner: 'Alice', balance: 1000 });
await accounts.insert({ id: 'bob', owner: 'Bob', balance: 500 });
```

### Attempt 1: Sequential Operations

The simplest approach — debit one account, credit the other:

```typescript
// Transfer $200 from Alice to Bob
const alice = await accounts.get('alice');
const bob = await accounts.get('bob');

await accounts.update('alice', { balance: (alice!.balance as number) - 200 });
// Alice: $800 ✓

await accounts.update('bob', { balance: (bob!.balance as number) + 200 });
// Bob: $700 ✓
```

This works when nothing goes wrong. But what if the second update fails?

```typescript
await accounts.update('alice', { balance: (alice!.balance as number) - 200 });
// Alice: $800 — money deducted

await accounts.update('bob', { balance: (bob!.balance as number) + 99999 });
// Fails: balance exceeds some limit or validation fails
// Bob: $500 — unchanged

// Result: $200 vanished. Alice lost money, Bob gained nothing.
```

### Attempt 2: Manual Try/Catch

Wrap the operations in a try/catch and undo on failure:

```typescript
const aliceBefore = await accounts.get('alice');

await accounts.update('alice', { balance: (aliceBefore!.balance as number) - 200 });

try {
  await accounts.update('bob', { balance: (bob!.balance as number) + 200 });
} catch (err) {
  // Undo Alice's deduction
  await accounts.update('alice', { balance: aliceBefore!.balance });
  throw err;
}
```

Better, but fragile:

| Problem | What Goes Wrong |
|---------|-----------------|
| Race condition | Another operation modifies Alice's balance between the debit and the rollback, and the undo overwrites it |
| Missed rollback | A new bucket is added to the transfer logic but the catch block isn't updated |
| Partial visibility | Other parts of the system see Alice's deducted balance before Bob is credited — a window of inconsistency |
| Error in rollback | The undo operation itself can fail, leaving data permanently inconsistent |

### Attempt 3: Transactions

With a transaction, the store buffers all writes and applies them atomically:

```typescript
await store.transaction(async (tx) => {
  const txAccounts = await tx.bucket('accounts');

  const alice = await txAccounts.get('alice');
  const bob = await txAccounts.get('bob');

  await txAccounts.update('alice', { balance: (alice!.balance as number) - 200 });
  await txAccounts.update('bob', { balance: (bob!.balance as number) + 200 });
});
// Both updates succeed atomically, or neither is applied.
```

No writes reach the store until the transaction commits. If any operation fails, the buffer is discarded and the store remains unchanged.

## What Transactions Guarantee

```text
  Without Transactions              With Transactions
  +-----------------------+         +-----------------------+
  |                       |         |                       |
  |  update(alice, -200)  |         |  buffer(alice, -200)  |
  |     |                 |         |     |                 |
  |     v  (written)      |         |     v  (buffered)     |
  |                       |         |                       |
  |  update(bob, +200)    |         |  buffer(bob, +200)    |
  |     |                 |         |     |                 |
  |     x  (fails!)       |         |     v  (buffered)     |
  |                       |         |                       |
  |  Alice: $800 (wrong)  |         |  commit() — atomic    |
  |  Bob:   $500 (wrong)  |         |     |                 |
  |                       |         |     v                 |
  |  Inconsistent state   |         |  Alice: $800          |
  |                       |         |  Bob:   $700          |
  +-----------------------+         |                       |
                                    |  Consistent state     |
                                    +-----------------------+
```

| Property | Guarantee |
|----------|-----------|
| **Atomicity** | All writes succeed together or none are applied |
| **Buffered writes** | No mutations are visible until commit |
| **Automatic rollback** | If the callback throws or commit fails, all changes are discarded |
| **Cross-bucket** | A single transaction can span multiple buckets |
| **Conflict detection** | Version-based optimistic locking detects concurrent modifications |

## When to Use Transactions

**Use transactions when:**

- An operation spans multiple buckets that must stay consistent (e.g., transfer funds, create order + deduct inventory)
- You need to read a value from one bucket and write a derived value to another in the same atomic unit
- Multiple records must be updated together or not at all
- You want to prevent other operations from seeing intermediate states

**Skip transactions when:**

- You're operating on a single record in a single bucket — individual operations are already atomic
- The operations are independent and don't need to be consistent with each other
- You're only reading data — transactions add overhead for read-only work

## How noex-store Transactions Differ

noex-store transactions are not traditional ACID database transactions. Here's what to expect:

| Aspect | noex-store | Traditional DB |
|--------|-----------|---------------|
| **Storage** | In-memory | Disk-based |
| **Isolation** | Read-committed with optimistic locking | Configurable (READ_COMMITTED, SERIALIZABLE, etc.) |
| **Concurrency** | Optimistic — conflicts detected at commit time | Pessimistic locks or MVCC |
| **Durability** | Only with persistence adapter enabled | Write-ahead log, guaranteed |
| **Scope** | Cross-bucket within a single store | Cross-table, sometimes cross-database |

The key insight: noex-store uses **optimistic concurrency control**. Transactions don't lock any data. Instead, they record which versions of records were read, and at commit time, the store checks that those records haven't been modified by someone else. If they have, the transaction fails with a `TransactionConflictError`.

## Exercise

Consider the following scenario:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('inventory', {
  key: 'sku',
  schema: {
    sku:   { type: 'string', required: true },
    name:  { type: 'string', required: true },
    stock: { type: 'number', required: true, min: 0 },
  },
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    sku:      { type: 'string', required: true },
    quantity: { type: 'number', required: true, min: 1 },
  },
});

const inventory = store.bucket('inventory');
const ordersBucket = store.bucket('orders');

await inventory.insert({ sku: 'WIDGET-1', name: 'Widget', stock: 10 });
```

1. What happens if you call `inventory.update('WIDGET-1', { stock: 5 })` followed by `ordersBucket.insert({ sku: 'WIDGET-1', quantity: 5 })`, and the second operation fails?
2. How would you wrap these two operations in a transaction?
3. What guarantee does the transaction provide that the sequential version doesn't?
4. If another part of the system updates the widget's stock between your transaction's read and commit, what happens?

<details>
<summary>Solution</summary>

1. The inventory would show `stock: 5` but no order would exist — the inventory was deducted without a corresponding order. The data is inconsistent.

2. Wrap both operations in `store.transaction()`:

```typescript
await store.transaction(async (tx) => {
  const txInventory = await tx.bucket('inventory');
  const txOrders = await tx.bucket('orders');

  const widget = await txInventory.get('WIDGET-1');
  const currentStock = widget!.stock as number;

  if (currentStock < 5) {
    throw new Error('Insufficient stock');
  }

  await txInventory.update('WIDGET-1', { stock: currentStock - 5 });
  await txOrders.insert({ sku: 'WIDGET-1', quantity: 5 });
});
```

3. The transaction guarantees that either both the stock deduction and the order creation happen, or neither does. If the order insert fails (e.g., validation error), the stock update is never applied. Outside observers never see the intermediate state where stock is deducted but no order exists.

4. The transaction detects the version mismatch at commit time and throws a `TransactionConflictError`. Neither the stock update nor the order creation is applied. You can catch this error and retry the transaction with fresh data.

</details>

## Summary

- Individual bucket operations are atomic, but **cross-bucket operations are not** — a failure between two operations leaves data inconsistent
- Manual try/catch rollback is fragile: it's vulnerable to race conditions, missed edge cases, and rollback failures
- **`store.transaction()`** wraps multiple operations into an atomic unit — all writes succeed together or none are applied
- Writes inside a transaction are **buffered locally** and only applied at commit time
- If the callback throws, the buffer is discarded and no writes reach the store
- noex-store uses **optimistic concurrency control** — no locks are held during the transaction, conflicts are detected at commit time
- Use transactions for cross-bucket consistency; skip them for single-record operations

---

Next: [Using Transactions](./02-using-transactions.md)
