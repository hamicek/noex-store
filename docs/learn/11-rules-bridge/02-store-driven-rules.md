# Store-Driven Rules

You've set up a bridge that forwards store events to a rule engine. The rule engine evaluates conditions and fires actions. But what if those actions need to write back to the store? An "order shipped" event triggers a rule that updates the customer's loyalty points. A "stock depleted" event triggers a rule that creates a reorder request. The data flows in a circle: store mutation → event → rule engine → store mutation → event → ...

This bidirectional pattern is powerful but dangerous. Without care, you create infinite loops, race conditions, or tightly coupled systems that are impossible to debug. This chapter shows you how to architect the feedback loop safely, with clear boundaries between the event-producing store and the action-executing rule engine.

## What You'll Learn

- How to structure a bidirectional store ↔ rule engine integration
- How rules can write back to the store through action handlers
- How to prevent infinite event loops with guard conditions and filters
- How to use transactions when a rule action touches multiple buckets
- How to trace the full cycle: mutation → event → rule → mutation
- Common patterns: cascading updates, derived data, and cross-bucket consistency

## The Feedback Loop

The bridge from chapter 11.1 is one-way: store → rule engine. To close the loop, the rule engine's action handlers call back into the store:

```text
  ┌─────────────────────────────────────────────────────────┐
  │                                                           │
  │   ┌───────────┐    bridge     ┌──────────────┐           │
  │   │           │ ────────────> │              │           │
  │   │   Store   │   (events)   │ Rule Engine  │           │
  │   │           │ <──────────── │              │           │
  │   └───────────┘   (actions)   └──────────────┘           │
  │                                                           │
  │   The bridge forwards events.                             │
  │   Rule actions call store methods directly.               │
  │                                                           │
  └─────────────────────────────────────────────────────────┘
```

The bridge handles the store → rules direction. For rules → store, the rule engine's action handlers simply hold a reference to the store (or its bucket handles) and call `insert`, `update`, or `delete` directly. There's no special API for this — it's regular store usage from within a callback.

## Architecture

A well-structured bidirectional integration has three layers:

```text
  Layer 1: Data (Store)
  ┌─────────────────────────────────────────────┐
  │  users    orders    inventory    loyalty     │
  │  bucket   bucket    bucket       bucket      │
  └──────────────────┬──────────────────────────┘
                     │
                     │  bucket events (via bridge)
                     ▼
  Layer 2: Logic (Rule Engine)
  ┌─────────────────────────────────────────────┐
  │  "order.shipped → add loyalty points"       │
  │  "stock.below.10 → create reorder request"  │
  │  "user.deleted → archive orders"            │
  └──────────────────┬──────────────────────────┘
                     │
                     │  action handlers (call store methods)
                     ▼
  Layer 3: Side Effects
  ┌─────────────────────────────────────────────┐
  │  Store mutations    External APIs            │
  │  Notifications      Logging                  │
  └─────────────────────────────────────────────┘
```

| Layer | Responsibility | Knows About |
|-------|---------------|-------------|
| Data (Store) | Hold state, validate, emit events | Nothing about rules |
| Logic (Rule Engine) | Evaluate conditions, decide actions | Event topics and data shapes |
| Side Effects (Actions) | Execute decisions | Store API, external services |

The store never imports or references the rule engine. The rule engine knows the event topics and data shapes but doesn't manage store internals. Action handlers bridge the gap by calling store methods.

## Pattern: Cascading Updates

When a mutation in one bucket should trigger an update in another, the rule engine acts as the coordinator.

### Example: Loyalty Points on Order Shipment

