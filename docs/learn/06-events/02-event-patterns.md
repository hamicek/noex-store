# Event Patterns

You know how to subscribe to events. But a raw event handler that logs a line or pushes to an array isn't particularly useful in production. The real value comes from composing events into practical patterns: audit trails that record who changed what and when, notifications that alert users when data reaches a certain state, and cascading operations that maintain referential integrity across buckets.

This chapter walks through the most common event-driven patterns you'll build with noex-store and shows how to keep them clean, testable, and safe.

## What You'll Learn

- How to build an audit log that records every mutation with before/after snapshots
- How to send notifications when data reaches a specific state
- How to implement cascading deletes that maintain referential integrity
- How to build a change counter for real-time metrics
- How to keep event handlers focused, idempotent, and easy to test

## Setup

All examples in this chapter use the following store:

```typescript
import { Store } from '@hamicek/noex-store';
import type {
  BucketEvent,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
} from '@hamicek/noex-store';

const store = await Store.start({ name: 'patterns-demo' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', required: true, format: 'email' },
    role:  { type: 'string', enum: ['admin', 'editor', 'viewer'], default: 'viewer' },
  },
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:     { type: 'number', generated: 'autoincrement' },
    userId: { type: 'string', required: true },
    total:  { type: 'number', required: true, min: 0 },
    status: { type: 'string', enum: ['pending', 'paid', 'shipped', 'cancelled'], default: 'pending' },
  },
  indexes: ['userId', 'status'],
});

await store.defineBucket('auditLog', {
  key: 'id',
  schema: {
    id:        { type: 'number', generated: 'autoincrement' },
    timestamp: { type: 'number', required: true },
    bucket:    { type: 'string', required: true },
    action:    { type: 'string', required: true, enum: ['inserted', 'updated', 'deleted'] },
    recordKey: { type: 'string', required: true },
    before:    { type: 'object' },
    after:     { type: 'object' },
  },
  indexes: ['bucket', 'action'],
});

const users = store.bucket('users');
const orders = store.bucket('orders');
const auditLog = store.bucket('auditLog');
```

## Pattern 1: Audit Log

An audit log records every mutation so you can answer "what happened, when, and what changed?" for any record. The event system delivers the before/after state, so building the log is straightforward:

```typescript
await store.on<BucketEvent>('bucket.*.*', async (event) => {
  // Skip events from the audit log itself to avoid infinite recursion
  if (event.bucket === 'auditLog') return;

  const entry: Record<string, unknown> = {
    timestamp: Date.now(),
    bucket: event.bucket,
    action: event.type,
    recordKey: String(event.key),
  };

  switch (event.type) {
    case 'inserted':
      entry.after = { ...event.record };
      break;
    case 'updated':
      entry.before = { ...event.oldRecord };
      entry.after = { ...event.newRecord };
      break;
    case 'deleted':
      entry.before = { ...event.record };
      break;
  }

  await auditLog.insert(entry);
});
```

### Querying the Audit Trail

Once the log is populated, you can query it like any bucket:

```typescript
// Create a user and modify them
const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
await users.update(alice.id, { role: 'admin' });
await users.update(alice.id, { name: 'Alice Smith' });

// Wait for async event delivery
await new Promise((resolve) => setTimeout(resolve, 100));

// All changes to a specific record
const aliceHistory = await auditLog.where({ recordKey: alice.id });
console.log(`Alice has ${aliceHistory.length} audit entries`); // 3

// All updates across the store
const allUpdates = await auditLog.where({ action: 'updated' });
console.log(`Total updates: ${allUpdates.length}`); // 2

// All mutations in a specific bucket
const userMutations = await auditLog.where({ bucket: 'users' });
console.log(`User mutations: ${userMutations.length}`); // 3
```

### Audit Log Flow

