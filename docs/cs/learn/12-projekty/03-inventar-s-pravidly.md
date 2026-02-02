# Inventář s pravidly

Naučili jste se, jak store spravuje data, jak transakce zaručují atomicitu, jak události propagují změny, jak persistence přežije restart a jak bridge přeposílá mutace do pravidlového enginu. Nyní zkombinujete všechny tyto funkce do jediné aplikace — systému správy inventáře, kde změny skladu spouštějí byznys pravidla, objednávky se plní atomicky, auditní stopy zachycují každou mutaci a reaktivní dashboard monitoruje celý sklad v reálném čase.

Na konci budete mít spustitelný projekt, který procvičí celou integrační plochu noex-store v realistickém skladovém scénáři.

## Co se naučíte

- Jak modelovat inventářovou doménu s produkty, objednávkami, požadavky na doobjednání a auditními logy
- Jak použít `bridgeStoreToRules()` ke spuštění byznys logiky při změně stavu zásob
- Jak plnit objednávky atomicky pomocí transakcí napříč více buckety
- Jak vybudovat auditní stopu pomocí systému událostí a omezeného bucketu s `maxSize`
- Jak persistovat kritická data a přitom ponechat přechodné buckety efemérní
- Jak napojit reaktivní dashboard, který odráží každou mutaci v reálném čase

## Návrh schémat

Inventářový systém potřebuje čtyři buckety: produkty, které sledují stavy zásob, objednávky vystavené na tyto produkty, požadavky na doobjednání generované automaticky byznys pravidly a auditní log, který zachycuje každou mutaci pro účely compliance.

### Produkty

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

Klíčová rozhodnutí:

- **`sku` jako přirozený klíč** — SKU kódy jsou ze své podstaty unikátní. Není potřeba generované ID.
- **`reorderLevel`** uchovává práh, pod kterým pravidlový engine vytvoří požadavek na doobjednání. Každý produkt definuje svůj vlastní práh místo použití globální konstanty.
- **Index `category`** umožňuje reporty po kategoriích bez nutnosti procházet všechny produkty.
- **`min: 0`** na `quantity` a `price` zabraňuje záporným zásobám a záporným cenám na úrovni schématu.

### Objednávky

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

Klíčová rozhodnutí:

- **`min: 1`** na `quantity` zabraňuje objednávkám s nulovým množstvím na úrovni schématu.
- **Enum `status`** omezuje životní cyklus objednávky na tři platné stavy. Schéma odmítne jakoukoli jinou hodnotu.
- **Index `sku`** umožňuje rychlé vyhledávání „všechny objednávky pro produkt X".
- **`total`** se předpočítá při vytvoření objednávky (`quantity * price`) namísto přepočítávání při každém čtení.

### Požadavky na doobjednání

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

Klíčová rozhodnutí:

