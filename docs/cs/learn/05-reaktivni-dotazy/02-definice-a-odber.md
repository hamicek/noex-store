# Definice a odběr

Rozumíte tomu, proč reaktivní dotazy existují. Teď je čas je použít. Tato kapitola pokrývá celé API: definici dotazů pomocí `defineQuery()`, odběr živých aktualizací pomocí `subscribe()`, jednorázové spouštění dotazů pomocí `runQuery()`, předávání parametrů dotazům a úklid odběrů.

## Co se naučíte

- Jak definovat reaktivní dotaz pomocí `store.defineQuery()`
- Jak `subscribe()` spustí živý odběr a vrátí funkci pro odhlášení
- Jak `runQuery()` vykoná dotaz jednou bez přihlášení k odběru
- Jak parametrizované dotazy přijímají argumenty pro filtrované výsledky
- Jak `store.settle()` zajistí dokončení všech čekajících přehodnocení
- Jak se chovají chyby v definicích dotazů a během přehodnocení

## Příprava

Všechny příklady v této kapitole používají následující store:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'reactive-demo' });

await store.defineBucket('customers', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    tier: { type: 'string', enum: ['free', 'pro', 'enterprise'], default: 'free' },
  },
  indexes: ['tier'],
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    customerId: { type: 'string', required: true },
    amount:     { type: 'number', required: true, min: 0 },
    status:     { type: 'string', enum: ['pending', 'paid', 'refunded'], default: 'pending' },
  },
  indexes: ['customerId', 'status'],
});

const customers = store.bucket('customers');
const orders = store.bucket('orders');
```

## `defineQuery()` — Registrace funkce dotazu

`defineQuery(name, fn)` zaregistruje pojmenovanou funkci dotazu. Funkce přijímá `QueryContext` jako první argument, který poskytuje přístup ke všem bucketům pouze pro čtení:

```typescript
store.defineQuery('totalCustomers', async (ctx) => {
  return ctx.bucket('customers').count();
});
```

Funkce dotazu:
- Musí být `async` (vrací `Promise`)
- Přijímá `QueryContext` — ne přímé bucket handle
- Může číst z více bucketů v jednom dotazu
- Nesmí měnit data — `QueryContext` poskytuje pouze metody pro čtení

### API QueryContext

Metoda `ctx.bucket(name)` vrací `QueryBucket` pouze pro čtení s těmito metodami:

| Metoda | Vrací | Popis |
|---|---|---|
| `get(key)` | `StoreRecord \| undefined` | Načtení jednoho záznamu podle primárního klíče |
| `all()` | `StoreRecord[]` | Všechny záznamy v bucketu |
| `where(filter)` | `StoreRecord[]` | Záznamy odpovídající filtru |
| `findOne(filter)` | `StoreRecord \| undefined` | První záznam odpovídající filtru |
| `count(filter?)` | `number` | Počet odpovídajících záznamů |
| `first(n)` | `StoreRecord[]` | Prvních n záznamů |
| `last(n)` | `StoreRecord[]` | Posledních n záznamů |
| `paginate(options)` | `PaginatedResult` | Kurzorová paginace |
| `sum(field, filter?)` | `number` | Součet číselného pole |
| `avg(field, filter?)` | `number` | Průměr číselného pole |
| `min(field, filter?)` | `number \| undefined` | Minimální hodnota |
| `max(field, filter?)` | `number \| undefined` | Maximální hodnota |

Jsou to stejné metody dostupné na `BucketHandle`, ale přes rozhraní pouze pro čtení, které sleduje závislosti.

### Název dotazu musí být unikátní

Definice dvou dotazů se stejným názvem vyhodí `QueryAlreadyDefinedError`:

```typescript
store.defineQuery('stats', async (ctx) => ctx.bucket('customers').count());

try {
  store.defineQuery('stats', async (ctx) => ctx.bucket('orders').count());
} catch (err) {
  console.log(err.message); // Query "stats" is already defined
}
```

## `subscribe()` — Živé aktualizace

`subscribe(name, callback)` spustí živý odběr. Okamžitě vykoná dotaz, uloží počáteční výsledek a zavolá callback pokaždé, když se výsledek změní:

```typescript
store.defineQuery('customerCount', async (ctx) => {
  return ctx.bucket('customers').count();
});

const unsub = await store.subscribe('customerCount', (count) => {
  console.log(`Zákazníků: ${count}`);
});