```text
  users.update(alice.id, { role: 'admin' })
      |
      v
  BucketServer commits update
      |
      v
  EventBus publishes: bucket.users.updated
      |
      v
  Audit handler receives event:
  +----------------------------------------------------+
  | event.type      = 'updated'                         |
  | event.bucket    = 'users'                           |
  | event.key       = 'alice-uuid'                      |
  | event.oldRecord = { name: 'Alice', role: 'viewer' } |
  | event.newRecord = { name: 'Alice', role: 'admin' }  |
  +----------------------------------------------------+
      |
      v
  auditLog.insert({
    timestamp: 1706745600000,
    bucket: 'users',
    action: 'updated',
    recordKey: 'alice-uuid',
    before: { name: 'Alice', role: 'viewer', ... },
    after:  { name: 'Alice', role: 'admin', ... },
  })
```

### Preventing Infinite Recursion

The audit handler subscribes to `bucket.*.*` which includes the `auditLog` bucket itself. Without the `if (event.bucket === 'auditLog') return` guard, inserting an audit entry would trigger another audit entry, and so on forever. Always guard against self-referential loops when a handler writes back to the store.

## Pattern 2: State-Change Notifications

Notifications fire when a field transitions to a specific value. The update event carries both old and new records, so detecting transitions is a simple comparison:

```typescript
await store.on<BucketUpdatedEvent>('bucket.orders.updated', async (event) => {
  const { oldRecord, newRecord } = event;

  // Only react to status transitions — not other field changes
  if (oldRecord.status === newRecord.status) return;

  const transition = `${oldRecord.status} -> ${newRecord.status}`;

  switch (newRecord.status) {
    case 'paid':
      console.log(`[NOTIFY] Order #${event.key} paid — $${newRecord.total}`);
      // In production: send email confirmation, trigger fulfillment
      break;

    case 'shipped':
      console.log(`[NOTIFY] Order #${event.key} shipped`);
      // In production: send tracking notification
      break;

    case 'cancelled':
      console.log(`[NOTIFY] Order #${event.key} cancelled (was: ${oldRecord.status})`);
      // In production: process refund, notify warehouse
      break;
  }
});
```

### Testing Notifications

```typescript
const order = await orders.insert({ userId: 'user-1', total: 200 });

await orders.update(order.id, { status: 'paid' });
// [NOTIFY] Order #1 paid — $200

await orders.update(order.id, { status: 'shipped' });
// [NOTIFY] Order #1 shipped

// Non-status update — no notification
await orders.update(order.id, { total: 210 });
// (silence — status didn't change)
```

### Why Compare Old and New

Without the `oldRecord.status === newRecord.status` guard, any update to an order would trigger the notification — even updating the `total` field while the status is already `'paid'`. Always check that the relevant field actually changed before acting.

## Pattern 3: Cascading Deletes

When a user is deleted, their orders should be removed too. Without events, you'd have to remember this cleanup at every call site. With events, you define it once:

```typescript
await store.on<BucketDeletedEvent>('bucket.users.deleted', async (event) => {
  const userId = String(event.key);
  const userOrders = await orders.where({ userId });

  for (const order of userOrders) {
    await orders.delete(order.id);
  }

  if (userOrders.length > 0) {
    console.log(`Cascade: deleted ${userOrders.length} orders for user ${userId}`);
  }
});
```

### Cascading in Action

```typescript
const bob = await users.insert({ name: 'Bob', email: 'bob@example.com' });
await orders.insert({ userId: bob.id, total: 50 });
await orders.insert({ userId: bob.id, total: 120 });
await orders.insert({ userId: bob.id, total: 75 });

console.log(`Orders before: ${await orders.count({ userId: bob.id })}`); // 3

await users.delete(bob.id);
// Cascade: deleted 3 orders for user <uuid>

// Wait for async cascade
await new Promise((resolve) => setTimeout(resolve, 100));

