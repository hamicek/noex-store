# Inventory with Rules

You have learned how the store manages data, how transactions guarantee atomicity, how events propagate changes, how persistence survives restarts, and how the bridge forwards mutations to a rule engine. Now you will combine every one of these features into a single application — an inventory management system where stock changes trigger business rules, orders are fulfilled atomically, audit trails capture every mutation, and a reactive dashboard monitors the entire warehouse in real time.

By the end, you will have a runnable project that exercises the full integration surface of noex-store in a realistic warehouse scenario.

## What You'll Learn

- How to model an inventory domain with products, orders, reorder requests, and audit logs
- How to use `bridgeStoreToRules()` to trigger business logic when stock levels change
- How to fulfill orders atomically with transactions across multiple buckets
- How to build an audit trail using the event system and a bounded `maxSize` bucket
- How to persist critical data while keeping transient buckets ephemeral
- How to wire a reactive dashboard that reflects every mutation in real time

## Schema Design

An inventory system needs four buckets: products that track stock levels, orders placed against those products, reorder requests generated automatically by business rules, and an audit log that captures every mutation for compliance.

### Products

```typescript
import { Store, bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

const store = await Store.start({ name: 'inventory-system' });

await store.defineBucket('products', {
  key: 'sku',
  schema: {
    sku:          { type: 'string', required: true, minLength: 1, maxLength: 30 },
    name:         { type: 'string', required: true, minLength: 1, maxLength: 100 },
    quantity:     { type: 'number', required: true, min: 0 },
    reorderLevel: { type: 'number', required: true, min: 0 },
    price:        { type: 'number', required: true, min: 0 },
    category:     { type: 'string', required: true },
  },
  indexes: ['category'],
});
```

Key decisions:

- **`sku` as natural key** — SKU codes are unique by definition. No generated ID needed.
- **`reorderLevel`** stores the threshold below which the rule engine creates a reorder request. Each product defines its own threshold rather than using a global constant.
- **`category` index** enables per-category reporting without scanning every product.
- **`min: 0`** on `quantity` and `price` prevents negative stock and negative prices at the schema level.

### Orders

```typescript
await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    sku:       { type: 'string', required: true },
    quantity:  { type: 'number', required: true, min: 1 },
    total:     { type: 'number', required: true, min: 0 },
    status:    { type: 'string', enum: ['pending', 'fulfilled', 'cancelled'], default: 'pending' },
    createdAt: { type: 'date', generated: 'timestamp' },
  },
  indexes: ['sku', 'status'],
});
```

Key decisions:

- **`min: 1`** on `quantity` prevents zero-quantity orders at the schema level.
- **`status` enum** restricts order lifecycle to three valid states. The schema rejects any other value.
- **`sku` index** enables fast lookups for "all orders for product X".
- **`total`** is pre-computed at order creation (`quantity * price`) rather than recalculated on every read.

### Reorder Requests

```typescript
await store.defineBucket('reorderRequests', {
  key: 'id',
  schema: {
    id:        { type: 'number', generated: 'autoincrement' },
    sku:       { type: 'string', required: true },
    quantity:  { type: 'number', required: true, min: 1 },
    reason:    { type: 'string', required: true },
    status:    { type: 'string', enum: ['open', 'ordered', 'received'], default: 'open' },
    createdAt: { type: 'date', generated: 'timestamp' },
  },
  indexes: ['sku', 'status'],
});
```

Key decisions:

- **`autoincrement` key** provides sequential IDs for easy reference in purchase orders.
- **`reason`** records why the reorder was triggered (e.g., "Stock fell below reorder level of 20").
- **`status` lifecycle** tracks the reorder through three stages: open (created by rule), ordered (PO sent), received (stock replenished).

### Audit Log

```typescript
await store.defineBucket('auditLog', {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'cuid' },
    bucket:    { type: 'string', required: true },
    action:    { type: 'string', required: true },
    key:       { type: 'string', required: true },
    detail:    { type: 'string', default: '' },
    createdAt: { type: 'date', generated: 'timestamp' },
  },
  maxSize: 200,
});
```

Key decisions:

- **`maxSize: 200`** caps the audit log at 200 entries. Oldest entries are evicted automatically — a bounded buffer that never grows unbounded.
- **No persistence** needed for the audit log — it's a runtime diagnostic tool. Critical audit data would go to an external system in production.
- **`detail`** stores a human-readable description of what changed, built by the event handler.

### Entity Relationship