// Zatím žádný callback — subscribe NEVOLÁ callback pro počáteční výsledek

await customers.insert({ name: 'Alice' });
await store.settle();
// Zákazníků: 1

await customers.insert({ name: 'Bob' });
await store.settle();
// Zákazníků: 2
```

### Subscribe vrací funkci pro odhlášení

Návratová hodnota `subscribe()` je funkce, která odběr zastaví:

```typescript
const unsub = await store.subscribe('customerCount', (count) => {
  console.log(`Zákazníků: ${count}`);
});

await customers.insert({ name: 'Alice' });
await store.settle();
// Zákazníků: 1

// Zastavení naslouchání
unsub();

await customers.insert({ name: 'Bob' });
await store.settle();
// Žádný výstup — odběr je pryč
```

Vždy volejte funkci pro odhlášení, když životnost spotřebitele skončí. Zapomenutí na odhlášení vytváří únik paměti.

### Více odběratelů

Více callbacků se může přihlásit k odběru stejného dotazu. Každý odběr je nezávislý — sleduje svůj vlastní výsledek a závislosti:

```typescript
store.defineQuery('pendingCount', async (ctx) => {
  return ctx.bucket('orders').count({ status: 'pending' });
});

const unsub1 = await store.subscribe('pendingCount', (count) => {
  console.log(`[widget] Čekajících: ${count}`);
});

const unsub2 = await store.subscribe('pendingCount', (count) => {
  console.log(`[header] ${count} čekajících objednávek`);
});

await orders.insert({ customerId: 'some-id', amount: 100 });
await store.settle();
// [widget] Čekajících: 1
// [header] 1 čekajících objednávek

unsub1();
unsub2();
```

### Callback se spustí pouze při změně

Store porovnává nový výsledek s předchozím pomocí hluboké rovnosti. Pokud je výsledek identický, callback se přeskočí:

```typescript
store.defineQuery('pendingOrders', async (ctx) => {
  return ctx.bucket('orders').where({ status: 'pending' });
});

let callCount = 0;
await store.subscribe('pendingOrders', () => {
  callCount++;
});

// Vložení ZAPLACENÉ objednávky — sada čekajících se nezměnila
await orders.insert({ customerId: 'id-1', amount: 50, status: 'paid' });
await store.settle();
// callCount je stále 0 — výsledek se nezměnil (sada čekajících je stále prázdná)

// Vložení ČEKAJÍCÍ objednávky — sada čekajících se změnila
await orders.insert({ customerId: 'id-2', amount: 75 });
await store.settle();
// callCount je nyní 1 — výsledek se změnil
```

Poznámka: dotaz se stále znovu vyhodnotí při jakékoliv změně v bucketu `orders` (protože `where()` vytváří závislost na úrovni bucketu). Ale callback se spustí pouze pokud přehodnocení produkuje odlišný výsledek.

## `runQuery()` — Jednorázové vykonání

`runQuery(name, params?)` vykoná dotaz jednou a vrátí výsledek přímo. Žádný odběr se nevytváří, žádný callback se neregistruje:

```typescript
store.defineQuery('totalRevenue', async (ctx) => {
  return ctx.bucket('orders').sum('amount');
});

const revenue = await store.runQuery('totalRevenue');
console.log(`Příjmy: $${revenue}`); // Příjmy: $0

await orders.insert({ customerId: 'id-1', amount: 100 });
await orders.insert({ customerId: 'id-2', amount: 250 });

const updated = await store.runQuery('totalRevenue');
console.log(`Příjmy: $${updated}`); // Příjmy: $350
```

Používejte `runQuery()` pro:
- API endpointy, které potřebují snapshot dat
- CLI nástroje, kde odběry nemají smysl
- Testy, které potřebují ověřit výsledek dotazu v konkrétním bodě

### Nedefinovaný dotaz

Jak `subscribe()`, tak `runQuery()` vyhodí `QueryNotDefinedError`, pokud název dotazu neexistuje:

```typescript
try {
  await store.runQuery('nonExistent');
} catch (err) {
  console.log(err.message); // Query "nonExistent" is not defined
}
```

## Parametrizované dotazy

Dotazy mohou přijímat parametry jako druhý argument. To umožňuje definovat jeden dotaz, který produkuje různé výsledky na základě vstupu:

```typescript
store.defineQuery('ordersByStatus', async (ctx, params: { status: string }) => {
  return ctx.bucket('orders').where({ status: params.status });
});

