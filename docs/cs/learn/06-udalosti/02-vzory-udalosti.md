# Vzory událostí

Víte, jak se přihlásit k odběru událostí. Ale surový handler, který loguje řádek nebo pushuje do pole, není v produkci nijak zvlášť užitečný. Skutečná hodnota přichází ze skládání událostí do praktických vzorů: auditní stopy, které zaznamenávají kdo co a kdy změnil, notifikace, které upozorní uživatele, když data dosáhnou určitého stavu, a kaskádové operace, které udržují referenční integritu napříč buckety.

Tato kapitola prochází nejběžnější událostmi řízené vzory, které budete s noex-store budovat, a ukazuje, jak je udržet čisté, testovatelné a bezpečné.

## Co se naučíte

- Jak vytvořit auditní log, který zaznamenává každou mutaci se snapshoty před/po
- Jak posílat notifikace, když data dosáhnou určitého stavu
- Jak implementovat kaskádové mazání, které udržuje referenční integritu
- Jak vytvořit počítadlo změn pro real-time metriky
- Jak udržovat handlery událostí zaměřené, idempotentní a snadno testovatelné

## Příprava

Všechny příklady v této kapitole používají následující store:

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

## Vzor 1: Auditní log

Auditní log zaznamenává každou mutaci, abyste mohli odpovědět na otázku „co se stalo, kdy a co se změnilo?" pro jakýkoliv záznam. Systém událostí doručuje stav před/po, takže sestavení logu je přímočaré:

```typescript
await store.on<BucketEvent>('bucket.*.*', async (event) => {
  // Přeskočení událostí z auditního logu samotného — prevence nekonečné rekurze
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

### Dotazování auditní stopy

Jakmile je log naplněn, můžete ho dotazovat jako jakýkoliv bucket:

```typescript
// Vytvoření uživatele a jeho úprava
const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
await users.update(alice.id, { role: 'admin' });
await users.update(alice.id, { name: 'Alice Smith' });

// Čekání na asynchronní doručení událostí
await new Promise((resolve) => setTimeout(resolve, 100));

// Všechny změny konkrétního záznamu
const aliceHistory = await auditLog.where({ recordKey: alice.id });
console.log(`Alice má ${aliceHistory.length} auditních záznamů`); // 3

// Všechny aktualizace napříč storem
const allUpdates = await auditLog.where({ action: 'updated' });
console.log(`Celkem aktualizací: ${allUpdates.length}`); // 2

// Všechny mutace v konkrétním bucketu
const userMutations = await auditLog.where({ bucket: 'users' });
console.log(`Mutace uživatelů: ${userMutations.length}`); // 3
```

### Tok auditního logu

```text
  users.update(alice.id, { role: 'admin' })
      |
      v
  BucketServer potvrdí aktualizaci
      |
      v
  EventBus publikuje: bucket.users.updated
      |
      v
  Handler auditu přijímá událost:
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

### Prevence nekonečné rekurze

Handler auditu se přihlašuje k `bucket.*.*`, což zahrnuje i bucket `auditLog` samotný. Bez ochrany `if (event.bucket === 'auditLog') return` by vložení auditního záznamu spustilo další auditní záznam a tak dál do nekonečna. Vždy se chraňte proti sebereferenčním smyčkám, když handler zapisuje zpět do store.

## Vzor 2: Notifikace při změně stavu

Notifikace se spouštějí, když pole přejde na konkrétní hodnotu. Událost aktualizace nese starý i nový záznam, takže detekce přechodů je jednoduché porovnání:

```typescript
await store.on<BucketUpdatedEvent>('bucket.orders.updated', async (event) => {
  const { oldRecord, newRecord } = event;

  // Reagujeme pouze na přechody stavu — ne na jiné změny polí
  if (oldRecord.status === newRecord.status) return;

  const transition = `${oldRecord.status} -> ${newRecord.status}`;

  switch (newRecord.status) {
    case 'paid':
      console.log(`[NOTIFIKACE] Objednávka #${event.key} zaplacena — $${newRecord.total}`);
      // V produkci: odeslání potvrzovacího emailu, spuštění fulfillmentu
      break;

    case 'shipped':
      console.log(`[NOTIFIKACE] Objednávka #${event.key} odeslána`);
      // V produkci: odeslání sledovací notifikace
      break;

    case 'cancelled':
      console.log(`[NOTIFIKACE] Objednávka #${event.key} zrušena (byla: ${oldRecord.status})`);
      // V produkci: zpracování refundace, notifikace skladu
      break;
  }
});
```

### Testování notifikací

```typescript
const order = await orders.insert({ userId: 'user-1', total: 200 });