```text
  +-------------+       +-------------+       +------------------+
  |  products   |       |   orders    |       | reorderRequests  |
  |-------------|       |-------------|       |------------------|
  | sku (key)   |<------| sku         |       | id (autoincr)    |
  | name        |       | id (uuid)   |       | sku              |
  | quantity    |<------| quantity    |       | quantity         |
  | reorderLevel|       | total       |       | reason           |
  | price       |       | status      |       | status           |
  | category    |       | createdAt   |       | createdAt        |
  +------+------+       +-------------+       +------------------+
         |                                            ^
         |  stock falls below reorderLevel            |
         +-- (rule engine) ---------------------------+

  +-------------+
  |  auditLog   |
  |-------------|
  | id (cuid)   |       Captures every mutation across all buckets.
  | bucket      |       Bounded to 200 entries (maxSize).
  | action      |
  | key         |
  | detail      |
  | createdAt   |
  +-------------+
```

## Bucket Handles

After defining all buckets, grab handles:

```typescript
const products = store.bucket('products');
const orders = store.bucket('orders');
const reorderRequests = store.bucket('reorderRequests');
const auditLog = store.bucket('auditLog');
```

## Audit Trail via Events

Before wiring the rule engine, set up the audit trail. Every mutation on `products` and `orders` is recorded in the audit log:

```typescript
await store.on<BucketEvent>('bucket.products.*', (event, topic) => {
  const action = topic.split('.')[2]!;

  let detail = '';
  if (event.type === 'inserted') {
    detail = `Added product "${event.record.name}" with ${event.record.quantity} units`;
  } else if (event.type === 'updated') {
    const changes: string[] = [];
    if (event.oldRecord.quantity !== event.newRecord.quantity) {
      changes.push(`qty: ${event.oldRecord.quantity} → ${event.newRecord.quantity}`);
    }
    if (event.oldRecord.price !== event.newRecord.price) {
      changes.push(`price: ${event.oldRecord.price} → ${event.newRecord.price}`);
    }
    detail = changes.length > 0 ? changes.join(', ') : 'metadata updated';
  } else if (event.type === 'deleted') {
    detail = `Removed product "${event.record.name}"`;
  }

  auditLog.insert({
    bucket: 'products',
    action,
    key: String(event.key),
    detail,
  });
});

await store.on<BucketEvent>('bucket.orders.*', (event, topic) => {
  const action = topic.split('.')[2]!;

  let detail = '';
  if (event.type === 'inserted') {
    detail = `Order for ${event.record.quantity}x ${event.record.sku}, total: $${event.record.total}`;
  } else if (event.type === 'updated') {
    detail = `Status: ${event.oldRecord.status} → ${event.newRecord.status}`;
  }

  auditLog.insert({
    bucket: 'orders',
    action,
    key: String(event.key),
    detail,
  });
});
```

The event handlers run asynchronously — they don't block the mutation that triggered them. The `maxSize: 200` cap ensures the audit log never grows unbounded, and the oldest entries are evicted silently.

## Rule Engine: Automatic Reorder

The rule engine watches for product updates and creates reorder requests when stock drops below the product's `reorderLevel`. This is the bridge in action — store mutations drive business logic without the store knowing anything about rules.

```typescript
// Mock rule engine — in production, this would be @hamicek/noex-rules
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

// Rule: When product quantity drops below reorderLevel, create a reorder request
rules.push({
  pattern: /^bucket\.products\.updated$/,
  handler: async (_topic, data) => {
    const event = data as unknown as BucketEvent;
    if (event.type !== 'updated') return;

    const { oldRecord, newRecord } = event;
    const oldQty = oldRecord.quantity as number;
    const newQty = newRecord.quantity as number;
    const reorderLevel = newRecord.reorderLevel as number;

    // Guard: only trigger when crossing the threshold downward
    if (newQty >= reorderLevel) return;
    if (oldQty < reorderLevel) return; // Already below — don't re-trigger

    const sku = event.key as string;
    const reorderQty = reorderLevel * 3; // Order 3x the reorder level

    await reorderRequests.insert({
      sku,
      quantity: reorderQty,
      reason: `Stock fell below reorder level of ${reorderLevel} (current: ${newQty})`,
    });
  },
});
```

### Guard Conditions

The rule has two guards that prevent infinite loops and duplicate reorders:

1. **`newQty >= reorderLevel`** — If stock is still above the threshold, skip. This handles updates to non-quantity fields (e.g., price changes).
2. **`oldQty < reorderLevel`** — If stock was already below the threshold before this update, skip. This prevents re-triggering on subsequent updates while stock remains low.

Together, these guards ensure the rule fires exactly once: the moment stock crosses the threshold downward.

### Wire the Bridge

```typescript
const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  // Only forward product mutations — reorderRequests and auditLog events are excluded
  filter: (event) => event.bucket === 'products',

  // Simplify topics for the rule engine
  mapTopic: (_topic, event) => `${event.bucket}.${event.type}`,
});
```

The bridge filter is the primary defense against infinite loops. Rule actions write to `reorderRequests` and `auditLog`, but those events never reach the rule engine because the filter only passes `products` events.