```typescript
import { Store, bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'loyalty' });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:     { type: 'number', generated: 'autoincrement' },
      userId: { type: 'string', required: true },
      total:  { type: 'number', required: true, min: 0 },
      status: { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
    },
    indexes: ['userId', 'status'],
  });

  await store.defineBucket('loyalty', {
    key: 'userId',
    schema: {
      userId: { type: 'string', required: true },
      points: { type: 'number', default: 0, min: 0 },
    },
  });

  const ordersBucket = store.bucket('orders');
  const loyaltyBucket = store.bucket('loyalty');

  // --- Rule engine (mock implementation) ---
  type RuleHandler = (topic: string, data: Record<string, unknown>) => void;
  const rules: Array<{ pattern: RegExp; handler: RuleHandler }> = [];

  const ruleEngine: EventReceiver = {
    async emit(topic, data) {
      for (const rule of rules) {
        if (rule.pattern.test(topic)) {
          rule.handler(topic, data);
        }
      }
    },
  };

  // --- Define rules ---

  // Rule: When an order status changes to 'shipped', add loyalty points
  rules.push({
    pattern: /^bucket\.orders\.updated$/,
    handler: async (_topic, data) => {
      const event = data as unknown as BucketEvent;
      if (event.type !== 'updated') return;

      const { oldRecord, newRecord } = event;
      if (oldRecord.status !== 'shipped' && newRecord.status === 'shipped') {
        const userId = newRecord.userId as string;
        const pointsToAdd = Math.floor((newRecord.total as number) / 10);

        const existing = await loyaltyBucket.get(userId);
        if (existing) {
          await loyaltyBucket.update(userId, {
            points: (existing.points as number) + pointsToAdd,
          });
        } else {
          await loyaltyBucket.insert({ userId, points: pointsToAdd });
        }
      }
    },
  });

  // --- Bridge store events to rule engine ---
  const unbridge = await bridgeStoreToRules(store, ruleEngine, {
    filter: (event) => event.bucket === 'orders',
  });

  // --- Run scenario ---
  const order = await ordersBucket.insert({ userId: 'alice', total: 250 });
  await ordersBucket.update(order.id, { status: 'paid' });
  await ordersBucket.update(order.id, { status: 'shipped' });

  // Wait for async processing
  await new Promise((resolve) => setTimeout(resolve, 100));

  const loyalty = await loyaltyBucket.get('alice');
  console.log(`Alice's loyalty points: ${loyalty?.points}`);
  // Alice's loyalty points: 25  (250 / 10)

  await unbridge();
  await store.stop();
}

main();
```

### Why This Works Safely

The bridge is configured with `filter: (event) => event.bucket === 'orders'`. The loyalty update triggered by the rule produces a `bucket.loyalty.updated` event, but the filter blocks it from reaching the rule engine. No loop.

## Preventing Infinite Loops

The most dangerous aspect of bidirectional integration is the feedback loop. A rule action mutates the store, which emits an event, which triggers the rule again, which mutates the store — forever.

### Strategy 1: Filter by Bucket

The simplest prevention is to filter the bridge so only specific "source" buckets reach the rule engine. "Target" buckets (written by rule actions) are excluded:

```text
  Source Buckets          Target Buckets
  (events forwarded)      (events NOT forwarded)
  ┌──────────────┐        ┌──────────────┐
  │ orders       │ ──────>│ loyalty      │
  │ users        │        │ audit        │
  │ inventory    │        │ notifications│
  └──────────────┘        └──────────────┘
```

```typescript
const sourceBuckets = new Set(['orders', 'users', 'inventory']);

const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  filter: (event) => sourceBuckets.has(event.bucket),
});
```

Rule actions write to `loyalty`, `audit`, `notifications` — those events never reach the rule engine.

### Strategy 2: Filter by Event Content

When a rule action updates a source bucket (e.g., updating an order's `status`), you need a content-based guard to prevent re-triggering:

```typescript
rules.push({
  pattern: /^bucket\.orders\.updated$/,
  handler: async (_topic, data) => {
    const event = data as unknown as BucketEvent;
    if (event.type !== 'updated') return;

    const { oldRecord, newRecord } = event;

    // Guard: only react to status changes, not other fields
    if (oldRecord.status === newRecord.status) return;

    // Guard: only react to specific transitions
    if (newRecord.status !== 'shipped') return;

    // Safe to proceed — this action updates the loyalty bucket, not orders
    // ...
  },
});
```

The guard condition ensures the rule only fires for the specific state transition it cares about. Even if the loyalty update somehow produced an orders event (it won't in this example), the guard would prevent re-entry because the status wouldn't have changed.

### Strategy 3: Separate Bridge Instances

For complex systems, use multiple bridges with different filters:

```typescript
// Bridge 1: Order events → order rules
const unbridgeOrders = await bridgeStoreToRules(store, orderRuleEngine, {
  filter: (event) => event.bucket === 'orders',
});

// Bridge 2: Inventory events → inventory rules
const unbridgeInventory = await bridgeStoreToRules(store, inventoryRuleEngine, {
  filter: (event) => event.bucket === 'inventory',
});

// Each rule engine only sees events from its domain
// Each writes to different target buckets
```

## Pattern: Derived Data

Rules can compute derived values and store them in a dedicated bucket. The derived bucket is always consistent because it's updated in response to every relevant change.

### Example: Order Statistics per User

```typescript
await store.defineBucket('userStats', {
  key: 'userId',
  schema: {
    userId:     { type: 'string', required: true },
    orderCount: { type: 'number', default: 0 },
    totalSpent: { type: 'number', default: 0 },
    lastOrder:  { type: 'number', default: 0 },
  },
});

