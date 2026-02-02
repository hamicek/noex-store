# Optimistic Locking

Your transaction reads a product with `stock: 10`, deducts 3, and buffers `stock: 7`. Meanwhile, another operation updates the same product's stock to 5. When your transaction commits, it would overwrite the real stock of 5 with your stale calculation of 7 — silently corrupting data.

noex-store prevents this with optimistic locking. Every record carries a `_version` field that increments on each update. At commit time, the store checks that the versions you read still match the current versions. If they don't, the commit fails with a `TransactionConflictError` and all changes are rolled back.

## What You'll Learn

- How `_version` tracks record changes and enables conflict detection
- What happens during the two-phase commit process
- How `TransactionConflictError` reports conflicts
- How cross-bucket rollback keeps the store consistent
- How events interact with transaction commits and rollbacks
- How to implement retry logic for conflict recovery

## Setup

All examples in this chapter use the following store:

```typescript
import { Store, TransactionConflictError } from '@hamicek/noex-store';

const store = await Store.start({ name: 'locking-demo' });

await store.defineBucket('accounts', {
  key: 'id',
  schema: {
    id:      { type: 'string', required: true },
    owner:   { type: 'string', required: true },
    balance: { type: 'number', required: true, min: 0 },
  },
});

await store.defineBucket('transfers', {
  key: 'id',
  schema: {
    id:     { type: 'number', generated: 'autoincrement' },
    from:   { type: 'string', required: true },
    to:     { type: 'string', required: true },
    amount: { type: 'number', required: true, min: 1 },
  },
});

const accounts = store.bucket('accounts');
const transfers = store.bucket('transfers');

await accounts.insert({ id: 'alice', owner: 'Alice', balance: 1000 });
await accounts.insert({ id: 'bob', owner: 'Bob', balance: 500 });
```

## Version Tracking

Every record in noex-store has a `_version` field that starts at 1 and increments on each update:

```typescript
const alice = await accounts.get('alice');
console.log(alice?._version); // 1

await accounts.update('alice', { balance: 900 });
const aliceV2 = await accounts.get('alice');
console.log(aliceV2?._version); // 2

await accounts.update('alice', { balance: 800 });
const aliceV3 = await accounts.get('alice');
console.log(aliceV3?._version); // 3
```

The version is part of the record metadata alongside `_createdAt` and `_updatedAt`:

| Field | Type | Behavior |
|-------|------|----------|
| `_version` | `number` | Starts at 1, increments on each update |
| `_createdAt` | `number` | Unix millisecond timestamp, set once on insert |
| `_updatedAt` | `number` | Unix millisecond timestamp, updated on each write |

## How Conflict Detection Works

When you read a record inside a transaction and then update or delete it, the transaction records the version you read as the `expectedVersion`. At commit time, the BucketServer compares the expected version against the current version in the real store:

```text
  Transaction                              Real Store
  +-----------------------------------+    +-------------------+
  |                                   |    |                   |
  |  get('alice')                     | -> | alice._version: 1 |
  |    -> reads version 1             |    |                   |
  |                                   |    |                   |
  |  update('alice', { balance: 800 })|    |                   |
  |    -> buffers with                |    |                   |
  |       expectedVersion: 1          |    |                   |
  |                                   |    |                   |
  +-----------------------------------+    +-------------------+

  Commit:
    Expected version: 1
    Current version:  1   -> Match ✓ -> Apply update

  But if another operation updated Alice in between:

  Transaction                              Real Store
  +-----------------------------------+    +-------------------+
  |                                   |    |                   |
  |  get('alice')                     | -> | alice._version: 1 |
  |    -> reads version 1             |    |                   |
  |                                   |    | (external update) |
  |  update('alice', { balance: 800 })|    | alice._version: 2 |
  |    -> buffers with                |    |                   |
  |       expectedVersion: 1          |    |                   |
  |                                   |    |                   |
  +-----------------------------------+    +-------------------+

  Commit:
    Expected version: 1
    Current version:  2   -> Mismatch ✗ -> TransactionConflictError
```