```text
  Source Buckets          Target Buckets
  (events forwarded)      (events NOT forwarded)
  ┌──────────────┐        ┌──────────────────┐
  │ products     │ ──────>│ reorderRequests   │
  └──────────────┘        │ auditLog          │
                          │ orders            │
                          └──────────────────┘
```

## Seeding Data

Populate the warehouse with initial inventory:

```typescript
await products.insert({
  sku: 'LAPTOP-PRO', name: 'Pro Laptop', quantity: 50,
  reorderLevel: 15, price: 1299, category: 'electronics',
});
await products.insert({
  sku: 'MOUSE-WL', name: 'Wireless Mouse', quantity: 200,
  reorderLevel: 50, price: 29, category: 'electronics',
});
await products.insert({
  sku: 'DESK-STD', name: 'Standing Desk', quantity: 25,
  reorderLevel: 10, price: 599, category: 'furniture',
});
await products.insert({
  sku: 'CHAIR-ERG', name: 'Ergonomic Chair', quantity: 12,
  reorderLevel: 8, price: 449, category: 'furniture',
});
```

## Fulfilling Orders with Transactions

Order fulfillment is the most critical operation. It must atomically: validate stock availability, deduct the product quantity, create the order record, and update the order status. If any step fails, nothing changes.

```typescript
async function fulfillOrder(sku: string, quantity: number) {
  return await store.transaction(async (tx) => {
    const txProducts = await tx.bucket('products');
    const txOrders = await tx.bucket('orders');

    // 1. Check stock
    const product = await txProducts.get(sku);
    if (product === undefined) {
      throw new Error(`Product ${sku} not found`);
    }

    const currentQty = product.quantity as number;
    if (currentQty < quantity) {
      throw new Error(
        `Insufficient stock for ${sku}: requested ${quantity}, available ${currentQty}`,
      );
    }

    // 2. Deduct stock
    await txProducts.update(sku, { quantity: currentQty - quantity });

    // 3. Create fulfilled order
    const order = await txOrders.insert({
      sku,
      quantity,
      total: quantity * (product.price as number),
      status: 'fulfilled',
    });

    return order;
  });
}
```

The transaction guarantees that stock deduction and order creation happen together. If the insert fails (e.g., schema validation), the stock deduction is rolled back. The deducted stock also triggers the product `updated` event, which flows through the bridge to the rule engine.

### Cancelling an Order

Cancellation reverses the stock deduction — again, atomically:

```typescript
async function cancelOrder(orderId: string) {
  await store.transaction(async (tx) => {
    const txProducts = await tx.bucket('products');
    const txOrders = await tx.bucket('orders');

    const order = await txOrders.get(orderId);
    if (order === undefined) {
      throw new Error(`Order ${orderId} not found`);
    }
    if (order.status !== 'fulfilled') {
      throw new Error(`Cannot cancel order with status "${order.status}"`);
    }

    // Restore stock
    const product = await txProducts.get(order.sku as string);
    if (product !== undefined) {
      await txProducts.update(order.sku as string, {
        quantity: (product.quantity as number) + (order.quantity as number),
      });
    }

    // Mark as cancelled
    await txOrders.update(orderId, { status: 'cancelled' });
  });
}
```

### Receiving a Reorder

When a reorder shipment arrives, replenish stock and close the reorder request:

```typescript
async function receiveReorder(requestId: number) {
  await store.transaction(async (tx) => {
    const txProducts = await tx.bucket('products');
    const txRequests = await tx.bucket('reorderRequests');

    const request = await txRequests.get(requestId);
    if (request === undefined) {
      throw new Error(`Reorder request ${requestId} not found`);
    }
    if (request.status !== 'open') {
      throw new Error(`Request ${requestId} is already ${request.status}`);
    }

    // Replenish stock
    const product = await txProducts.get(request.sku as string);
    if (product !== undefined) {
      await txProducts.update(request.sku as string, {
        quantity: (product.quantity as number) + (request.quantity as number),
      });
    }

    // Close the request
    await txRequests.update(requestId, { status: 'received' });
  });
}
```

## Reactive Dashboard

Build a live warehouse dashboard that updates automatically on every stock change, order, or reorder.

### Define Queries