await orders.update(order.id, { status: 'paid' });
// [NOTIFIKACE] Objednávka #1 zaplacena — $200

await orders.update(order.id, { status: 'shipped' });
// [NOTIFIKACE] Objednávka #1 odeslána

// Aktualizace bez změny stavu — žádná notifikace
await orders.update(order.id, { total: 210 });
// (ticho — stav se nezměnil)
```

### Proč porovnávat starý a nový stav

Bez ochrany `oldRecord.status === newRecord.status` by jakákoliv aktualizace objednávky spustila notifikaci — i aktualizace pole `total`, když je stav již `'paid'`. Vždy zkontrolujte, zda se relevantní pole skutečně změnilo, než zareagujete.

## Vzor 3: Kaskádové mazání

Když je uživatel smazán, jeho objednávky by měly být odstraněny také. Bez událostí byste museli pamatovat na tento úklid na každém místě volání. S událostmi ho definujete jednou:

```typescript
await store.on<BucketDeletedEvent>('bucket.users.deleted', async (event) => {
  const userId = String(event.key);
  const userOrders = await orders.where({ userId });

  for (const order of userOrders) {
    await orders.delete(order.id);
  }

  if (userOrders.length > 0) {
    console.log(`Kaskáda: smazáno ${userOrders.length} objednávek pro uživatele ${userId}`);
  }
});
```

### Kaskáda v akci

```typescript
const bob = await users.insert({ name: 'Bob', email: 'bob@example.com' });
await orders.insert({ userId: bob.id, total: 50 });
await orders.insert({ userId: bob.id, total: 120 });
await orders.insert({ userId: bob.id, total: 75 });

console.log(`Objednávky před: ${await orders.count({ userId: bob.id })}`); // 3

await users.delete(bob.id);
// Kaskáda: smazáno 3 objednávek pro uživatele <uuid>

// Čekání na asynchronní kaskádu
await new Promise((resolve) => setTimeout(resolve, 100));

console.log(`Objednávky po: ${await orders.count({ userId: bob.id })}`); // 0
```

### Tok kaskády

```text
  users.delete(bob.id)
      |
      v
  BucketServer smaže Boba
      |
      v
  EventBus: bucket.users.deleted
      |
      v
  Handler kaskády:
    1. orders.where({ userId: bob.id })
       -> [order-1, order-2, order-3]
    2. orders.delete(order-1.id)  -> EventBus: bucket.orders.deleted
    3. orders.delete(order-2.id)  -> EventBus: bucket.orders.deleted
    4. orders.delete(order-3.id)  -> EventBus: bucket.orders.deleted
```

Každé kaskádové smazání publikuje svou vlastní událost. Pokud máte spuštěný handler auditního logu, tyto smazání automaticky zaznamená.

### Bezpečnostní aspekty

Kaskádové mazání je mocné, ale může být nebezpečné. Mějte na paměti tyto zásady:

| Problém | Řešení |
|---------|--------|
| Nechtěná kaskáda | Přidejte potvrzovací krok v kódu aplikace před smazáním nadřazeného záznamu |
| Hluboké řetězce | Vyvarujte se kaskád, které spouštějí další kaskády (A maže B, B maže C). Udržujte kaskády jednoúrovňové |
| Výkon | Pro buckety s tisíci podřízených záznamů zvažte dávkové mazání nebo pozadí úlohu |
| Kruhové reference | Pokud A kaskáduje na B a B kaskáduje na A, dostanete nekonečné mazání. Ochraňte se kontrolou |

## Vzor 4: Počítadlo změn

Lehký vzor pro metriky, který počítá mutace podle typu a bucketu:

```typescript
const counters = new Map<string, number>();