const statsBucket = store.bucket('userStats');

// Rule: Maintain running statistics for each user
rules.push({
  pattern: /^bucket\.orders\.inserted$/,
  handler: async (_topic, data) => {
    const event = data as unknown as BucketEvent;
    if (event.type !== 'inserted') return;

    const userId = event.record.userId as string;
    const total = event.record.total as number;

    const existing = await statsBucket.get(userId);
    if (existing) {
      await statsBucket.update(userId, {
        orderCount: (existing.orderCount as number) + 1,
        totalSpent: (existing.totalSpent as number) + total,
        lastOrder: Date.now(),
      });
    } else {
      await statsBucket.insert({
        userId,
        orderCount: 1,
        totalSpent: total,
        lastOrder: Date.now(),
      });
    }
  },
});
```

The `userStats` bucket is always up to date — every order insert triggers a recalculation. Because the bridge filters out `userStats` events, there's no feedback loop.

## Pattern: Cross-Bucket Consistency with Transactions

When a rule action must update multiple buckets atomically, use a transaction inside the action handler:

```typescript
await store.defineBucket('inventory', {
  key: 'sku',
  schema: {
    sku:      { type: 'string', required: true },
    quantity: { type: 'number', required: true, min: 0 },
    reorder:  { type: 'boolean', default: false },
  },
});

await store.defineBucket('reorderRequests', {
  key: 'id',
  schema: {
    id:        { type: 'number', generated: 'autoincrement' },
    sku:       { type: 'string', required: true },
    quantity:  { type: 'number', required: true },
    createdAt: { type: 'number', generated: 'timestamp' },
  },
});

// Rule: When stock falls below threshold, flag for reorder and create request
rules.push({
  pattern: /^bucket\.inventory\.updated$/,
  handler: async (_topic, data) => {
    const event = data as unknown as BucketEvent;
    if (event.type !== 'updated') return;

    const { newRecord } = event;
    const quantity = newRecord.quantity as number;
    const alreadyFlagged = newRecord.reorder as boolean;

    // Guard: only trigger when crossing the threshold downward
    if (quantity >= 10 || alreadyFlagged) return;

    const sku = event.key as string;

    // Atomic: flag inventory AND create reorder request
    await store.transaction(async (tx) => {
      const inv = await tx.bucket('inventory');
      const req = await tx.bucket('reorderRequests');

      await inv.update(sku, { reorder: true });
      await req.insert({ sku, quantity: 100 });
    });
  },
});
```

The transaction ensures that the `reorder` flag and the reorder request are created together. If either fails, both roll back. The `alreadyFlagged` guard prevents the rule from firing again when the `reorder: true` update itself produces an event.

## Tracing the Full Cycle

For debugging, it helps to trace the complete path of an event through the system. Add a global listener and logging in the rule engine:

```typescript
// Trace store events
await store.on<BucketEvent>('bucket.*.*', (event, topic) => {
  console.log(`[store] ${topic} key=${String(event.key)}`);
});

// Trace rule execution
const tracingRuleEngine: EventReceiver = {
  async emit(topic, data) {
    console.log(`[bridge→rules] ${topic}`);
    // Forward to actual rule engine
    await ruleEngine.emit(topic, data);
  },
};

const unbridge = await bridgeStoreToRules(store, tracingRuleEngine, {
  filter: (event) => event.bucket === 'orders',
});

// Trigger a scenario
await ordersBucket.insert({ userId: 'alice', total: 100 });
await ordersBucket.update(1, { status: 'shipped' });