- **Klíč `autoincrement`** poskytuje sekvenční ID pro snadné odkazování v nákupních objednávkách.
- **`reason`** zaznamenává, proč bylo doobjednání spuštěno (např. „Stock fell below reorder level of 20").
- **Životní cyklus `status`** sleduje doobjednání ve třech fázích: open (vytvořeno pravidlem), ordered (odeslána objednávka dodavateli), received (zásoby doplněny).

### Auditní log

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

Klíčová rozhodnutí:

- **`maxSize: 200`** omezuje auditní log na 200 záznamů. Nejstarší záznamy se automaticky odstraňují — omezený buffer, který nikdy neroste neomezeně.
- **Bez persistence** — auditní log je diagnostický nástroj pro běh aplikace. Kritická auditní data by v produkci šla do externího systému.
- **`detail`** uchovává lidsky čitelný popis toho, co se změnilo, vytvořený handlerem události.

### Vztahy mezi entitami

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

## Bucket Handle

Po definování všech bucketů si získejte handle:

```typescript
const products = store.bucket('products');
const orders = store.bucket('orders');
const reorderRequests = store.bucket('reorderRequests');
const auditLog = store.bucket('auditLog');
```

## Auditní stopa pomocí událostí

Než zapojíte pravidlový engine, nastavte auditní stopu. Každá mutace na `products` a `orders` se zaznamená do auditního logu:

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

Handlery událostí běží asynchronně — neblokují mutaci, která je vyvolala. Omezení `maxSize: 200` zajišťuje, že auditní log nikdy neroste neomezeně a nejstarší záznamy se tiše odstraňují.

## Pravidlový engine: Automatické doobjednání

Pravidlový engine sleduje aktualizace produktů a vytváří požadavky na doobjednání, když zásoby klesnou pod `reorderLevel` daného produktu. Toto je bridge v akci — mutace store pohánějí byznys logiku, aniž by store cokoliv věděl o pravidlech.

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

### Ochranné podmínky

Pravidlo má dvě ochranné podmínky, které zabraňují nekonečným smyčkám a duplicitním doobjednáním:

1. **`newQty >= reorderLevel`** — Pokud jsou zásoby stále nad prahem, přeskoč. Toto ošetřuje aktualizace polí, které se netýkají množství (např. změny ceny).
2. **`oldQty < reorderLevel`** — Pokud byly zásoby již pod prahem před touto aktualizací, přeskoč. Toto zabraňuje opětovnému spuštění při následných aktualizacích, kdy zásoby zůstávají nízké.

Dohromady tyto podmínky zajišťují, že se pravidlo spustí právě jednou: v okamžiku, kdy zásoby překročí práh směrem dolů.

### Zapojení bridge

```typescript
const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  // Only forward product mutations — reorderRequests and auditLog events are excluded
  filter: (event) => event.bucket === 'products',

  // Simplify topics for the rule engine
  mapTopic: (_topic, event) => `${event.bucket}.${event.type}`,
});
```

Filtr bridge je hlavní obrana proti nekonečným smyčkám. Akce pravidel zapisují do `reorderRequests` a `auditLog`, ale tyto události se nikdy nedostanou k pravidlovému enginu, protože filtr propouští pouze události z `products`.

```text
  Source Buckets          Target Buckets
  (events forwarded)      (events NOT forwarded)
  ┌──────────────┐        ┌──────────────────┐
  │ products     │ ──────>│ reorderRequests   │
  └──────────────┘        │ auditLog          │
                          │ orders            │
                          └──────────────────┘
```

## Naplnění daty

Naplňte sklad počátečním inventářem:

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

## Plnění objednávek pomocí transakcí

Plnění objednávek je nejkritičtější operace. Musí atomicky: ověřit dostupnost zásob, odečíst množství produktu, vytvořit záznam objednávky a aktualizovat stav objednávky. Pokud jakýkoli krok selže, nic se nezmění.

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

Transakce zaručuje, že odečtení zásob a vytvoření objednávky proběhnou společně. Pokud insert selže (např. kvůli validaci schématu), odečtení zásob se vrátí zpět. Odečtené zásoby také spustí událost `updated` na produktu, která proteče přes bridge do pravidlového enginu.

### Zrušení objednávky

Zrušení vrací odečtení zásob zpět — opět atomicky:

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

### Přijetí doobjednávky

Když dorazí zásilka z doobjednávky, doplňte zásoby a uzavřete požadavek na doobjednání:

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

## Reaktivní dashboard

Vytvořte živý skladový dashboard, který se automaticky aktualizuje při každé změně zásob, objednávce nebo doobjednání.

### Definice dotazů

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

### Odběr živých aktualizací

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

## Spuštění kompletního scénáře

Nyní spusťte kompletní životní cyklus — objednávky vyčerpávají zásoby, pravidla vytvářejí požadavky na doobjednání, zrušení obnovují zásoby a přijetí doobjednávek doplňuje inventář:

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

Kompletní průběh:

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

## Kompletní funkční příklad

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

## Cvičení

Vytvořte funkci „přesun zásob" pro systém s více sklady. Máte k dispozici následující store:

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

Napište následující:

1. Funkci `transferStock(fromId: string, toId: string, sku: string, qty: number)`, která pomocí **transakce** atomicky odečte zásoby ze zdrojového skladu, přičte je do cílového skladu a vytvoří záznam o přesunu. Vyhoďte chybu, pokud má zdroj nedostatečné zásoby.
2. **Handler události** na `bucket.transfers.inserted`, který zapíše do `transferLog` popisnou zprávu.
3. **Pravidlo** (přes `bridgeStoreToRules`), které sleduje aktualizace `stock` a když množství ve skladu klesne pod 10, zapíše varování do `transferLog` (např. „Low stock: WIDGET at WH-A has 5 units"). Přes bridge přeposílejte pouze události bucketu `stock`.
4. Reaktivní dotaz `'warehouseStock'`, který přijímá `{ warehouseId: string }` a vrací `{ sku: string, quantity: number }[]`.
5. Přihlaste se k odběru dotazu, proveďte přesun a ověřte, že se reaktivní callback spustí.

<details>
<summary>Řešení</summary>

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

Transakce ve funkci `transferStock` zajišťuje, že odečtení ze zdroje, přičtení k cíli a vytvoření záznamu o přesunu jsou atomické. Handler události na `bucket.transfers.inserted` zachycuje každý přesun v omezeném logu. Pravidlový engine, dosažitelný přes bridge filtrovaný pouze na události `stock`, detekuje, kdy sklad překročí práh nízkých zásob. Reaktivní dotaz automaticky odráží aktualizovaná množství.

</details>

## Shrnutí

- **Návrh schémat** s přirozenými klíči (`sku`), individuálním `reorderLevel` pro každý produkt a předpočítaným `total` udržuje doménový model čistý a vyhýbá se výpočtům za běhu
- **`bridgeStoreToRules()`** s filtrem bucketů (pouze `products`) vytváří jednosměrný tok událostí ze store do pravidlového enginu — cílové buckety (`reorderRequests`, `auditLog`) se nikdy nevracejí do bridge, čímž se zabraňuje nekonečným smyčkám
- **Ochranné podmínky** v handlerech pravidel (kontrola jak `oldQty < reorderLevel`, tak `newQty >= reorderLevel`) zajišťují, že se každé pravidlo spustí právě jednou při překročení prahu
- **Transakce** zaručují atomicitu pro operace napříč více buckety — `fulfillOrder` odečte zásoby a vytvoří objednávku společně, `cancelOrder` obnoví zásoby a aktualizuje stav společně, `receiveReorder` doplní zásoby a uzavře požadavek společně
- **`store.on('bucket.*.*')`** buduje auditní stopu zachycením každé mutace jako strukturovaného záznamu — handler události běží asynchronně a nikdy neblokuje původní mutaci
- **`maxSize: 200`** na auditním logu vytváří omezený buffer, který nikdy neroste neomezeně — ideální pro diagnostiku za běhu, kde záleží pouze na nedávné historii
- **Reaktivní dotazy** (`warehouseOverview`, `orderStats`, `openReorders`) tvoří živý dashboard, který se automaticky aktualizuje při každé změně zásob, objednávce nebo doobjednání bez pollování
- **`store.settle()`** zajišťuje, že všechny reaktivní callbacky a handlery událostí dokončily zpracování před ověřením výsledků — nezbytné pro deterministický výstup testů
- **Třívrstvá architektura** (Data -> Logika -> Vedlejší efekty) udržuje store oddělený od byznys pravidel — store nikdy neimportuje ani neodkazuje na pravidlový engine, což umožňuje nezávislé testování obou částí

---

Předchozí: [Real-time analytika](./02-realtime-analytika.md)