## Two-Phase Commit

When a transaction commits, each bucket processes the operations in two phases:

### Phase 1: Validation

All operations are validated without mutating state:

- **Insert**: Check that the key doesn't already exist; validate unique constraints
- **Update**: Check that the record exists; verify `_version` matches `expectedVersion`; validate unique constraints
- **Delete**: If the record exists, verify `_version` matches `expectedVersion`

If any validation fails, the phase throws an error and no mutations occur.

### Phase 2: Application

If all validations pass, mutations are applied and undo operations are collected:

- **Insert**: Add to indexes and table; generate `inserted` event; record `undo_insert`
- **Update**: Update indexes and table; generate `updated` event; record `undo_update` with old record
- **Delete**: Remove from indexes and table; generate `deleted` event; record `undo_delete` with removed record

If an error occurs during application, the undo operations are applied in reverse order to restore consistency.

```text
  Phase 1: Validate          Phase 2: Apply
  +--------------------+     +--------------------+
  |                    |     |                    |
  |  insert: key free? |     |  insert: store +   |
  |  update: version?  |     |    index + undo    |
  |  delete: version?  |     |  update: store +   |
  |                    |     |    index + undo    |
  |  ALL pass?         |     |  delete: store +   |
  |    YES -> Phase 2  |     |    index + undo    |
  |    NO  -> throw    |     |                    |
  |                    |     |  Return: events +  |
  +--------------------+     |    undo ops        |
                             +--------------------+
```

## TransactionConflictError

When a version mismatch is detected, the store throws a `TransactionConflictError`:

```typescript
import { TransactionConflictError } from '@hamicek/noex-store';

// Reset Alice's balance for this example
await accounts.update('alice', { balance: 1000 });

// Simulate a concurrent modification
const aliceSnapshot = await accounts.get('alice');

// Another operation modifies Alice between our read and our commit
await accounts.update('alice', { balance: 950 });

try {
  await store.transaction(async (tx) => {
    const txAccounts = await tx.bucket('accounts');

    // Read Alice — gets version from real store
    const alice = await txAccounts.get('alice');
    // alice._version is now stale (we read the old version before the external update)

    await txAccounts.update('alice', {
      balance: (alice!.balance as number) - 200,
    });
  });
} catch (err) {
  if (err instanceof TransactionConflictError) {
    console.log(err.message);
    // Transaction conflict in bucket "accounts" for key "alice":
    //   Version mismatch: expected 3, got 4
    console.log(err.bucket); // 'accounts'
    console.log(err.key);    // 'alice'
  }
}
```

The error includes:

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | Human-readable description including bucket, key, and reason |
| `bucket` | `string` | Name of the bucket where the conflict occurred |
| `key` | `unknown` | Primary key of the conflicting record |
| `field` | `string \| undefined` | Specific field involved (for unique constraint conflicts) |

## Cross-Bucket Rollback

When a transaction spans multiple buckets, they are committed sequentially. If a later bucket fails, all previously committed buckets are rolled back:

```text
  Transaction touches: accounts, transfers

  Commit sequence:
  +--------------------------------------------------+
  |                                                  |
  |  1. Commit accounts   -> SUCCESS                 |
  |     (undo ops saved)                             |
  |                                                  |
  |  2. Commit transfers  -> FAILS (conflict!)       |
  |                                                  |
  |  3. Rollback accounts <- apply undo ops          |
  |     (reverse order)                              |
  |                                                  |
  |  4. Throw TransactionConflictError               |
  |                                                  |
  +--------------------------------------------------+
```