```typescript
// Warehouse overview — total products, total stock value, low-stock count
store.defineQuery('warehouseOverview', async (ctx) => {
  const p = ctx.bucket('products');

  const allProducts = await p.all();
  const totalValue = allProducts.reduce(
    (sum, item) => sum + (item.quantity as number) * (item.price as number),
    0,
  );
  const lowStock = allProducts.filter(
    (item) => (item.quantity as number) <= (item.reorderLevel as number),
  );

  return {
    productCount: allProducts.length,
    totalStockValue: totalValue,
    lowStockCount: lowStock.length,
    lowStockSkus: lowStock.map((item) => item.sku as string),
  };
});

// Order statistics
store.defineQuery('orderStats', async (ctx) => {
  const o = ctx.bucket('orders');

  const fulfilled = await o.count({ status: 'fulfilled' });
  const cancelled = await o.count({ status: 'cancelled' });
  const pending = await o.count({ status: 'pending' });
  const totalRevenue = await o.sum('total', { status: 'fulfilled' });

  return { fulfilled, cancelled, pending, totalRevenue };
});

// Open reorder requests
store.defineQuery('openReorders', async (ctx) => {
  const r = ctx.bucket('reorderRequests');
  const open = await r.where({ status: 'open' });

  return open.map((req) => ({
    id: req.id as number,
    sku: req.sku as string,
    quantity: req.quantity as number,
    reason: req.reason as string,
  }));
});
```

### Subscribe to Live Updates

```typescript
const initialOverview = await store.runQuery<{
  productCount: number;
  totalStockValue: number;
  lowStockCount: number;
  lowStockSkus: string[];
}>('warehouseOverview');

console.log('Warehouse:', initialOverview);
// Warehouse: { productCount: 4, totalStockValue: 89477, lowStockCount: 0, lowStockSkus: [] }

const unsubOverview = await store.subscribe<{
  productCount: number;
  totalStockValue: number;
  lowStockCount: number;
  lowStockSkus: string[];
}>('warehouseOverview', (overview) => {
  console.log(`[Warehouse] products=${overview.productCount} value=$${overview.totalStockValue} low=${overview.lowStockCount}`);
});

const unsubOrders = await store.subscribe<{
  fulfilled: number;
  cancelled: number;
  pending: number;
  totalRevenue: number;
}>('orderStats', (stats) => {
  console.log(`[Orders] fulfilled=${stats.fulfilled} revenue=$${stats.totalRevenue}`);
});

const unsubReorders = await store.subscribe<
  { id: number; sku: string; quantity: number; reason: string }[]
>('openReorders', (open) => {
  if (open.length > 0) {
    console.log(`[Reorders] ${open.length} open requests:`);
    for (const req of open) {
      console.log(`  #${req.id} ${req.sku} x${req.quantity} — ${req.reason}`);
    }
  }
});
```

## Running the Full Scenario

Now trigger the complete lifecycle — orders drain stock, rules create reorder requests, cancellations restore stock, and reorder receipts replenish inventory:

```typescript
// --- Fulfill orders ---
const order1 = await fulfillOrder('LAPTOP-PRO', 38);
await store.settle();
// [Warehouse] products=4 value=$40111 low=0 ...
// [Orders] fulfilled=1 revenue=$49362

// This order pushes laptops below reorderLevel (15)
const order2 = await fulfillOrder('LAPTOP-PRO', 5);
await store.settle();
// [Warehouse] products=4 value=$33616 low=1 ...
// [Orders] fulfilled=2 revenue=$55857
// [Reorders] 1 open requests:
//   #1 LAPTOP-PRO x45 — Stock fell below reorder level of 15 (current: 7)

// The rule engine detected stock crossing below 15 and created a reorder request

// --- Cancel an order — stock is restored ---
await cancelOrder(order1.id as string);
await store.settle();
// [Warehouse] products=4 value=$82978 low=0 ...
// [Orders] fulfilled=1 revenue=$6495

// --- Receive the reorder shipment ---
await receiveReorder(1);
await store.settle();
// [Warehouse] products=4 value=$141433 low=0 ...

// --- Check the audit trail ---
const recentAudit = await auditLog.all();
console.log(`\nAudit log (${recentAudit.length} entries):`);
for (const entry of recentAudit.slice(-6)) {
  console.log(`  [${entry.bucket}] ${entry.action} ${entry.key}: ${entry.detail}`);
}
```

The complete flow:

```text
  fulfillOrder(38)
    │
    ├── products.update(LAPTOP-PRO, qty: 50→12)
    │     ├── auditLog.insert(qty: 50 → 12)       ← event handler
    │     └── bridge → ruleEngine                   ← still above reorderLevel
    │
    └── orders.insert(fulfilled)
          └── auditLog.insert(Order for 38x ...)    ← event handler

  fulfillOrder(5)
    │
    ├── products.update(LAPTOP-PRO, qty: 12→7)
    │     ├── auditLog.insert(qty: 12 → 7)         ← event handler
    │     └── bridge → ruleEngine
    │           └── reorderRequests.insert(45 units) ← RULE FIRED (crossed threshold)
    │
    └── orders.insert(fulfilled)
          └── auditLog.insert(Order for 5x ...)     ← event handler

  cancelOrder(order1)
    │
    ├── products.update(LAPTOP-PRO, qty: 7→45)
    │     ├── auditLog.insert(qty: 7 → 45)         ← event handler
    │     └── bridge → ruleEngine                   ← qty went UP, guard skips
    │
    └── orders.update(status: fulfilled→cancelled)
          └── auditLog.insert(Status: ...)          ← event handler

  receiveReorder(1)
    │
    ├── products.update(LAPTOP-PRO, qty: 45→90)
    │     └── auditLog.insert(qty: 45 → 90)        ← event handler
    │
    └── reorderRequests.update(status: open→received)