// Output:
// [store] bucket.orders.inserted key=1
// [bridge→rules] bucket.orders.inserted
// [store] bucket.orders.updated key=1
// [bridge→rules] bucket.orders.updated
// [store] bucket.loyalty.inserted key=alice    ← rule action wrote back
```

The trace shows exactly where each event originated and what rule actions it triggered.

## Complete Working Example

A mini e-commerce system with orders, inventory, and loyalty — all coordinated through the bridge:

```typescript
import { Store, bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'ecommerce' });

  // --- Define buckets ---

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:     { type: 'number', generated: 'autoincrement' },
      userId: { type: 'string', required: true },
      sku:    { type: 'string', required: true },
      qty:    { type: 'number', required: true, min: 1 },
      total:  { type: 'number', required: true, min: 0 },
      status: { type: 'string', enum: ['pending', 'confirmed', 'shipped'], default: 'pending' },
    },
    indexes: ['userId', 'status'],
  });

  await store.defineBucket('inventory', {
    key: 'sku',
    schema: {
      sku:      { type: 'string', required: true },
      name:     { type: 'string', required: true },
      quantity: { type: 'number', required: true, min: 0 },
    },
  });

  await store.defineBucket('loyalty', {
    key: 'userId',
    schema: {
      userId: { type: 'string', required: true },
      points: { type: 'number', default: 0, min: 0 },
    },
  });

  const ordersBucket = store.bucket('orders');
  const inventoryBucket = store.bucket('inventory');
  const loyaltyBucket = store.bucket('loyalty');

  // --- Mock rule engine ---
  type RuleHandler = (topic: string, data: Record<string, unknown>) => void;
  const ruleHandlers: Array<{ pattern: RegExp; handler: RuleHandler }> = [];

  const ruleEngine: EventReceiver = {
    async emit(topic, data) {
      for (const rule of ruleHandlers) {
        if (rule.pattern.test(topic)) {
          rule.handler(topic, data);
        }
      }
    },
  };

  // --- Rule 1: Deduct inventory when order is confirmed ---
  ruleHandlers.push({
    pattern: /^bucket\.orders\.updated$/,
    handler: async (_topic, data) => {
      const event = data as unknown as BucketEvent;
      if (event.type !== 'updated') return;
      if (event.oldRecord.status === 'confirmed') return;
      if (event.newRecord.status !== 'confirmed') return;

      const sku = event.newRecord.sku as string;
      const qty = event.newRecord.qty as number;

      const item = await inventoryBucket.get(sku);
      if (item) {
        const newQty = Math.max(0, (item.quantity as number) - qty);
        await inventoryBucket.update(sku, { quantity: newQty });
      }
    },
  });

  // --- Rule 2: Award loyalty points when order is shipped ---
  ruleHandlers.push({
    pattern: /^bucket\.orders\.updated$/,
    handler: async (_topic, data) => {
      const event = data as unknown as BucketEvent;
      if (event.type !== 'updated') return;
      if (event.oldRecord.status === 'shipped') return;
      if (event.newRecord.status !== 'shipped') return;

      const userId = event.newRecord.userId as string;
      const points = Math.floor((event.newRecord.total as number) / 10);

      const existing = await loyaltyBucket.get(userId);
      if (existing) {
        await loyaltyBucket.update(userId, {
          points: (existing.points as number) + points,
        });
      } else {
        await loyaltyBucket.insert({ userId, points });
      }
    },
  });

  // --- Bridge: only forward order events ---
  const unbridge = await bridgeStoreToRules(store, ruleEngine, {
    filter: (event) => event.bucket === 'orders',
  });

  // --- Seed inventory ---
  await inventoryBucket.insert({ sku: 'LAPTOP-1', name: 'Pro Laptop', quantity: 50 });
  await inventoryBucket.insert({ sku: 'MOUSE-1', name: 'Wireless Mouse', quantity: 200 });

  // --- Simulate order lifecycle ---
  const order1 = await ordersBucket.insert({
    userId: 'alice', sku: 'LAPTOP-1', qty: 2, total: 2598,
  });
  const order2 = await ordersBucket.insert({
    userId: 'alice', sku: 'MOUSE-1', qty: 5, total: 150,
  });

  // Confirm orders → triggers inventory deduction
  await ordersBucket.update(order1.id, { status: 'confirmed' });
  await ordersBucket.update(order2.id, { status: 'confirmed' });

  // Ship orders → triggers loyalty points
  await ordersBucket.update(order1.id, { status: 'shipped' });
  await ordersBucket.update(order2.id, { status: 'shipped' });

  // Wait for async rule processing
  await new Promise((resolve) => setTimeout(resolve, 200));

  // --- Verify results ---
  const laptop = await inventoryBucket.get('LAPTOP-1');
  console.log(`Laptop stock: ${laptop?.quantity}`);
  // Laptop stock: 48  (50 - 2)

  const mouse = await inventoryBucket.get('MOUSE-1');
  console.log(`Mouse stock: ${mouse?.quantity}`);
  // Mouse stock: 195  (200 - 5)

  const aliceLoyalty = await loyaltyBucket.get('alice');
  console.log(`Alice loyalty: ${aliceLoyalty?.points} points`);
  // Alice loyalty: 274 points  (259 + 15)

  await unbridge();
  await store.stop();
}

main();
```

## Exercise

You're building a user account system. When a user is deleted, all their orders should be archived (moved to an `archivedOrders` bucket) and their session should be cleared.

Given this setup:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    userId:   { type: 'string', required: true },
    total:    { type: 'number', required: true, min: 0 },
  },
  indexes: ['userId'],
});

await store.defineBucket('archivedOrders', {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    userId:     { type: 'string', required: true },
    total:      { type: 'number', required: true, min: 0 },
    archivedAt: { type: 'number', generated: 'timestamp' },
  },
  indexes: ['userId'],
});

await store.defineBucket('sessions', {
  key: 'userId',
  schema: {
    userId: { type: 'string', required: true },
    token:  { type: 'string', required: true },
  },
});
```