```typescript
// Demonstrate cross-bucket rollback
await accounts.update('alice', { balance: 1000 });
await accounts.update('bob', { balance: 500 });

// Insert a transfer that we'll conflict on
const existingTransfer = await transfers.insert({
  from: 'alice', to: 'bob', amount: 50,
});

// Externally modify the transfer to create a version conflict
await transfers.update(existingTransfer.id, { amount: 75 });

try {
  await store.transaction(async (tx) => {
    const txAccounts = await tx.bucket('accounts');
    const txTransfers = await tx.bucket('transfers');

    // Update accounts (will succeed in isolation)
    const alice = await txAccounts.get('alice');
    await txAccounts.update('alice', {
      balance: (alice!.balance as number) - 100,
    });

    // Update the transfer record (will conflict on commit)
    const transfer = await txTransfers.get(existingTransfer.id);
    await txTransfers.update(existingTransfer.id, { amount: 100 });
  });
} catch (err) {
  if (err instanceof TransactionConflictError) {
    console.log('Conflict detected — all changes rolled back');
  }
}

// Verify: Alice's balance is unchanged (rollback succeeded)
const alice = await accounts.get('alice');
console.log(`Alice balance: ${alice?.balance}`); // 1000 (unchanged)
```

### Rollback is Best-Effort

If a rollback itself fails (e.g., the BucketServer is unreachable), the store logs the failure and continues rolling back remaining buckets. This is rare in practice since noex-store runs in-memory within the same process.

## Events and Transactions

Events are published only after all buckets commit successfully:

```typescript
import type { BucketEvent } from '@hamicek/noex-store';

const events: BucketEvent[] = [];
await store.on<BucketEvent>('bucket.*.*', (event) => {
  events.push(event);
});

// Successful transaction — events published after commit
await store.transaction(async (tx) => {
  const txAccounts = await tx.bucket('accounts');
  await txAccounts.update('alice', { balance: 900 });
  await txAccounts.update('bob', { balance: 600 });
});

// Wait for async event delivery
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`Events after successful tx: ${events.length}`); // 2

// Failed transaction — no events published
events.length = 0;

try {
  await store.transaction(async (tx) => {
    const txAccounts = await tx.bucket('accounts');
    await txAccounts.update('alice', { balance: 800 });
    throw new Error('Business logic failure');
  });
} catch {
  // Expected
}

await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`Events after failed tx: ${events.length}`); // 0
```

| Scenario | Events Published? |
|----------|-------------------|
| Successful commit | Yes — all events published after all buckets succeed |
| Callback throws | No — buffer discarded, commit never runs |
| Commit conflict | No — rollback cancels all changes |
| Partial commit + rollback | No — events are collected but only published after all buckets succeed |

## Retry Pattern

When a `TransactionConflictError` occurs, the standard recovery is to retry the transaction with fresh data. Since transactions re-read records on each attempt, the retry naturally gets the latest versions:

```typescript
async function transferWithRetry(
  from: string,
  to: string,
  amount: number,
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await store.transaction(async (tx) => {
        const txAccounts = await tx.bucket('accounts');

        const sender = await txAccounts.get(from);
        const receiver = await txAccounts.get(to);

        if (sender === undefined || receiver === undefined) {
          throw new Error('Account not found');
        }

        const senderBalance = sender.balance as number;
        if (senderBalance < amount) {
          throw new Error(`Insufficient funds: ${senderBalance} < ${amount}`);
        }

        await txAccounts.update(from, { balance: senderBalance - amount });
        await txAccounts.update(to, {
          balance: (receiver.balance as number) + amount,
        });
      });

      return; // Success
    } catch (err) {
      if (err instanceof TransactionConflictError && attempt < maxRetries) {
        console.log(`Conflict on attempt ${attempt}, retrying...`);
        continue;
      }
      throw err; // Non-conflict error or max retries exceeded
    }
  }
}

await transferWithRetry('alice', 'bob', 200);
```

### Retry Guidelines

| Guideline | Reason |
|-----------|--------|
| **Keep the callback pure** | Side effects (HTTP calls, logging) would execute on every retry |
| **Limit retry count** | Infinite retries under high contention can cause livelock |
| **Re-read inside the callback** | The retry must use fresh data; don't capture variables from outside |
| **Don't catch non-conflict errors** | Validation errors and business logic errors shouldn't be retried |

## Complete Working Example

A banking system with concurrent transfers and conflict handling:

```typescript
import { Store, TransactionConflictError } from '@hamicek/noex-store';
import type { BucketEvent } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'optimistic-locking-demo' });

  await store.defineBucket('accounts', {
    key: 'id',
    schema: {
      id:      { type: 'string', required: true },
      owner:   { type: 'string', required: true },
      balance: { type: 'number', required: true, min: 0 },
    },
  });

  await store.defineBucket('transfers', {
    key: 'id',
    schema: {
      id:        { type: 'number', generated: 'autoincrement' },
      from:      { type: 'string', required: true },
      to:        { type: 'string', required: true },
      amount:    { type: 'number', required: true, min: 1 },
      timestamp: { type: 'number', required: true },
    },
  });

  const accounts = store.bucket('accounts');
  const transfersBucket = store.bucket('transfers');

  await accounts.insert({ id: 'alice', owner: 'Alice', balance: 1000 });
  await accounts.insert({ id: 'bob', owner: 'Bob', balance: 500 });
  await accounts.insert({ id: 'carol', owner: 'Carol', balance: 750 });

  // Track events
  const events: string[] = [];
  await store.on<BucketEvent>('bucket.*.*', (event) => {
    events.push(`${event.bucket}.${event.type}(${String(event.key)})`);
  });

  // --- Transfer with retry ---

  async function transfer(
    from: string,
    to: string,
    amount: number,
    maxRetries = 3,
  ): Promise<number> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await store.transaction(async (tx) => {
          const txAccounts = await tx.bucket('accounts');
          const txTransfers = await tx.bucket('transfers');

          const sender = await txAccounts.get(from);
          const receiver = await txAccounts.get(to);

          if (sender === undefined) throw new Error(`Account ${from} not found`);
          if (receiver === undefined) throw new Error(`Account ${to} not found`);

          const senderBalance = sender.balance as number;
          if (senderBalance < amount) {
            throw new Error(
              `Insufficient funds: ${sender.owner} has $${senderBalance}, needs $${amount}`,
            );
          }

          await txAccounts.update(from, { balance: senderBalance - amount });
          await txAccounts.update(to, {
            balance: (receiver.balance as number) + amount,
          });

          const record = await txTransfers.insert({
            from,
            to,
            amount,
            timestamp: Date.now(),
          });

          return record.id as number;
        });
      } catch (err) {
        if (err instanceof TransactionConflictError && attempt < maxRetries) {
          console.log(`  [retry] Conflict on attempt ${attempt}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable');
  }

  // --- Run transfers ---

  console.log('--- Transfer 1: Alice -> Bob $200 ---');
  const t1 = await transfer('alice', 'bob', 200);
  console.log(`Transfer #${t1} completed`);

  console.log('\n--- Transfer 2: Bob -> Carol $100 ---');
  const t2 = await transfer('bob', 'carol', 100);
  console.log(`Transfer #${t2} completed`);

  console.log('\n--- Transfer 3: Insufficient funds ---');
  try {
    await transfer('carol', 'alice', 5000);
  } catch (err) {
    console.log(`Failed: ${(err as Error).message}`);
  }

  // --- Final balances ---

  console.log('\n--- Final Balances ---');
  for (const id of ['alice', 'bob', 'carol']) {
    const acc = await accounts.get(id);
    console.log(`  ${acc?.owner}: $${acc?.balance}`);
  }
  // Alice: $800, Bob: $600, Carol: $850

  // --- Transfer log ---

  const allTransfers = await transfersBucket.all();
  console.log(`\n--- Transfer Log (${allTransfers.length} entries) ---`);
  for (const t of allTransfers) {
    console.log(`  #${t.id}: ${t.from} -> ${t.to} $${t.amount}`);
  }

  // --- Events ---

  await new Promise((resolve) => setTimeout(resolve, 50));
  console.log(`\n--- Events (${events.length}) ---`);
  for (const e of events) {
    console.log(`  ${e}`);
  }

  await store.stop();
}