await store.on<BucketEvent>('bucket.*.*', (event) => {
  if (event.bucket === 'auditLog') return;

  const key = `${event.bucket}.${event.type}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
});
```

### Čtení metrik

```typescript
await users.insert({ name: 'Alice', email: 'alice@example.com' });
await users.insert({ name: 'Bob', email: 'bob@example.com' });
await orders.insert({ userId: 'user-1', total: 100 });
await orders.update(1, { status: 'paid' });

// Čekání na události
await new Promise((resolve) => setTimeout(resolve, 50));

for (const [key, count] of counters) {
  console.log(`${key}: ${count}`);
}
// users.inserted: 2
// orders.inserted: 1
// orders.updated: 1
```

Tento vzor je užitečný pro dashboardy, rate limiting nebo detekci anomálií.

## Zásady návrhu handlerů

### Udržujte handlery zaměřené

Každý handler by měl dělat jednu věc. Místo jednoho handleru, který loguje, notifikuje a kaskáduje, vytvořte oddělené odběry:

```typescript
// Dobře: každý handler má jednu zodpovědnost
await store.on('bucket.users.deleted', handleCascadeDeletes);
await store.on('bucket.*.*', handleAuditLog);
await store.on('bucket.orders.updated', handleOrderNotifications);
```

### Zpracovávejte chyby elegantně

Vyhazující handler neovlivní původní operaci — insert/update/delete již uspěl. Ale neošetřená rejekce může srazit váš proces:

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
    console.error(`Auditní log selhal pro ${event.bucket}.${event.type}:`, err);
    // Zalogujte chybu, ale nesrazujte proces — původní operace již uspěla
  }
});
```

### Vyhněte se blokující práci v handlerech

Handlery událostí běží asynchronně, ale stále spotřebovávají zdroje. Pro náročné operace (HTTP volání, zápisy na disk, náročné výpočty) zvažte bufferování událostí a jejich zpracování v dávkách:

```typescript
const buffer: BucketEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

await store.on<BucketEvent>('bucket.*.*', (event) => {
  if (event.bucket === 'auditLog') return;

  buffer.push(event);

  // Flush každých 100ms, pokud již není naplánován
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

## Kompletní funkční příklad

Systém správy uživatelů s auditním logováním, notifikacemi objednávek a kaskádovým mazáním:

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

  // --- Vzor 1: Auditní log ---
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
      console.error('Chyba auditního logu:', err);
    }
  });

  // --- Vzor 2: Notifikace stavu objednávek ---
  await store.on<BucketUpdatedEvent>('bucket.orders.updated', (event) => {
    const { oldRecord, newRecord } = event;
    if (oldRecord.status === newRecord.status) return;

    console.log(`[NOTIFIKACE] Objednávka #${event.key}: ${oldRecord.status} -> ${newRecord.status}`);
  });

  // --- Vzor 3: Kaskádové mazání ---
  await store.on<BucketDeletedEvent>('bucket.users.deleted', async (event) => {
    const userId = String(event.key);
    const userOrders = await ordersBucket.where({ userId });
    for (const order of userOrders) {
      await ordersBucket.delete(order.id);
    }
    if (userOrders.length > 0) {
      console.log(`[KASKÁDA] Smazáno ${userOrders.length} objednávek pro uživatele ${userId}`);
    }
  });

  // --- Spuštění scénáře ---

  // Vytvoření uživatelů
  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  const bob = await users.insert({ name: 'Bob', email: 'bob@example.com' });

  // Vytvoření objednávek
  const order1 = await ordersBucket.insert({ userId: alice.id, total: 150 });
  await ordersBucket.insert({ userId: bob.id, total: 80 });
  await ordersBucket.insert({ userId: bob.id, total: 200 });

  // Přechody stavu spouštějí notifikace
  await ordersBucket.update(order1.id, { status: 'paid' });
  // [NOTIFIKACE] Objednávka #1: pending -> paid

  await ordersBucket.update(order1.id, { status: 'shipped' });
  // [NOTIFIKACE] Objednávka #1: paid -> shipped

  // Smazání Boba — kaskáda na jeho objednávky
  await users.delete(bob.id);
  // [KASKÁDA] Smazáno 2 objednávek pro uživatele <uuid>

  // Čekání na všechny asynchronní handlery
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Kontrola auditní stopy
  const auditEntries = await audit.count();
  console.log(`\nZáznamy auditního logu: ${auditEntries}`);

  const orderCount = await ordersBucket.count();
  console.log(`Zbývající objednávky: ${orderCount}`); // 1 (odeslaná objednávka Alice)

  await store.stop();
}