```

## Complete Working Example

```typescript
import { Store, bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'inventory' });

  // --- Schema definitions ---

  await store.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:          { type: 'string', required: true, minLength: 1, maxLength: 30 },
      name:         { type: 'string', required: true, minLength: 1, maxLength: 100 },
      quantity:     { type: 'number', required: true, min: 0 },
      reorderLevel: { type: 'number', required: true, min: 0 },
      price:        { type: 'number', required: true, min: 0 },
      category:     { type: 'string', required: true },
    },
    indexes: ['category'],
  });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      sku:       { type: 'string', required: true },
      quantity:  { type: 'number', required: true, min: 1 },
      total:     { type: 'number', required: true, min: 0 },
      status:    { type: 'string', enum: ['pending', 'fulfilled', 'cancelled'], default: 'pending' },
      createdAt: { type: 'date', generated: 'timestamp' },
    },
    indexes: ['sku', 'status'],
  });

  await store.defineBucket('reorderRequests', {
    key: 'id',
    schema: {
      id:        { type: 'number', generated: 'autoincrement' },
      sku:       { type: 'string', required: true },
      quantity:  { type: 'number', required: true, min: 1 },
      reason:    { type: 'string', required: true },
      status:    { type: 'string', enum: ['open', 'ordered', 'received'], default: 'open' },
      createdAt: { type: 'date', generated: 'timestamp' },
    },
    indexes: ['sku', 'status'],
  });

  await store.defineBucket('auditLog', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'cuid' },
      bucket:    { type: 'string', required: true },
      action:    { type: 'string', required: true },
      key:       { type: 'string', required: true },
      detail:    { type: 'string', default: '' },
      createdAt: { type: 'date', generated: 'timestamp' },
    },
    maxSize: 200,
  });

  const productsBucket = store.bucket('products');
  const ordersBucket = store.bucket('orders');
  const reorderBucket = store.bucket('reorderRequests');
  const auditBucket = store.bucket('auditLog');

  // --- Audit trail via events ---

  await store.on<BucketEvent>('bucket.products.*', (event, topic) => {
    const action = topic.split('.')[2]!;
    let detail = '';
    if (event.type === 'updated') {
      const changes: string[] = [];
      if (event.oldRecord.quantity !== event.newRecord.quantity) {
        changes.push(`qty: ${event.oldRecord.quantity} → ${event.newRecord.quantity}`);
      }
      detail = changes.length > 0 ? changes.join(', ') : 'metadata updated';
    } else if (event.type === 'inserted') {
      detail = `Added "${event.record.name}" with ${event.record.quantity} units`;
    }
    auditBucket.insert({ bucket: 'products', action, key: String(event.key), detail });
  });

  await store.on<BucketEvent>('bucket.orders.*', (event, topic) => {
    const action = topic.split('.')[2]!;
    let detail = '';
    if (event.type === 'inserted') {
      detail = `${event.record.quantity}x ${event.record.sku}, total: $${event.record.total}`;
    } else if (event.type === 'updated') {
      detail = `Status: ${event.oldRecord.status} → ${event.newRecord.status}`;
    }
    auditBucket.insert({ bucket: 'orders', action, key: String(event.key), detail });
  });

  // --- Rule engine ---

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

  // Rule: Auto-reorder when stock crosses below reorderLevel
  ruleHandlers.push({
    pattern: /^products\.updated$/,
    handler: async (_topic, data) => {
      const event = data as unknown as BucketEvent;
      if (event.type !== 'updated') return;

      const oldQty = event.oldRecord.quantity as number;
      const newQty = event.newRecord.quantity as number;
      const reorderLevel = event.newRecord.reorderLevel as number;

      if (newQty >= reorderLevel) return;
      if (oldQty < reorderLevel) return;

      await reorderBucket.insert({
        sku: event.key as string,
        quantity: reorderLevel * 3,
        reason: `Stock fell below reorder level of ${reorderLevel} (current: ${newQty})`,
      });
    },
  });

  // Bridge: only products → rule engine
  const unbridge = await bridgeStoreToRules(store, ruleEngine, {
    filter: (event) => event.bucket === 'products',
    mapTopic: (_topic, event) => `${event.bucket}.${event.type}`,
  });

  // --- Helper functions ---

  async function fulfillOrder(sku: string, quantity: number) {
    return await store.transaction(async (tx) => {
      const txProducts = await tx.bucket('products');
      const txOrders = await tx.bucket('orders');

      const product = await txProducts.get(sku);
      if (product === undefined) throw new Error(`Product ${sku} not found`);

      const currentQty = product.quantity as number;
      if (currentQty < quantity) {
        throw new Error(`Insufficient stock for ${sku}: need ${quantity}, have ${currentQty}`);
      }

      await txProducts.update(sku, { quantity: currentQty - quantity });

      return await txOrders.insert({
        sku,
        quantity,
        total: quantity * (product.price as number),
        status: 'fulfilled',
      });
    });
  }

  async function cancelOrder(orderId: string) {
    await store.transaction(async (tx) => {
      const txProducts = await tx.bucket('products');
      const txOrders = await tx.bucket('orders');

      const order = await txOrders.get(orderId);
      if (order === undefined) throw new Error(`Order ${orderId} not found`);
      if (order.status !== 'fulfilled') {
        throw new Error(`Cannot cancel order with status "${order.status}"`);
      }

      const product = await txProducts.get(order.sku as string);
      if (product !== undefined) {
        await txProducts.update(order.sku as string, {
          quantity: (product.quantity as number) + (order.quantity as number),
        });
      }

      await txOrders.update(orderId, { status: 'cancelled' });
    });
  }

  async function receiveReorder(requestId: number) {
    await store.transaction(async (tx) => {
      const txProducts = await tx.bucket('products');
      const txRequests = await tx.bucket('reorderRequests');

      const request = await txRequests.get(requestId);
      if (request === undefined) throw new Error(`Reorder ${requestId} not found`);
      if (request.status !== 'open') {
        throw new Error(`Request ${requestId} is already ${request.status}`);
      }

      const product = await txProducts.get(request.sku as string);
      if (product !== undefined) {
        await txProducts.update(request.sku as string, {
          quantity: (product.quantity as number) + (request.quantity as number),
        });
      }

      await txRequests.update(requestId, { status: 'received' });
    });
  }

  // --- Reactive queries ---

  store.defineQuery('warehouseOverview', async (ctx) => {
    const p = ctx.bucket('products');
    const allProducts = await p.all();
    const totalValue = allProducts.reduce(
      (sum, item) => sum + (item.quantity as number) * (item.price as number), 0,
    );
    const lowStock = allProducts.filter(
      (item) => (item.quantity as number) <= (item.reorderLevel as number),
    );
    return {
      productCount: allProducts.length,
      totalStockValue: totalValue,
      lowStockCount: lowStock.length,
      lowStockSkus: lowStock.map((item) => item.sku as string),
    };
  });

  store.defineQuery('orderStats', async (ctx) => {
    const o = ctx.bucket('orders');
    const fulfilled = await o.count({ status: 'fulfilled' });
    const cancelled = await o.count({ status: 'cancelled' });
    const pending = await o.count({ status: 'pending' });
    const totalRevenue = await o.sum('total', { status: 'fulfilled' });
    return { fulfilled, cancelled, pending, totalRevenue };
  });

  // --- Seed data ---

  await productsBucket.insert({
    sku: 'LAPTOP-PRO', name: 'Pro Laptop', quantity: 50,
    reorderLevel: 15, price: 1299, category: 'electronics',
  });
  await productsBucket.insert({
    sku: 'MOUSE-WL', name: 'Wireless Mouse', quantity: 200,
    reorderLevel: 50, price: 29, category: 'electronics',
  });
  await productsBucket.insert({
    sku: 'DESK-STD', name: 'Standing Desk', quantity: 25,
    reorderLevel: 10, price: 599, category: 'furniture',
  });

  // --- Subscribe to dashboard ---

  const overview = await store.runQuery<{
    productCount: number; totalStockValue: number;
    lowStockCount: number; lowStockSkus: string[];
  }>('warehouseOverview');

  console.log(`Products: ${overview.productCount}, Stock value: $${overview.totalStockValue}`);
  // Products: 3, Stock value: $85675

  const unsubOverview = await store.subscribe<{
    productCount: number; totalStockValue: number;
    lowStockCount: number; lowStockSkus: string[];
  }>('warehouseOverview', (o) => {
    console.log(`[Warehouse] value=$${o.totalStockValue} low=${o.lowStockCount}`);
  });

  const unsubOrders = await store.subscribe<{
    fulfilled: number; cancelled: number; pending: number; totalRevenue: number;
  }>('orderStats', (s) => {
    console.log(`[Orders] fulfilled=${s.fulfilled} revenue=$${s.totalRevenue}`);
  });

  // --- Scenario: fulfill, trigger rule, cancel, receive ---

  const order1 = await fulfillOrder('LAPTOP-PRO', 40);
  await store.settle();
  // [Warehouse] value=$... low=1
  // [Orders] fulfilled=1 revenue=$51960

  // Stock is at 10 — below reorderLevel of 15 → rule creates reorder request

  await cancelOrder(order1.id as string);
  await store.settle();
  // [Warehouse] value=$... low=0
  // [Orders] fulfilled=0 revenue=$0

  // Fulfill again to re-trigger the rule
  await fulfillOrder('LAPTOP-PRO', 40);
  await store.settle();

  // Receive the first reorder shipment
  await receiveReorder(1);
  await store.settle();

  // --- Audit trail ---

  const audit = await auditBucket.all();
  console.log(`\nAudit log: ${audit.length} entries`);
  for (const entry of audit.slice(-5)) {
    console.log(`  [${entry.bucket}] ${entry.action} ${entry.key}: ${entry.detail}`);
  }

  // --- Cleanup ---

  await unsubOverview();
  await unsubOrders();
  await unbridge();
  await store.stop();
}