console.log(`Orders after: ${await orders.count({ userId: bob.id })}`); // 0
```

### Cascade Flow

```text
  users.delete(bob.id)
      |
      v
  BucketServer deletes Bob
      |
      v
  EventBus: bucket.users.deleted
      |
      v
  Cascade handler:
    1. orders.where({ userId: bob.id })
       -> [order-1, order-2, order-3]
    2. orders.delete(order-1.id)  -> EventBus: bucket.orders.deleted
    3. orders.delete(order-2.id)  -> EventBus: bucket.orders.deleted
    4. orders.delete(order-3.id)  -> EventBus: bucket.orders.deleted
```

Each cascaded delete also publishes its own event. If you have an audit log handler running, it will record these deletions automatically.

### Safety Considerations

Cascading deletes are powerful but can be dangerous. Keep these guidelines in mind:

| Concern | Mitigation |
|---------|------------|
| Accidental cascade | Add a confirmation step in application code before deleting the parent record |
| Deep chains | Avoid cascades that trigger more cascades (A deletes B, B deletes C). Keep cascades one level deep |
| Performance | For buckets with thousands of child records, consider batch deletion or a background job |
| Circular references | If A cascades to B and B cascades to A, you get infinite deletion. Guard against this with a check |

## Pattern 4: Change Counter

A lightweight metrics pattern that counts mutations by type and bucket:

```typescript
const counters = new Map<string, number>();