// Odběr s konkrétními parametry
const unsub = await store.subscribe(
  'ordersByStatus',
  { status: 'pending' },
  (result) => {
    console.log(`Čekající objednávky: ${result.length}`);
  },
);

await orders.insert({ customerId: 'id-1', amount: 50 });
await store.settle();
// Čekající objednávky: 1

await orders.insert({ customerId: 'id-2', amount: 100, status: 'paid' });
await store.settle();
// Žádný výstup — zaplacená objednávka nemění počet čekajících

unsub();
```

### Více odběrů s různými parametry

Každá kombinace `(názevDotazu, parametry)` je nezávislý odběr s vlastním výsledkem a závislostmi:

```typescript
store.defineQuery('customersByTier', async (ctx, params: { tier: string }) => {
  return ctx.bucket('customers').where({ tier: params.tier });
});

const unsubFree = await store.subscribe(
  'customersByTier',
  { tier: 'free' },
  (result) => {
    console.log(`Free zákazníci: ${result.length}`);
  },
);

const unsubPro = await store.subscribe(
  'customersByTier',
  { tier: 'pro' },
  (result) => {
    console.log(`Pro zákazníci: ${result.length}`);
  },
);

await customers.insert({ name: 'Alice', tier: 'free' });
await store.settle();
// Free zákazníci: 1
// (pro callback se může a nemusí spustit — závisí na výsledku deepEqual)

await customers.insert({ name: 'Bob', tier: 'pro' });
await store.settle();
// Pro zákazníci: 1

unsubFree();
unsubPro();
```

### `runQuery()` s parametry

```typescript
store.defineQuery('customerByName', async (ctx, params: { name: string }) => {
  return ctx.bucket('customers').findOne({ name: params.name });
});

await customers.insert({ name: 'Alice', tier: 'enterprise' });

const alice = await store.runQuery('customerByName', { name: 'Alice' });
console.log(alice?.tier); // enterprise
```

## `store.settle()` — Čekání na přehodnocení

Reaktivní přehodnocení jsou asynchronní. Po mutaci dat běží čekající přehodnocení na pozadí. `store.settle()` počká na dokončení všech:

```typescript
store.defineQuery('count', async (ctx) => ctx.bucket('customers').count());

await store.subscribe('count', (n) => console.log(`Počet: ${n}`));

await customers.insert({ name: 'Alice' });
// Přehodnocení je ve frontě, ale nemusí být ještě dokončené

await store.settle();
// Nyní se všechny callbacky spustily — Počet: 1
```

V produkčním kódu obecně nepotřebujete `settle()` — callbacky se spouštějí asynchronně a aktualizace plynou přirozeně. V testech je `settle()` nezbytný pro deterministické ověření.

## Dotazy napříč buckety

Dotaz může číst z libovolného počtu bucketů:

```typescript
store.defineQuery(
  'customerWithOrders',
  async (ctx, params: { customerId: string }) => {
    const customer = await ctx.bucket('customers').get(params.customerId);
    if (!customer) return null;

    const customerOrders = await ctx.bucket('orders').where({
      customerId: params.customerId,
    });

    const totalSpent = customerOrders.reduce((sum, o) => sum + (o.amount as number), 0);

    return {
      name: customer.name,
      tier: customer.tier,
      orderCount: customerOrders.length,
      totalSpent,
    };
  },
);

const alice = await customers.insert({ name: 'Alice', tier: 'pro' });

const unsub = await store.subscribe(
  'customerWithOrders',
  { customerId: alice.id as string },
  (result) => {
    console.log(result);
  },
);

await orders.insert({ customerId: alice.id as string, amount: 100 });
await store.settle();
// { name: 'Alice', tier: 'pro', orderCount: 1, totalSpent: 100 }

await orders.insert({ customerId: alice.id as string, amount: 200 });
await store.settle();
// { name: 'Alice', tier: 'pro', orderCount: 2, totalSpent: 300 }

await customers.update(alice.id, { tier: 'enterprise' });
await store.settle();
// { name: 'Alice', tier: 'enterprise', orderCount: 2, totalSpent: 300 }