main();
```

## Exercise

Build a "stock transfer" feature for a multi-warehouse system. Given the following store:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('warehouses', {
  key: 'id',
  schema: {
    id:   { type: 'string', required: true, minLength: 1 },
    name: { type: 'string', required: true },
  },
});

await store.defineBucket('stock', {
  key: 'id',
  schema: {
    id:          { type: 'string', generated: 'cuid' },
    warehouseId: { type: 'string', required: true },
    sku:         { type: 'string', required: true },
    quantity:    { type: 'number', required: true, min: 0 },
  },
  indexes: ['warehouseId', 'sku'],
});

await store.defineBucket('transfers', {
  key: 'id',
  schema: {
    id:          { type: 'number', generated: 'autoincrement' },
    fromId:      { type: 'string', required: true },
    toId:        { type: 'string', required: true },
    sku:         { type: 'string', required: true },
    quantity:    { type: 'number', required: true, min: 1 },
    createdAt:   { type: 'date', generated: 'timestamp' },
  },
});

await store.defineBucket('transferLog', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'cuid' },
    message: { type: 'string', required: true },
  },
  maxSize: 100,
});

const warehouses = store.bucket('warehouses');
const stock = store.bucket('stock');
const transfers = store.bucket('transfers');
const transferLog = store.bucket('transferLog');

// Seed
await warehouses.insert({ id: 'WH-A', name: 'Warehouse Alpha' });
await warehouses.insert({ id: 'WH-B', name: 'Warehouse Beta' });

await stock.insert({ warehouseId: 'WH-A', sku: 'WIDGET', quantity: 100 });
await stock.insert({ warehouseId: 'WH-B', sku: 'WIDGET', quantity: 20 });
```