1. Create a mock rule engine with an `emit` method
2. Write a rule that triggers when a user is deleted
3. The rule should: find all orders for that user, insert each into `archivedOrders`, delete each from `orders`, and delete the user's session — all within a transaction
4. Bridge only `users` bucket events
5. Test by creating a user with two orders and a session, then deleting the user

<details>
<summary>Solution</summary>

```typescript
import { bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

const ordersBucket = store.bucket('orders');
const archivedBucket = store.bucket('archivedOrders');
const sessionsBucket = store.bucket('sessions');
const usersBucket = store.bucket('users');

type RuleHandler = (topic: string, data: Record<string, unknown>) => void;
const rules: Array<{ pattern: RegExp; handler: RuleHandler }> = [];

// 1. Mock rule engine
const ruleEngine: EventReceiver = {
  async emit(topic, data) {
    for (const rule of rules) {
      if (rule.pattern.test(topic)) {
        rule.handler(topic, data);
      }
    }
  },
};

// 2. Rule: on user deleted, archive orders and clear session
rules.push({
  pattern: /^bucket\.users\.deleted$/,
  handler: async (_topic, data) => {
    const event = data as unknown as BucketEvent;
    if (event.type !== 'deleted') return;

    const userId = event.key as string;

    // 3. Transaction: archive orders + delete session
    await store.transaction(async (tx) => {
      const txOrders = await tx.bucket('orders');
      const txArchive = await tx.bucket('archivedOrders');
      const txSessions = await tx.bucket('sessions');

      // Find all orders for this user
      const userOrders = await txOrders.where({ userId });

      // Archive each order
      for (const order of userOrders) {
        await txArchive.insert({
          userId: order.userId,
          total: order.total,
        });
        await txOrders.delete(order.id);
      }

      // Clear session
      await txSessions.delete(userId);
    });
  },
});

// 4. Bridge only user events
const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  filter: (event) => event.bucket === 'users',
});

// 5. Test
const alice = await usersBucket.insert({ name: 'Alice' });
const aliceId = alice.id as string;

await ordersBucket.insert({ userId: aliceId, total: 100 });
await ordersBucket.insert({ userId: aliceId, total: 250 });
await sessionsBucket.insert({ userId: aliceId, token: 'tok_abc123' });

// Delete Alice — triggers the rule
await usersBucket.delete(aliceId);

// Wait for async processing
await new Promise((resolve) => setTimeout(resolve, 200));

// Verify
const remainingOrders = await ordersBucket.where({ userId: aliceId });
console.log(`Active orders: ${remainingOrders.length}`);     // 0

const archived = await archivedBucket.where({ userId: aliceId });
console.log(`Archived orders: ${archived.length}`);           // 2

const session = await sessionsBucket.get(aliceId);
console.log(`Session exists: ${session !== undefined}`);      // false

await unbridge();
```

The transaction ensures atomicity: if archiving any order fails, the session isn't deleted and already-archived orders are rolled back. The bridge filter on `users` means the `orders`, `archivedOrders`, and `sessions` mutations don't trigger any rules — no loop.

</details>

## Summary

- The bridge (`bridgeStoreToRules`) handles **store → rules** direction; rule actions call store methods directly for **rules → store**
- Structure the system in three layers: **Data** (store buckets), **Logic** (rule engine), **Side Effects** (action handlers) — each layer only knows about the one below it
- **Prevent infinite loops** by filtering the bridge to forward only source bucket events, using guard conditions in rule handlers, or running separate bridge instances per domain
- **Cascading updates** work safely when rule actions write to target buckets that the bridge doesn't forward
- Use **transactions** in rule action handlers when an action must update multiple buckets atomically
- **Derived data** buckets (statistics, aggregations) stay consistent because rules update them on every relevant change
- **Guard conditions** in rule handlers (checking specific field transitions, flags, or thresholds) are the primary defense against re-triggering
- Add **tracing** with a wrapper `EventReceiver` and `store.on('bucket.*.*')` to debug the full event cycle
- The store remains **decoupled** from the rule engine — it never imports or references rules, making both independently testable

## API Reference

- [Rules Bridge](../../reference/bridge.md) — bidirectional integration, event mapping, loop prevention
- [Events](../../reference/events.md) — event types forwarded to the rule engine

---

Next: [Task Management](../12-projects/01-task-management.md)
