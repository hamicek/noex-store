# Pravidla řízená Storem

Nastavili jste bridge, který přeposílá události ze store do pravidlového enginu. Pravidlový engine vyhodnocuje podmínky a spouští akce. Ale co když tyto akce potřebují zapsat zpět do store? Událost „objednávka odeslána" spustí pravidlo, které aktualizuje věrnostní body zákazníka. Událost „zásoby vyčerpány" spustí pravidlo, které vytvoří požadavek na doobjednání. Data tečou v kruhu: mutace store → událost → pravidlový engine → mutace store → událost → ...

Tento obousměrný vzor je silný, ale nebezpečný. Bez opatrnosti vytvoříte nekonečné smyčky, race conditions nebo těsně provázané systémy, které nelze debugovat. Tato kapitola vám ukáže, jak navrhnout zpětnou smyčku bezpečně, s jasnými hranicemi mezi store produkujícím události a pravidlovým enginem vykonávajícím akce.

## Co se naučíte

- Jak strukturovat obousměrnou integraci store ↔ pravidlový engine
- Jak mohou pravidla zapisovat zpět do store prostřednictvím action handlerů
- Jak předcházet nekonečným smyčkám událostí pomocí ochranných podmínek a filtrů
- Jak použít transakce, když akce pravidla zasahuje více bucketů
- Jak trasovat celý cyklus: mutace → událost → pravidlo → mutace
- Běžné vzory: kaskádové aktualizace, odvozená data a konzistence napříč buckety

## Zpětná smyčka

Bridge z kapitoly 11.1 je jednosměrný: store → pravidlový engine. Pro uzavření smyčky action handlery pravidlového enginu volají zpět do store:

```text
  ┌─────────────────────────────────────────────────────────┐
  │                                                           │
  │   ┌───────────┐    bridge     ┌──────────────┐           │
  │   │           │ ────────────> │              │           │
  │   │   Store   │   (události) │ Pravidlový   │           │
  │   │           │ <──────────── │    engine    │           │
  │   └───────────┘     (akce)   └──────────────┘           │
  │                                                           │
  │   Bridge přeposílá události.                              │
  │   Akce pravidel volají metody store přímo.                │
  │                                                           │
  └─────────────────────────────────────────────────────────┘
```

Bridge obstarává směr store → pravidla. Pro směr pravidla → store action handlery pravidlového enginu jednoduše drží referenci na store (nebo jeho bucket handle) a volají `insert`, `update` nebo `delete` přímo. Neexistuje žádné speciální API — je to běžné použití store uvnitř callbacku.

## Architektura

Dobře strukturovaná obousměrná integrace má tři vrstvy:

```text
  Vrstva 1: Data (Store)
  ┌─────────────────────────────────────────────┐
  │  users    orders    inventory    loyalty     │
  │  bucket   bucket    bucket       bucket      │
  └──────────────────┬──────────────────────────┘
                     │
                     │  bucket události (přes bridge)
                     ▼
  Vrstva 2: Logika (Pravidlový engine)
  ┌─────────────────────────────────────────────┐
  │  "objednávka odeslána → přidat body"        │
  │  "zásoby pod 10 → vytvořit doobjednávku"    │
  │  "uživatel smazán → archivovat objednávky"  │
  └──────────────────┬──────────────────────────┘
                     │
                     │  action handlery (volají metody store)
                     ▼
  Vrstva 3: Vedlejší efekty
  ┌─────────────────────────────────────────────┐
  │  Mutace store     Externí API               │
  │  Notifikace       Logování                  │
  └─────────────────────────────────────────────┘
```

| Vrstva | Zodpovědnost | Zná |
|--------|-------------|-----|
| Data (Store) | Držet stav, validovat, emitovat události | Nic o pravidlech |
| Logika (Pravidlový engine) | Vyhodnocovat podmínky, rozhodovat o akcích | Témata a tvary dat událostí |
| Vedlejší efekty (Akce) | Vykonávat rozhodnutí | API store, externí služby |