Write the following:

1. A function `transferStock(fromId: string, toId: string, sku: string, qty: number)` that uses a **transaction** to atomically deduct from the source warehouse, add to the target warehouse, and create a transfer record. Throw if the source has insufficient stock.
2. An **event handler** on `bucket.transfers.inserted` that writes to `transferLog` with a descriptive message.
3. A **rule** (via `bridgeStoreToRules`) that watches `stock` updates and, when a warehouse's quantity drops below 10, logs a warning to `transferLog` (e.g., "Low stock: WIDGET at WH-A has 5 units"). Only forward `stock` bucket events through the bridge.
4. A reactive query `'warehouseStock'` that takes `{ warehouseId: string }` and returns `{ sku: string, quantity: number }[]`.
5. Subscribe to the query, perform a transfer, and verify the reactive callback fires.

<details>
<summary>Solution</summary>

```typescript
import { bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

// 1. Transfer function
async function transferStock(
  fromId: string,
  toId: string,
  sku: string,
  qty: number,
) {
  return await store.transaction(async (tx) => {
    const txStock = await tx.bucket('stock');
    const txTransfers = await tx.bucket('transfers');

    // Find source and target stock records
    const fromRecords = await txStock.where({ warehouseId: fromId, sku });
    const toRecords = await txStock.where({ warehouseId: toId, sku });

    if (fromRecords.length === 0) {
      throw new Error(`No ${sku} stock found in warehouse ${fromId}`);
    }

    const source = fromRecords[0]!;
    const sourceQty = source.quantity as number;

    if (sourceQty < qty) {
      throw new Error(
        `Insufficient stock: ${fromId} has ${sourceQty} ${sku}, need ${qty}`,
      );
    }

    // Deduct from source
    await txStock.update(source.id as string, { quantity: sourceQty - qty });

    // Add to target
    if (toRecords.length > 0) {
      const target = toRecords[0]!;
      await txStock.update(target.id as string, {
        quantity: (target.quantity as number) + qty,
      });
    } else {
      await txStock.insert({ warehouseId: toId, sku, quantity: qty });
    }

    // Create transfer record
    return await txTransfers.insert({ fromId, toId, sku, quantity: qty });
  });
}

// 2. Event handler for audit trail
await store.on<BucketEvent>('bucket.transfers.inserted', (event) => {
  if (event.type !== 'inserted') return;
  const r = event.record;
  transferLog.insert({
    message: `Transfer: ${r.quantity}x ${r.sku} from ${r.fromId} to ${r.toId}`,
  });
});

// 3. Rule engine for low stock warnings
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

rules.push({
  pattern: /^stock\.updated$/,
  handler: async (_topic, data) => {
    const event = data as unknown as BucketEvent;
    if (event.type !== 'updated') return;

    const newQty = event.newRecord.quantity as number;
    const oldQty = event.oldRecord.quantity as number;

    // Only trigger when crossing below 10
    if (newQty >= 10 || oldQty < 10) return;

    const sku = event.newRecord.sku as string;
    const warehouseId = event.newRecord.warehouseId as string;

    await transferLog.insert({
      message: `Low stock: ${sku} at ${warehouseId} has ${newQty} units`,
    });
  },
});

const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  filter: (event) => event.bucket === 'stock',
  mapTopic: (_topic, event) => `${event.bucket}.${event.type}`,
});

// 4. Reactive query
store.defineQuery('warehouseStock', async (ctx, params: { warehouseId: string }) => {
  const s = ctx.bucket('stock');
  const items = await s.where({ warehouseId: params.warehouseId });
  return items.map((item) => ({
    sku: item.sku as string,
    quantity: item.quantity as number,
  }));
});

// 5. Subscribe and test
const initial = await store.runQuery<{ sku: string; quantity: number }[]>(
  'warehouseStock', { warehouseId: 'WH-A' },
);
console.log('WH-A before:', initial);
// WH-A before: [ { sku: 'WIDGET', quantity: 100 } ]

const unsub = await store.subscribe<{ sku: string; quantity: number }[]>(
  'warehouseStock', { warehouseId: 'WH-A' }, (items) => {
    console.log('WH-A update:', items);
  },
);

// Transfer 95 widgets — triggers low stock warning
await transferStock('WH-A', 'WH-B', 'WIDGET', 95);
await store.settle();
// WH-A update: [ { sku: 'WIDGET', quantity: 5 } ]

// Wait for async event processing
await new Promise((resolve) => setTimeout(resolve, 100));

// Check transfer log
const logs = await transferLog.all();
for (const log of logs) {
  console.log(`  ${log.message}`);
}
// Transfer: 95x WIDGET from WH-A to WH-B
// Low stock: WIDGET at WH-A has 5 units

await unsub();
await unbridge();
await store.stop();
```