main();
```

## Exercise

Given the following store with a ticket booking system:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('events', {
  key: 'id',
  schema: {
    id:             { type: 'string', required: true },
    name:           { type: 'string', required: true },
    availableSeats: { type: 'number', required: true, min: 0 },
    price:          { type: 'number', required: true, min: 0 },
  },
});

await store.defineBucket('bookings', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    eventId:  { type: 'string', required: true },
    userId:   { type: 'string', required: true },
    seats:    { type: 'number', required: true, min: 1 },
    total:    { type: 'number', required: true, min: 0 },
  },
  indexes: ['eventId', 'userId'],
});

const eventsBucket = store.bucket('events');
const bookings = store.bucket('bookings');

await eventsBucket.insert({ id: 'concert-1', name: 'Jazz Night', availableSeats: 50, price: 75 });
```

Write a `bookSeats(userId, eventId, seats)` function that:

1. Uses a transaction with retry logic (max 3 attempts)
2. Reads the event to check available seats
3. Throws a business error if not enough seats (not retried)
4. Deducts seats and creates a booking atomically
5. Returns the booking record
6. Catches `TransactionConflictError` and retries

<details>
<summary>Solution</summary>

```typescript
import { TransactionConflictError } from '@hamicek/noex-store';

async function bookSeats(
  userId: string,
  eventId: string,
  seats: number,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await store.transaction(async (tx) => {
        const txEvents = await tx.bucket('events');
        const txBookings = await tx.bucket('bookings');

        const event = await txEvents.get(eventId);
        if (event === undefined) {
          throw new Error(`Event ${eventId} not found`);
        }

        const available = event.availableSeats as number;
        if (available < seats) {
          // Business error — do not retry
          throw new Error(
            `Not enough seats for ${event.name}: requested ${seats}, available ${available}`,
          );
        }

        // Deduct seats
        await txEvents.update(eventId, { availableSeats: available - seats });

        // Create booking
        const booking = await txBookings.insert({
          eventId,
          userId,
          seats,
          total: seats * (event.price as number),
        });

        return booking;
      });
    } catch (err) {
      if (err instanceof TransactionConflictError && attempt < 3) {
        console.log(`Booking conflict (attempt ${attempt}), retrying...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// Test: successful booking
const booking = await bookSeats('user-1', 'concert-1', 2);
console.log(`Booking #${booking.id}: ${booking.seats} seats, $${booking.total}`);
// Booking #1: 2 seats, $150

// Verify seats deducted
const event = await eventsBucket.get('concert-1');
console.log(`Available seats: ${event?.availableSeats}`); // 48

// Test: insufficient seats
try {
  await bookSeats('user-2', 'concert-1', 100);
} catch (err) {
  console.log((err as Error).message);
  // Not enough seats for Jazz Night: requested 100, available 48
}

// Seats unchanged after business error
const eventAfter = await eventsBucket.get('concert-1');
console.log(`Seats (unchanged): ${eventAfter?.availableSeats}`); // 48
```

</details>

## Summary

- Every record has a **`_version`** field that starts at 1 and increments on each update — it's the foundation of conflict detection
- noex-store uses **optimistic locking**: transactions don't hold locks; instead, they record expected versions and verify them at commit time
- The commit process is a **two-phase protocol**: Phase 1 validates all operations without mutations, Phase 2 applies them and collects undo operations
- **`TransactionConflictError`** is thrown when a version mismatch is detected — it includes the bucket name, record key, and a description of the conflict
- **Cross-bucket rollback**: if bucket B's commit fails after bucket A succeeded, bucket A's changes are undone via recorded undo operations
- **Events are transactional**: they are published only after all buckets commit successfully — a failed or rolled-back transaction publishes no events
- **Retry logic** is the standard recovery pattern — re-read fresh data on each attempt, limit retries, and don't retry business logic errors
- Keep transaction callbacks **pure** — avoid side effects that shouldn't repeat on retry
- Rollback is **best-effort**: in the rare case an undo fails, the store continues rolling back remaining buckets

## API Reference

- [Transactions](../../reference/transactions.md) — `_version` checking, optimistic locking, rollback mechanics
- [Errors](../../reference/errors.md) — `TransactionConflictError` and retry patterns

---

Next: [Persisting Data](../08-persistence/01-persisting-data.md)