Store nikdy neimportuje ani neodkazuje na pravidlový engine. Pravidlový engine zná témata událostí a tvary dat, ale nespravuje vnitřní záležitosti store. Action handlery překlenují propast voláním metod store.

## Vzor: Kaskádové aktualizace

Když mutace v jednom bucketu má spustit aktualizaci v jiném, pravidlový engine funguje jako koordinátor.

### Příklad: Věrnostní body při odeslání objednávky

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

  // --- Pravidlový engine (mock implementace) ---
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

  // --- Definice pravidel ---

  // Pravidlo: Když se stav objednávky změní na 'shipped', přidej věrnostní body
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

  // --- Bridge událostí store do pravidlového enginu ---
  const unbridge = await bridgeStoreToRules(store, ruleEngine, {
    filter: (event) => event.bucket === 'orders',
  });

  // --- Spuštění scénáře ---
  const order = await ordersBucket.insert({ userId: 'alice', total: 250 });
  await ordersBucket.update(order.id, { status: 'paid' });
  await ordersBucket.update(order.id, { status: 'shipped' });

  // Čekání na asynchronní zpracování
  await new Promise((resolve) => setTimeout(resolve, 100));

  const loyalty = await loyaltyBucket.get('alice');
  console.log(`Věrnostní body Alice: ${loyalty?.points}`);
  // Věrnostní body Alice: 25  (250 / 10)

  await unbridge();
  await store.stop();
}

main();
```

### Proč to funguje bezpečně

Bridge je nakonfigurován s `filter: (event) => event.bucket === 'orders'`. Aktualizace loyalty spuštěná pravidlem produkuje událost `bucket.loyalty.updated`, ale filtr ji zablokuje od doručení pravidlovému enginu. Žádná smyčka.

## Prevence nekonečných smyček

Nejnebezpečnějším aspektem obousměrné integrace je zpětná smyčka. Akce pravidla mutuje store, což emituje událost, což spustí pravidlo znovu, což mutuje store — donekonečna.

### Strategie 1: Filtrování podle bucketu

Nejjednodušší prevencí je filtrovat bridge tak, aby k pravidlovému enginu dorazily pouze události ze specifických „zdrojových" bucketů. „Cílové" buckety (zapisované akcemi pravidel) jsou vyloučeny:

```text
  Zdrojové buckety         Cílové buckety
  (události přeposílány)   (události NEPŘEPOSÍLÁNY)
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

Akce pravidel zapisují do `loyalty`, `audit`, `notifications` — tyto události nikdy nedorazí k pravidlovému enginu.

### Strategie 2: Filtrování podle obsahu události

Když akce pravidla aktualizuje zdrojový bucket (např. aktualizace `status` objednávky), potřebujete ochranu na základě obsahu, abyste zabránili opětovnému spuštění:

```typescript
rules.push({
  pattern: /^bucket\.orders\.updated$/,
  handler: async (_topic, data) => {
    const event = data as unknown as BucketEvent;
    if (event.type !== 'updated') return;

    const { oldRecord, newRecord } = event;

    // Ochrana: reagovat pouze na změny stavu, ne jiných polí
    if (oldRecord.status === newRecord.status) return;

    // Ochrana: reagovat pouze na konkrétní přechody
    if (newRecord.status !== 'shipped') return;

    // Bezpečné pokračování — tato akce aktualizuje bucket loyalty, ne orders
    // ...
  },
});
```

Ochranná podmínka zajišťuje, že se pravidlo spustí pouze pro konkrétní přechod stavu, o který se stará. I kdyby aktualizace loyalty nějak vyprodukovala událost objednávek (v tomto příkladu ne), ochrana by zabránila opětovnému vstupu, protože by se stav nezměnil.

### Strategie 3: Oddělené instance bridge