The transaction in `transferStock` ensures the source deduction, target addition, and transfer record are atomic. The event handler on `bucket.transfers.inserted` captures every transfer in the bounded log. The rule engine, reached via the bridge filtered to `stock` events only, detects when a warehouse crosses below the low-stock threshold. The reactive query automatically reflects the updated quantities.

</details>

## Summary

- **Schema design** with natural keys (`sku`), per-product `reorderLevel`, and pre-computed `total` keeps the domain model clean and avoids runtime calculations
- **`bridgeStoreToRules()`** with a bucket filter (`products` only) creates a one-way event flow from store to rule engine — target buckets (`reorderRequests`, `auditLog`) never re-enter the bridge, preventing infinite loops
- **Guard conditions** in rule handlers (checking both `oldQty < reorderLevel` and `newQty >= reorderLevel`) ensure each rule fires exactly once per threshold crossing
- **Transactions** guarantee atomicity for multi-bucket operations — `fulfillOrder` deducts stock and creates the order together, `cancelOrder` restores stock and updates status together, `receiveReorder` replenishes stock and closes the request together
- **`store.on('bucket.*.*')`** builds the audit trail by capturing every mutation as a structured log entry — the event handler runs asynchronously and never blocks the original mutation
- **`maxSize: 200`** on the audit log creates a bounded buffer that never grows unbounded — ideal for runtime diagnostics where only recent history matters
- **Reactive queries** (`warehouseOverview`, `orderStats`, `openReorders`) build a live dashboard that updates automatically on every stock change, order, or reorder without polling
- **`store.settle()`** ensures all reactive callbacks and event handlers have completed before verifying results — essential for deterministic test output
- The **three-layer architecture** (Data → Logic → Side Effects) keeps the store decoupled from business rules — the store never imports or references the rule engine, making both independently testable

---

Previous: [Real-Time Analytics](./02-realtime-analytics.md)