main();
```

## Cvičení

Vytvořte jednoduchý inventární systém s následujícími buckety a handlery událostí:

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

Napište handlery událostí, které:

1. **Upozornění na nízký stav**: Když `stock` produktu klesne na 5 nebo méně (a předtím nebyl na 5 nebo méně), vložte upozornění se zprávou `"Nízký stav: {name} má {stock} kusů"`
2. **Upozornění na vyprodání**: Když `stock` produktu dosáhne 0, vložte upozornění se zprávou `"Vyprodáno: {name}"`
3. **Notifikace o doplnění**: Když `stock` produktu vzroste z 0 na jakékoliv kladné číslo, zalogujte `"Doplněno: {name}"`

Pak otestujte vytvořením produktu se zásobou 10, aktualizací zásoby na 3, pak na 0 a pak na 15.

<details>
<summary>Řešení</summary>

```typescript
import type { BucketUpdatedEvent } from '@hamicek/noex-store';

// Upozornění na nízký stav a vyprodání
await store.on<BucketUpdatedEvent>('bucket.products.updated', async (event) => {
  const { oldRecord, newRecord } = event;
  const oldStock = oldRecord.stock as number;
  const newStock = newRecord.stock as number;
  const name = newRecord.name as string;

  // Upozornění na nízký stav: překročení prahu shora z nad 5 na 5 nebo méně
  if (oldStock > 5 && newStock <= 5 && newStock > 0) {
    await alerts.insert({
      productId: String(event.key),
      message: `Nízký stav: ${name} má ${newStock} kusů`,
      timestamp: Date.now(),
    });
  }

  // Upozornění na vyprodání
  if (oldStock > 0 && newStock === 0) {
    await alerts.insert({
      productId: String(event.key),
      message: `Vyprodáno: ${name}`,
      timestamp: Date.now(),
    });
  }

  // Notifikace o doplnění
  if (oldStock === 0 && newStock > 0) {
    console.log(`Doplněno: ${name}`);
  }
});

// Testování handlerů
const widget = await products.insert({ name: 'Widget', stock: 10 });

await products.update(widget.id, { stock: 3 });
// -> upozornění: "Nízký stav: Widget má 3 kusů"

await products.update(widget.id, { stock: 0 });
// -> upozornění: "Vyprodáno: Widget"

await products.update(widget.id, { stock: 15 });
// -> konzole: "Doplněno: Widget"

// Čekání na asynchronní handlery
await new Promise((resolve) => setTimeout(resolve, 100));

const allAlerts = await alerts.where({ productId: widget.id });
console.log(`Upozornění: ${allAlerts.length}`); // 2
for (const a of allAlerts) {
  console.log(`  ${a.message}`);
}
// Nízký stav: Widget má 3 kusů
// Vyprodáno: Widget
```

</details>

## Shrnutí

- **Auditní log**: Přihlaste se k `bucket.*.*`, zaznamenávejte snapshoty `before`/`after` do dedikovaného bucketu a chraňte se proti sebereferenčním smyčkám
- **Notifikace při změně stavu**: Porovnávejte pole `oldRecord` a `newRecord` pro detekci přechodů — nereagujte na každou aktualizaci, pouze na smysluplné změny stavu
- **Kaskádové mazání**: Přihlaste se k `bucket.{rodič}.deleted` a odstraňte podřízené záznamy — udržujte kaskády jednoúrovňové, aby se předešlo složitosti
- **Počítadlo změn**: Lehká in-memory `Map`, která počítá mutace podle bucketu a typu — užitečné pro dashboardy a rate limiting
- **Návrh handlerů**: Jedna zodpovědnost na handler, vždy obalte asynchronní práci do try/catch, chraňte se proti nekonečné rekurzi a bufferujte náročné operace
- Handlery událostí se spouštějí po úspěšné mutaci — selhávající handler nemůže vrátit zpět původní operaci
- Více vzorů se přirozeně skládá: auditní log, handler notifikací a handler kaskád mohou běžet současně na stejném store

---

Další: [Proč transakce?](../07-transakce/01-proc-transakce.md)