Pro komplexní systémy použijte více bridgů s různými filtry:

```typescript
// Bridge 1: Události objednávek → pravidla objednávek
const unbridgeOrders = await bridgeStoreToRules(store, orderRuleEngine, {
  filter: (event) => event.bucket === 'orders',
});

// Bridge 2: Události skladu → pravidla skladu
const unbridgeInventory = await bridgeStoreToRules(store, inventoryRuleEngine, {
  filter: (event) => event.bucket === 'inventory',
});

// Každý pravidlový engine vidí pouze události ze své domény
// Každý zapisuje do jiných cílových bucketů
```

## Vzor: Odvozená data

Pravidla mohou vypočítat odvozené hodnoty a uložit je do vyhrazeného bucketu. Odvozený bucket je vždy konzistentní, protože je aktualizován v reakci na každou relevantní změnu.

### Příklad: Statistiky objednávek na uživatele

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

// Pravidlo: Udržovat průběžné statistiky pro každého uživatele
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

Bucket `userStats` je vždy aktuální — každý insert objednávky spustí přepočítání. Protože bridge filtruje události `userStats`, nedochází ke zpětné smyčce.

## Vzor: Konzistence napříč buckety s transakcemi

Když akce pravidla musí atomicky aktualizovat více bucketů, použijte transakci uvnitř action handleru:

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

// Pravidlo: Když zásoby klesnou pod práh, označ k doobjednání a vytvoř požadavek
rules.push({
  pattern: /^bucket\.inventory\.updated$/,
  handler: async (_topic, data) => {
    const event = data as unknown as BucketEvent;
    if (event.type !== 'updated') return;

    const { newRecord } = event;
    const quantity = newRecord.quantity as number;
    const alreadyFlagged = newRecord.reorder as boolean;

    // Ochrana: spustit pouze při překročení prahu směrem dolů
    if (quantity >= 10 || alreadyFlagged) return;

    const sku = event.key as string;

    // Atomicky: označit inventář A vytvořit požadavek na doobjednání
    await store.transaction(async (tx) => {
      const inv = await tx.bucket('inventory');
      const req = await tx.bucket('reorderRequests');

      await inv.update(sku, { reorder: true });
      await req.insert({ sku, quantity: 100 });
    });
  },
});
```

Transakce zajišťuje, že příznak `reorder` a požadavek na doobjednání jsou vytvořeny společně. Pokud jeden selže, oba se vrátí zpět. Ochrana `alreadyFlagged` brání pravidlu, aby se spustilo znovu, když samotný update `reorder: true` produkuje událost.

## Trasování celého cyklu

Pro ladění pomáhá trasovat kompletní cestu události systémem. Přidejte globální listener a logování v pravidlovém enginu:

```typescript
// Trasování událostí store
await store.on<BucketEvent>('bucket.*.*', (event, topic) => {
  console.log(`[store] ${topic} key=${String(event.key)}`);
});

// Trasování vykonávání pravidel
const tracingRuleEngine: EventReceiver = {
  async emit(topic, data) {
    console.log(`[bridge→rules] ${topic}`);
    // Přeposlání do skutečného pravidlového enginu
    await ruleEngine.emit(topic, data);
  },
};

const unbridge = await bridgeStoreToRules(store, tracingRuleEngine, {
  filter: (event) => event.bucket === 'orders',
});

// Spuštění scénáře
await ordersBucket.insert({ userId: 'alice', total: 100 });
await ordersBucket.update(1, { status: 'shipped' });