await store.on<BucketEvent>('bucket.*.*', (event) => {
  if (event.bucket === 'auditLog') return;

  const key = `${event.bucket}.${event.type}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
});
```

### Reading Metrics

```typescript
await users.insert({ name: 'Alice', email: 'alice@example.com' });
await users.insert({ name: 'Bob', email: 'bob@example.com' });
await orders.insert({ userId: 'user-1', total: 100 });
await orders.update(1, { status: 'paid' });

// Wait for events
await new Promise((resolve) => setTimeout(resolve, 50));

for (const [key, count] of counters) {
  console.log(`${key}: ${count}`);
}
// users.inserted: 2
// orders.inserted: 1
// orders.updated: 1
```

This pattern is useful for dashboards, rate limiting, or anomaly detection.

## Handler Design Guidelines

### Keep Handlers Focused

Each handler should do one thing. Instead of a single handler that logs, notifies, and cascades, create separate subscriptions:

```typescript
// Good: each handler has a single responsibility
await store.on('bucket.users.deleted', handleCascadeDeletes);
await store.on('bucket.*.*', handleAuditLog);
await store.on('bucket.orders.updated', handleOrderNotifications);
```

### Handle Errors Gracefully

A throwing handler doesn't affect the original operation — the insert/update/delete has already succeeded. But an unhandled rejection can crash your process:

```typescript
await store.on<BucketEvent>('bucket.*.*', async (event) => {
  try {
    await auditLog.insert({
      timestamp: Date.now(),
      bucket: event.bucket,
      action: event.type,
      recordKey: String(event.key),
    });
  } catch (err) {
    console.error(`Audit log failed for ${event.bucket}.${event.type}:`, err);
    // Log the error but don't crash — the original operation already succeeded
  }
});
```

### Avoid Blocking Work in Handlers

Event handlers run asynchronously but still consume resources. For expensive operations (HTTP calls, disk writes, heavy computation), consider buffering events and processing them in batches:

```typescript
const buffer: BucketEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

await store.on<BucketEvent>('bucket.*.*', (event) => {
  if (event.bucket === 'auditLog') return;

  buffer.push(event);

  // Flush every 100ms if not already scheduled
  if (flushTimer === null) {
    flushTimer = setTimeout(async () => {
      const batch = buffer.splice(0);
      flushTimer = null;

      for (const e of batch) {
        await auditLog.insert({
          timestamp: Date.now(),
          bucket: e.bucket,
          action: e.type,
          recordKey: String(e.key),
        });
      }
    }, 100);
  }
});
```

## Complete Working Example

A user management system with audit logging, order notifications, and cascading deletes:

```typescript
import { Store } from '@hamicek/noex-store';
import type {
  BucketEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
} from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'event-patterns-demo' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true, format: 'email' },
    },
  });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:     { type: 'number', generated: 'autoincrement' },
      userId: { type: 'string', required: true },
      total:  { type: 'number', required: true, min: 0 },
      status: { type: 'string', enum: ['pending', 'paid', 'shipped', 'cancelled'], default: 'pending' },
    },
    indexes: ['userId', 'status'],
  });

  await store.defineBucket('auditLog', {
    key: 'id',
    schema: {
      id:        { type: 'number', generated: 'autoincrement' },
      timestamp: { type: 'number', required: true },
      bucket:    { type: 'string', required: true },
      action:    { type: 'string', required: true },
      recordKey: { type: 'string', required: true },
      before:    { type: 'object' },
      after:     { type: 'object' },
    },
    indexes: ['bucket'],
  });

  const users = store.bucket('users');
  const ordersBucket = store.bucket('orders');
  const audit = store.bucket('auditLog');

  // --- Pattern 1: Audit log ---
  await store.on<BucketEvent>('bucket.*.*', async (event) => {
    if (event.bucket === 'auditLog') return;

    const entry: Record<string, unknown> = {
      timestamp: Date.now(),
      bucket: event.bucket,
      action: event.type,
      recordKey: String(event.key),
    };

    switch (event.type) {
      case 'inserted':
        entry.after = { ...event.record };
        break;
      case 'updated':
        entry.before = { ...event.oldRecord };
        entry.after = { ...event.newRecord };
        break;
      case 'deleted':
        entry.before = { ...event.record };
        break;
    }

    try {
      await audit.insert(entry);
    } catch (err) {
      console.error('Audit log error:', err);
    }
  });

  // --- Pattern 2: Order status notifications ---
  await store.on<BucketUpdatedEvent>('bucket.orders.updated', (event) => {
    const { oldRecord, newRecord } = event;
    if (oldRecord.status === newRecord.status) return;

    console.log(`[NOTIFY] Order #${event.key}: ${oldRecord.status} -> ${newRecord.status}`);
  });

  // --- Pattern 3: Cascading deletes ---
  await store.on<BucketDeletedEvent>('bucket.users.deleted', async (event) => {
    const userId = String(event.key);
    const userOrders = await ordersBucket.where({ userId });
    for (const order of userOrders) {
      await ordersBucket.delete(order.id);
    }
    if (userOrders.length > 0) {
      console.log(`[CASCADE] Deleted ${userOrders.length} orders for user ${userId}`);
    }
  });

  // --- Run the scenario ---

  // Create users
  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  const bob = await users.insert({ name: 'Bob', email: 'bob@example.com' });

  // Create orders
  const order1 = await ordersBucket.insert({ userId: alice.id, total: 150 });
  await ordersBucket.insert({ userId: bob.id, total: 80 });
  await ordersBucket.insert({ userId: bob.id, total: 200 });

  // Status transitions trigger notifications
  await ordersBucket.update(order1.id, { status: 'paid' });
  // [NOTIFY] Order #1: pending -> paid

  await ordersBucket.update(order1.id, { status: 'shipped' });
  // [NOTIFY] Order #1: paid -> shipped

  // Delete Bob — cascades to his orders
  await users.delete(bob.id);
  // [CASCADE] Deleted 2 orders for user <uuid>

  // Wait for all async handlers
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Check audit trail
  const auditEntries = await audit.count();
  console.log(`\nAudit log entries: ${auditEntries}`);

  const orderCount = await ordersBucket.count();
  console.log(`Remaining orders: ${orderCount}`); // 1 (Alice's shipped order)

  await store.stop();
}