unsub();
```

Tento dotaz závisí jak na `customers` (na úrovni záznamu přes `get()`), tak na `orders` (na úrovni bucketu přes `where()`). Store sleduje obě závislosti a přehodnocuje při změně kterékoliv z nich.

## Zpracování chyb

### Chyby při počátečním odběru

Pokud funkce dotazu vyhodí chybu během počátečního volání `subscribe()`, chyba se propaguje k volajícímu a žádný odběr se nevytvoří:

```typescript
store.defineQuery('failing', async () => {
  throw new Error('Something broke');
});

try {
  await store.subscribe('failing', () => {});
} catch (err) {
  console.log(err.message); // Something broke
}
// Žádný odběr nebyl vytvořen
```

### Chyby během přehodnocení

Pokud funkce dotazu vyhodí chybu během následného přehodnocení (spuštěného změnou dat), chyba se spolkne a odběr přežije. Callback se nevolá a předchozí výsledek se zachová:

```typescript
let shouldFail = false;

store.defineQuery('fragile', async (ctx) => {
  if (shouldFail) throw new Error('Temporary failure');
  return ctx.bucket('customers').count();
});

await store.subscribe('fragile', (count) => {
  console.log(`Počet: ${count}`);
});

await customers.insert({ name: 'Alice' });
await store.settle();
// Počet: 1

shouldFail = true;
await customers.insert({ name: 'Bob' });
await store.settle();
// Žádný výstup — chyba spolknuta, odběr přežívá

shouldFail = false;
await customers.insert({ name: 'Carol' });
await store.settle();
// Počet: 3 — odběr se zotavil
```

Tato odolnost znamená, že přechodné selhání (jako dočasný problém se sítí ve vlastním adaptéru) trvale nerozbije odběry.

## Kompletní funkční příklad

Katalog produktů s živými statistikami a filtrovanými pohledy:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'subscribe-demo' });

  await store.defineBucket('products', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      name:     { type: 'string', required: true },
      category: { type: 'string', enum: ['electronics', 'clothing', 'books'], required: true },
      price:    { type: 'number', required: true, min: 0 },
      inStock:  { type: 'boolean', default: true },
    },
    indexes: ['category'],
  });

  const products = store.bucket('products');

  // --- Definice dotazů ---

  // 1. Celkový počet produktů
  store.defineQuery('productCount', async (ctx) => {
    return ctx.bucket('products').count();
  });

  // 2. Produkty podle kategorie (parametrizovaný)
  store.defineQuery('byCategory', async (ctx, params: { category: string }) => {
    return ctx.bucket('products').where({ category: params.category });
  });

  // 3. Cenové statistiky
  store.defineQuery('priceStats', async (ctx) => {
    const bucket = ctx.bucket('products');
    const avg = await bucket.avg('price');
    const min = await bucket.min('price');
    const max = await bucket.max('price');
    const total = await bucket.sum('price');
    return { avg: Math.round(avg * 100) / 100, min, max, total };
  });

  // --- Odběry ---

  const unsub1 = await store.subscribe('productCount', (count) => {
    console.log(`[počet] ${count} produktů`);
  });

  const unsub2 = await store.subscribe(
    'byCategory',
    { category: 'electronics' },
    (result) => {
      console.log(`[elektronika] ${result.map((p: any) => p.name).join(', ')}`);
    },
  );

  const unsub3 = await store.subscribe('priceStats', (stats) => {
    console.log(`[ceny] prům=$${stats.avg} min=$${stats.min} max=$${stats.max}`);
  });

  // --- Mutace dat ---

  await products.insert({ name: 'Laptop', category: 'electronics', price: 999 });
  await store.settle();
  // [počet] 1 produktů
  // [elektronika] Laptop
  // [ceny] prům=$999 min=$999 max=$999

  await products.insert({ name: 'T-Shirt', category: 'clothing', price: 25 });
  await store.settle();
  // [počet] 2 produktů
  // [ceny] prům=$512 min=$25 max=$999
  // (callback elektroniky se nespustí — výsledek se nezměnil)

  await products.insert({ name: 'Keyboard', category: 'electronics', price: 75 });
  await store.settle();
  // [počet] 3 produktů
  // [elektronika] Laptop, Keyboard
  // [ceny] prům=$366.33 min=$25 max=$999

  // --- Jednorázový dotaz ---
  const bookCount = await store.runQuery('byCategory', { category: 'books' });
  console.log(`\nKnihy (jednorázově): ${(bookCount as any[]).length}`);
  // Knihy (jednorázově): 0

  // --- Úklid ---
  unsub1();
  unsub2();
  unsub3();
  await store.stop();
}

main();
```