// Výstup:
// [store] bucket.orders.inserted key=1
// [bridge→rules] bucket.orders.inserted
// [store] bucket.orders.updated key=1
// [bridge→rules] bucket.orders.updated
// [store] bucket.loyalty.inserted key=alice    ← akce pravidla zapsala zpět
```

Trasování ukazuje přesně, odkud každá událost pochází a jaké akce pravidel spustila.

## Kompletní funkční příklad

Mini e-commerce systém s objednávkami, skladem a věrností — vše koordinované přes bridge:

```typescript
import { Store, bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'ecommerce' });

  // --- Definice bucketů ---

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

  // --- Mock pravidlový engine ---
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

  // --- Pravidlo 1: Odečtení skladu při potvrzení objednávky ---
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

  // --- Pravidlo 2: Přidělení věrnostních bodů při odeslání objednávky ---
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

  // --- Bridge: přeposílat pouze události objednávek ---
  const unbridge = await bridgeStoreToRules(store, ruleEngine, {
    filter: (event) => event.bucket === 'orders',
  });

  // --- Naplnění skladu ---
  await inventoryBucket.insert({ sku: 'LAPTOP-1', name: 'Pro Laptop', quantity: 50 });
  await inventoryBucket.insert({ sku: 'MOUSE-1', name: 'Bezdrátová myš', quantity: 200 });

  // --- Simulace životního cyklu objednávky ---
  const order1 = await ordersBucket.insert({
    userId: 'alice', sku: 'LAPTOP-1', qty: 2, total: 2598,
  });
  const order2 = await ordersBucket.insert({
    userId: 'alice', sku: 'MOUSE-1', qty: 5, total: 150,
  });

  // Potvrzení objednávek → spustí odečtení skladu
  await ordersBucket.update(order1.id, { status: 'confirmed' });
  await ordersBucket.update(order2.id, { status: 'confirmed' });

  // Odeslání objednávek → spustí přidělení věrnostních bodů
  await ordersBucket.update(order1.id, { status: 'shipped' });
  await ordersBucket.update(order2.id, { status: 'shipped' });

  // Čekání na asynchronní zpracování pravidel
  await new Promise((resolve) => setTimeout(resolve, 200));

  // --- Ověření výsledků ---
  const laptop = await inventoryBucket.get('LAPTOP-1');
  console.log(`Zásoby laptopů: ${laptop?.quantity}`);
  // Zásoby laptopů: 48  (50 - 2)

  const mouse = await inventoryBucket.get('MOUSE-1');
  console.log(`Zásoby myší: ${mouse?.quantity}`);
  // Zásoby myší: 195  (200 - 5)

  const aliceLoyalty = await loyaltyBucket.get('alice');
  console.log(`Věrnost Alice: ${aliceLoyalty?.points} bodů`);
  // Věrnost Alice: 274 bodů  (259 + 15)

  await unbridge();
  await store.stop();
}

main();
```

## Cvičení

Budujete systém uživatelských účtů. Když je uživatel smazán, všechny jeho objednávky by měly být archivovány (přesunuty do bucketu `archivedOrders`) a jeho relace by měla být vyčištěna.

S tímto nastavením:

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

1. Vytvořte mock pravidlový engine s metodou `emit`
2. Napište pravidlo, které se spustí při smazání uživatele
3. Pravidlo by mělo: najít všechny objednávky pro daného uživatele, vložit každou do `archivedOrders`, smazat každou z `orders` a smazat relaci uživatele — vše v rámci transakce
4. Propojte bridge pouze pro události bucketu `users`
5. Otestujte vytvořením uživatele se dvěma objednávkami a relací, pak smazáním uživatele

<details>
<summary>Řešení</summary>

```typescript
import { bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

const ordersBucket = store.bucket('orders');
const archivedBucket = store.bucket('archivedOrders');
const sessionsBucket = store.bucket('sessions');
const usersBucket = store.bucket('users');

type RuleHandler = (topic: string, data: Record<string, unknown>) => void;
const rules: Array<{ pattern: RegExp; handler: RuleHandler }> = [];

// 1. Mock pravidlový engine
const ruleEngine: EventReceiver = {
  async emit(topic, data) {
    for (const rule of rules) {
      if (rule.pattern.test(topic)) {
        rule.handler(topic, data);
      }
    }
  },
};

// 2. Pravidlo: při smazání uživatele archivovat objednávky a vyčistit relaci
rules.push({
  pattern: /^bucket\.users\.deleted$/,
  handler: async (_topic, data) => {
    const event = data as unknown as BucketEvent;
    if (event.type !== 'deleted') return;

    const userId = event.key as string;

    // 3. Transakce: archivace objednávek + smazání relace
    await store.transaction(async (tx) => {
      const txOrders = await tx.bucket('orders');
      const txArchive = await tx.bucket('archivedOrders');
      const txSessions = await tx.bucket('sessions');

      // Nalezení všech objednávek daného uživatele
      const userOrders = await txOrders.where({ userId });

      // Archivace každé objednávky
      for (const order of userOrders) {
        await txArchive.insert({
          userId: order.userId,
          total: order.total,
        });
        await txOrders.delete(order.id);
      }

      // Vyčištění relace
      await txSessions.delete(userId);
    });
  },
});

// 4. Bridge pouze pro události uživatelů
const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  filter: (event) => event.bucket === 'users',
});