main();
```

## Exercise

Build a simple inventory system with the following buckets and event handlers:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('products', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    stock: { type: 'number', required: true, min: 0 },
  },
});

await store.defineBucket('alerts', {
  key: 'id',
  schema: {
    id:        { type: 'number', generated: 'autoincrement' },
    productId: { type: 'string', required: true },
    message:   { type: 'string', required: true },
    timestamp: { type: 'number', required: true },
  },
});

const products = store.bucket('products');
const alerts = store.bucket('alerts');
```

Write event handlers that:

1. **Low-stock alert**: When a product's `stock` drops to 5 or below (and it wasn't already at 5 or below), insert an alert with the message `"Low stock: {name} has {stock} units"`
2. **Out-of-stock alert**: When a product's `stock` reaches 0, insert an alert with the message `"Out of stock: {name}"`
3. **Restock notification**: When a product's `stock` increases from 0 to any positive number, log `"Restocked: {name}"`

Then test by creating a product with stock 10, updating stock to 3, then to 0, then to 15.

<details>
<summary>Solution</summary>

```typescript
import type { BucketUpdatedEvent } from '@hamicek/noex-store';

// Low-stock and out-of-stock alerts
await store.on<BucketUpdatedEvent>('bucket.products.updated', async (event) => {
  const { oldRecord, newRecord } = event;
  const oldStock = oldRecord.stock as number;
  const newStock = newRecord.stock as number;
  const name = newRecord.name as string;

  // Low-stock alert: crossed the threshold from above 5 to 5 or below
  if (oldStock > 5 && newStock <= 5 && newStock > 0) {
    await alerts.insert({
      productId: String(event.key),
      message: `Low stock: ${name} has ${newStock} units`,
      timestamp: Date.now(),
    });
  }

  // Out-of-stock alert
  if (oldStock > 0 && newStock === 0) {
    await alerts.insert({
      productId: String(event.key),
      message: `Out of stock: ${name}`,
      timestamp: Date.now(),
    });
  }

  // Restock notification
  if (oldStock === 0 && newStock > 0) {
    console.log(`Restocked: ${name}`);
  }
});

// Test the handlers
const widget = await products.insert({ name: 'Widget', stock: 10 });

await products.update(widget.id, { stock: 3 });
// -> alert: "Low stock: Widget has 3 units"

await products.update(widget.id, { stock: 0 });
// -> alert: "Out of stock: Widget"

await products.update(widget.id, { stock: 15 });
// -> console: "Restocked: Widget"

// Wait for async handlers
await new Promise((resolve) => setTimeout(resolve, 100));

const allAlerts = await alerts.where({ productId: widget.id });
console.log(`Alerts: ${allAlerts.length}`); // 2
for (const a of allAlerts) {
  console.log(`  ${a.message}`);
}
// Low stock: Widget has 3 units
// Out of stock: Widget
```

</details>

## Summary

- **Audit log**: Subscribe to `bucket.*.*`, record `before`/`after` snapshots into a dedicated bucket, and guard against self-referential loops
- **State-change notifications**: Compare `oldRecord` and `newRecord` fields to detect transitions — don't react to every update, only meaningful state changes
- **Cascading deletes**: Subscribe to `bucket.{parent}.deleted` and remove child records — keep cascades one level deep to avoid complexity
- **Change counter**: A lightweight in-memory `Map` that counts mutations by bucket and type — useful for dashboards and rate limiting
- **Handler design**: One responsibility per handler, always wrap async work in try/catch, guard against infinite recursion, and buffer expensive operations
- Event handlers run after the mutation succeeds — a failing handler cannot roll back the original operation
- Multiple patterns compose naturally: an audit log, notification handler, and cascade handler can all run simultaneously on the same store

## API Reference

- [Events](../../reference/events.md) — `BucketInsertedEvent`, `BucketUpdatedEvent`, `BucketDeletedEvent`, wildcard matching rules

---

Next: [Why Transactions?](../07-transactions/01-why-transactions.md)