## Cvičení

S přípravou z této kapitoly definujte a použijte následující reaktivní dotazy:

1. Definujte dotaz `'highValueOrders'`, který vrací všechny objednávky s `amount` větším než 200. Jelikož `where()` podporuje pouze striktní rovnost, načtěte všechny objednávky pomocí `all()` a filtrujte ve funkci dotazu.
2. Definujte parametrizovaný dotaz `'orderTotal'`, který přijímá `{ customerId: string }` a vrací součet všech částek objednávek pro daného zákazníka.
3. Přihlaste se k odběru `'highValueOrders'` a logujte počet objednávek s vysokou hodnotou.
4. Přihlaste se k odběru `'orderTotal'` pro dvě různá ID zákazníků a logujte každý součet.
5. Vložte objednávky pro oba zákazníky, pak použijte `runQuery()` k ověření výsledku `'orderTotal'` pro jednoho z nich.

<details>
<summary>Řešení</summary>

```typescript
// 1. Objednávky s vysokou hodnotou (bez parametrů, závislost na úrovni bucketu)
store.defineQuery('highValueOrders', async (ctx) => {
  const all = await ctx.bucket('orders').all();
  return all.filter((o) => (o.amount as number) > 200);
});

// 2. Parametrizovaný celkový součet objednávek na zákazníka
store.defineQuery('orderTotal', async (ctx, params: { customerId: string }) => {
  const customerOrders = await ctx.bucket('orders').where({
    customerId: params.customerId,
  });
  return customerOrders.reduce((sum, o) => sum + (o.amount as number), 0);
});

// 3. Odběr objednávek s vysokou hodnotou
const unsubHigh = await store.subscribe('highValueOrders', (result) => {
  console.log(`Objednávky s vysokou hodnotou: ${result.length}`);
});

// 4. Odběr součtů objednávek pro dva zákazníky
const alice = await customers.insert({ name: 'Alice' });
const bob = await customers.insert({ name: 'Bob' });

const unsubAlice = await store.subscribe(
  'orderTotal',
  { customerId: alice.id as string },
  (total) => {
    console.log(`Alice celkem: $${total}`);
  },
);

const unsubBob = await store.subscribe(
  'orderTotal',
  { customerId: bob.id as string },
  (total) => {
    console.log(`Bob celkem: $${total}`);
  },
);

// 5. Vložení objednávek a ověření
await orders.insert({ customerId: alice.id as string, amount: 300 });
await orders.insert({ customerId: bob.id as string, amount: 150 });
await orders.insert({ customerId: alice.id as string, amount: 500 });
await store.settle();
// Objednávky s vysokou hodnotou: 2
// Alice celkem: $800
// Bob celkem: $150

const aliceTotal = await store.runQuery('orderTotal', { customerId: alice.id as string });
console.log(`Ověřený součet Alice: $${aliceTotal}`); // Ověřený součet Alice: $800

// Úklid
unsubHigh();
unsubAlice();
unsubBob();
```

</details>

## Shrnutí

- **`store.defineQuery(name, fn)`** registruje pojmenovanou funkci dotazu, která přijímá `QueryContext` pouze pro čtení — názvy musí být unikátní
- **`store.subscribe(name, callback)`** spustí živý odběr: vykoná dotaz, sleduje závislosti a volá callback při následných změnách
- **Callback se nevolá pro počáteční výsledek** — pouze pro změny po přihlášení k odběru
- **`store.runQuery(name, params?)`** vykoná dotaz jednou bez vytvoření odběru — použijte pro snapshoty a testy
- **Parametrizované dotazy** přijímají druhý argument: `subscribe(name, params, callback)` — každá dvojice `(název, parametry)` je nezávislý odběr
- **`store.settle()`** čeká na dokončení všech čekajících přehodnocení — nezbytné v testech, zřídka potřebné v produkci
- **Chyby při počátečním subscribe** se propagují k volajícímu; **chyby během přehodnocení** se spolknou a odběr přežije
- **Dotazy napříč buckety** čtou z více bucketů a store sleduje závislosti na všech automaticky

---

Další: [Sledování závislostí](./03-sledovani-zavislosti.md)