// 5. Test
const alice = await usersBucket.insert({ name: 'Alice' });
const aliceId = alice.id as string;

await ordersBucket.insert({ userId: aliceId, total: 100 });
await ordersBucket.insert({ userId: aliceId, total: 250 });
await sessionsBucket.insert({ userId: aliceId, token: 'tok_abc123' });

// Smazání Alice — spustí pravidlo
await usersBucket.delete(aliceId);

// Čekání na asynchronní zpracování
await new Promise((resolve) => setTimeout(resolve, 200));

// Ověření
const remainingOrders = await ordersBucket.where({ userId: aliceId });
console.log(`Aktivní objednávky: ${remainingOrders.length}`);     // 0

const archived = await archivedBucket.where({ userId: aliceId });
console.log(`Archivované objednávky: ${archived.length}`);         // 2

const session = await sessionsBucket.get(aliceId);
console.log(`Relace existuje: ${session !== undefined}`);          // false

await unbridge();
```

Transakce zajišťuje atomicitu: pokud archivace jakékoliv objednávky selže, relace se nesmaže a již archivované objednávky se vrátí zpět. Filtr bridge na `users` znamená, že mutace v `orders`, `archivedOrders` a `sessions` nespustí žádná pravidla — žádná smyčka.

</details>

## Shrnutí

- Bridge (`bridgeStoreToRules`) obstarává směr **store → pravidla**; akce pravidel volají metody store přímo pro směr **pravidla → store**
- Systém strukturujte do tří vrstev: **Data** (buckety store), **Logika** (pravidlový engine), **Vedlejší efekty** (action handlery) — každá vrstva zná pouze tu pod ní
- **Předcházejte nekonečným smyčkám** filtrováním bridge tak, aby přeposílal pouze události zdrojových bucketů, použitím ochranných podmínek v handlerech pravidel nebo provozem oddělených instancí bridge pro každou doménu
- **Kaskádové aktualizace** fungují bezpečně, když akce pravidel zapisují do cílových bucketů, které bridge nepřeposílá
- Použijte **transakce** v action handlerech pravidel, když akce musí atomicky aktualizovat více bucketů
- Buckety s **odvozenými daty** (statistiky, agregace) zůstávají konzistentní, protože je pravidla aktualizují při každé relevantní změně
- **Ochranné podmínky** v handlerech pravidel (kontrola konkrétních přechodů polí, příznaků nebo prahů) jsou primární obranou proti opětovnému spuštění
- Přidejte **trasování** s obalovacím `EventReceiver` a `store.on('bucket.*.*')` pro ladění celého cyklu událostí
- Store zůstává **oddělený** od pravidlového enginu — nikdy neimportuje ani neodkazuje na pravidla, takže oba lze nezávisle testovat

---

Další: [Správa úloh](../12-projekty/01-sprava-uloh.md)
