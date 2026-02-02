# Sledování závislostí

Definovali jste dotazy a přihlásili se k jejich odběru. Store znovu vyhodnocuje dotazy při změně dat a volá váš callback pouze tehdy, když se výsledek liší. Ale jak store ví, které dotazy znovu spustit? Nepřehodnocuje každý dotaz při každé mutaci — to by byl polling v přestrojení. Místo toho používá dvouúrovňový systém sledování závislostí, který přesně pozoruje, co každý dotaz čte, a buduje přesnou invalidační mapu.

Tato kapitola vysvětluje vnitřní mechanismy: jak `QueryContext` zaznamenává závislosti, jak se liší sledování na úrovni bucketu a záznamu, jak funguje invalidační index a jak se závislosti dynamicky aktualizují při každém přehodnocení.

## Co se naučíte

- Jak `QueryContext` sleduje závislosti pomocí zachytávání metod
- Rozdíl mezi závislostmi na úrovni bucketu a na úrovni záznamu
- Které metody vytvářejí který typ závislosti
- Jak invalidační index mapuje změny dat na dotčené odběry
- Jak `deepEqual()` zabraňuje zbytečným callbackům
- Jak se závislosti dynamicky aktualizují, když se logika dotazu mezi přehodnoceními změní

## Příprava

Všechny příklady v této kapitole používají následující store:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'deps-demo' });

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

await store.defineBucket('products', {
  key: 'sku',
  schema: {
    sku:   { type: 'string', required: true },
    name:  { type: 'string', required: true },
    price: { type: 'number', required: true, min: 0 },
  },
});

const customers = store.bucket('customers');
const orders = store.bucket('orders');
const products = store.bucket('products');
```

## Dvě úrovně závislostí

Když se funkce dotazu spustí, `QueryContext` zachytává každé volání metody na proxy bucketu pouze pro čtení a zaznamenává, k čemu se přistupovalo. Existují dvě úrovně sledování:

### Závislosti na úrovni záznamu

Metoda `get(key)` vytváří **závislost na úrovni záznamu**. Store zaznamená jak název bucketu, tak konkrétní klíč:

```typescript
store.defineQuery('singleCustomer', async (ctx, params: { id: string }) => {
  return ctx.bucket('customers').get(params.id);
});
```

```text
  Závislosti:
  ┌──────────────────────────────────────┐
  │  recordLevel:                        │
  │    customers -> { params.id }        │
  │                                      │
  │  bucketLevel:                        │
  │    (prázdné)                         │
  └──────────────────────────────────────┘
```

**Sledování na úrovni záznamu je chirurgicky přesné.** Tento dotaz se přehodnotí pouze tehdy, když je konkrétní záznam identifikovaný `params.id` vložen, aktualizován nebo smazán. Změny jiných záznamů v bucketu `customers` jsou ignorovány.

### Závislosti na úrovni bucketu

Každá metoda kromě `get()` vytváří **závislost na úrovni bucketu**. Store zaznamenává pouze název bucketu — jakákoliv změna v tomto bucketu spustí přehodnocení:

```typescript
store.defineQuery('allPending', async (ctx) => {
  return ctx.bucket('orders').where({ status: 'pending' });
});
```

```text
  Závislosti:
  ┌──────────────────────────────────────┐
  │  recordLevel:                        │
  │    (prázdné)                         │
  │                                      │
  │  bucketLevel:                        │
  │    { orders }                        │
  └──────────────────────────────────────┘
```

**Sledování na úrovni bucketu je široké.** Tento dotaz se přehodnotí při jakémkoliv vložení, aktualizaci nebo smazání v bucketu `orders` — i když mutace neovlivňuje čekající objednávky.

## Mapování metod na závislosti

| Metoda | Úroveň závislosti | Co se sleduje |
|---|---|---|
| `get(key)` | Úroveň záznamu | Název bucketu + konkrétní klíč |
| `all()` | Úroveň bucketu | Název bucketu |
| `where(filter)` | Úroveň bucketu | Název bucketu |
| `findOne(filter)` | Úroveň bucketu | Název bucketu |
| `count(filter?)` | Úroveň bucketu | Název bucketu |
| `first(n)` | Úroveň bucketu | Název bucketu |
| `last(n)` | Úroveň bucketu | Název bucketu |
| `paginate(options)` | Úroveň bucketu | Název bucketu |
| `sum(field, filter?)` | Úroveň bucketu | Název bucketu |
| `avg(field, filter?)` | Úroveň bucketu | Název bucketu |
| `min(field, filter?)` | Úroveň bucketu | Název bucketu |
| `max(field, filter?)` | Úroveň bucketu | Název bucketu |

Důvod: `get()` přistupuje ke známému, konkrétnímu záznamu. Všechny ostatní metody skenují nebo agregují — store nemůže předvídat, které záznamy přispějí k výsledku, takže konzervativně sleduje celý bucket.

## Sledování na úrovni záznamu v praxi

Závislosti na úrovni záznamu umožňují přesnou invalidaci. Když dotaz používá `get()`, pouze změny tohoto konkrétního záznamu spustí přehodnocení:

```typescript
const alice = await customers.insert({ name: 'Alice', tier: 'pro' });
const bob = await customers.insert({ name: 'Bob', tier: 'free' });

store.defineQuery('watchAlice', async (ctx) => {
  return ctx.bucket('customers').get(alice.id);
});

let callCount = 0;
await store.subscribe('watchAlice', () => {
  callCount++;
});

// Aktualizace Alice — sledovaný záznam
await customers.update(alice.id, { tier: 'enterprise' });
await store.settle();
console.log(callCount); // 1 — přehodnoceno a výsledek se změnil

// Aktualizace Boba — jiný záznam
await customers.update(bob.id, { tier: 'pro' });
await store.settle();
console.log(callCount); // 1 — vůbec se nepřehodnotilo

// Vložení nového zákazníka — také nesouvisí
await customers.insert({ name: 'Carol', tier: 'free' });
await store.settle();
console.log(callCount); // 1 — stále se nepřehodnotilo
```

Sledování na úrovni záznamu je ideální pro dotazy, které vyhledávají malý počet konkrétních záznamů. Vyhýbá se zbytečným přehodnocením, když má bucket vysoký provoz zápisů na jiných záznamech.

## Sledování na úrovni bucketu v praxi

Závislosti na úrovni bucketu jsou hrubší — jakákoliv mutace v bucketu spustí přehodnocení:

```typescript
store.defineQuery('pendingCount', async (ctx) => {
  return ctx.bucket('orders').count({ status: 'pending' });
});

let callCount = 0;
await store.subscribe('pendingCount', (count) => {
  callCount++;
  console.log(`Čekajících: ${count}`);
});

// Vložení čekající objednávky — výsledek se změní
await orders.insert({ customerId: 'id-1', amount: 100 });
await store.settle();
// Čekajících: 1
console.log(callCount); // 1

// Vložení ZAPLACENÉ objednávky — dotaz se přehodnotí, ale výsledek je stejný
await orders.insert({ customerId: 'id-2', amount: 200, status: 'paid' });
await store.settle();
console.log(callCount); // 1 — přehodnoceno, ale deepEqual zabránil callbacku
```

Dotaz se přehodnotil při vložení zaplacené objednávky (protože `count()` vytváří závislost na úrovni bucketu), ale `deepEqual` detekoval, že se výsledek nezměnil, a potlačil callback.

## Smíšené závislosti

Dotaz může mít závislosti jak na úrovni záznamu, tak na úrovni bucketu, i na stejném bucketu:

```typescript
store.defineQuery(
  'customerDashboard',
  async (ctx, params: { customerId: string }) => {
    // Závislost na úrovni záznamu na 'customers'
    const customer = await ctx.bucket('customers').get(params.customerId);

    // Závislost na úrovni bucketu na 'orders'
    const customerOrders = await ctx.bucket('orders').where({
      customerId: params.customerId,
    });

    return {
      name: customer?.name,
      orderCount: customerOrders.length,
      totalSpent: customerOrders.reduce((sum, o) => sum + (o.amount as number), 0),
    };
  },
);
```

```text
  Závislosti:
  ┌──────────────────────────────────────┐
  │  recordLevel:                        │
  │    customers -> { params.customerId }│
  │                                      │
  │  bucketLevel:                        │
  │    { orders }                        │
  └──────────────────────────────────────┘
```

Tento dotaz se přehodnotí, když:
- Se změní konkrétní záznam zákazníka (podle `params.customerId`) — úroveň záznamu
- Se změní jakýkoliv záznam v `orders` — úroveň bucketu
- **Nepřehodnotí** se, když se změní jiný záznam zákazníka

### Úroveň bucketu pohlcuje úroveň záznamu

Pokud dotaz používá jak `get()`, tak `where()` na stejném bucketu, závislost na úrovni bucketu má přednost pro invalidaci:

```typescript
store.defineQuery('mixed', async (ctx, params: { id: string }) => {
  // Úroveň záznamu: get(id)
  const record = await ctx.bucket('customers').get(params.id);
  // Úroveň bucketu: where() na stejném bucketu
  const allPro = await ctx.bucket('customers').where({ tier: 'pro' });
  return { record, proCount: allPro.length };
});
```

```text
  Závislosti:
  ┌──────────────────────────────────────┐
  │  recordLevel:                        │
  │    customers -> { params.id }        │
  │                                      │
  │  bucketLevel:                        │
  │    { customers }                     │
  └──────────────────────────────────────┘

  Efektivní chování:
    Jakákoliv změna v 'customers' spustí přehodnocení
    (úroveň bucketu odpovídá všem mutacím, čímž se úroveň záznamu stává redundantní)
```

## Invalidační index

Store udržuje dva interní indexy pro efektivní vyhledávání dotčených odběrů při změně dat:

```text
  Index na úrovni bucketu           Index na úrovni záznamu
  ┌──────────────────────┐          ┌──────────────────────────────┐
  │  orders -> { sub1,   │          │  customers                   │
  │             sub3 }   │          │    alice-id -> { sub2 }      │
  │                      │          │    bob-id   -> { sub4 }      │
  │  customers -> { sub5 }│          │                              │
  └──────────────────────┘          │  orders                      │
                                    │    (žádné — vše na úr. buck.)│
                                    └──────────────────────────────┘
```

Když se aktualizuje záznam `orders` s klíčem `42`, store:
1. Vyhledá `bucketLevelIndex['orders']` → najde `{ sub1, sub3 }`
2. Vyhledá `recordLevelIndex['orders'][42]` → najde `{}` (prázdné)
3. Sloučí: `{ sub1, sub3 }` — tyto odběry potřebují přehodnocení

Když se aktualizuje záznam `customers` `alice-id`:
1. Vyhledá `bucketLevelIndex['customers']` → najde `{ sub5 }`
2. Vyhledá `recordLevelIndex['customers']['alice-id']` → najde `{ sub2 }`
3. Sloučí: `{ sub2, sub5 }` — tyto odběry potřebují přehodnocení

Toto dvouindexové vyhledávání je O(1) na bucket a O(1) na klíč, což činí invalidaci efektivní i s mnoha odběry.

## `deepEqual()` — Porovnání výsledků

Po přehodnocení store porovná nový výsledek s předchozím. Pokud jsou hluboce rovné, callback se přeskočí:

```typescript
store.defineQuery('tierCounts', async (ctx) => {
  const bucket = ctx.bucket('customers');
  return {
    free: await bucket.count({ tier: 'free' }),
    pro: await bucket.count({ tier: 'pro' }),
    enterprise: await bucket.count({ tier: 'enterprise' }),
  };
});

let updates = 0;
await store.subscribe('tierCounts', () => {
  updates++;
});

// Vložení free zákazníka
await customers.insert({ name: 'Alice', tier: 'free' });
await store.settle();
console.log(updates); // 1

// Aktualizace jména Alice (tier nezměněn)
await customers.update((await customers.findOne({ name: 'Alice' }))!.id, { name: 'Alicia' });
await store.settle();
// Dotaz se přehodnotil (závislost na úrovni bucketu na customers)
// Výsledek: { free: 1, pro: 0, enterprise: 0 } — stejný jako předtím
console.log(updates); // 1 — deepEqual zabránil callbacku
```

### Co `deepEqual` porovnává

Kontrola hluboké rovnosti zvládá:

| Typ | Porovnání |
|---|---|
| Primitivy (`string`, `number`, `boolean`, `null`, `undefined`) | `===` |
| `NaN` | `NaN === NaN` → `true` |
| `Date` | Porovnání `.getTime()` |
| `RegExp` | Porovnání `.source` + `.flags` |
| Pole | Rekurzivní porovnání prvek po prvku |
| Prosté objekty | Rekurzivní porovnání klíč po klíči (stejný počet klíčů, stejné klíče, stejné hodnoty) |

To znamená, že potlačení callbacku funguje správně pro:
- Skalární výsledky (`number`, `string`)
- Výsledky v polích (seznamy záznamů)
- Objektové výsledky (agregační objekty)
- Vnořené struktury (objekty obsahující pole objektů)

## Dynamické závislosti

Závislosti se zachytávají znovu při každém přehodnocení. Pokud je logika dotazu podmíněná, sada závislostí se může mezi vykonáními měnit:

```typescript
const alice = await customers.insert({ name: 'Alice', tier: 'pro' });
const bob = await customers.insert({ name: 'Bob', tier: 'free' });

let targetId = alice.id as string;

store.defineQuery('dynamicTarget', async (ctx) => {
  return ctx.bucket('customers').get(targetId);
});

const results: any[] = [];
await store.subscribe('dynamicTarget', (result) => {
  results.push(result);
});

// Aktualizace Alice — spustí callback (sledovaný záznam)
await customers.update(alice.id, { name: 'Alicia' });
await store.settle();
console.log(results.length); // 1
console.log(results[0].name); // Alicia

// Přepnutí cíle na Boba
targetId = bob.id as string;

// Další aktualizace Alice — stále spouští přehodnocení
// protože store ještě nezachytil nové závislosti
// Ale dotaz nyní čte Boba, takže se závislosti aktualizují
await customers.update(alice.id, { name: 'Alice' });
await store.settle();
// Po přehodnocení jsou závislosti nyní: customers -> { bob.id }
// Výsledek se změnil (nyní vrací Boba), takže se callback spustí
console.log(results.length); // 2
console.log(results[1].name); // Bob

// Nyní aktualizace Alice nespustí přehodnocení
// protože invalidační index ukazuje na Boba
await customers.update(alice.id, { tier: 'enterprise' });
await store.settle();
console.log(results.length); // 2 — změna Alice se již nesleduje
```

### Jak se dynamické závislosti aktualizují

```text
  Počáteční odběr:
    targetId = alice.id
    Dotaz čte: get(alice.id)
    Závislosti: customers -> { alice.id }
                                                    ┌───────────────┐
  Po změně Alice, přehodnocení:                     │ STARÉ závisl. │
    targetId = bob.id (změněno externě)             │ alice.id      │
    Dotaz čte: get(bob.id)                          └───────┬───────┘
    Nové závislosti: customers -> { bob.id }                │
                                                            v
    Store detekuje změnu závislostí                 ┌───────────────┐
    Odstraní starý index: alice.id -> sub           │ NOVÉ závisl.  │
    Přidá nový index: bob.id -> sub                 │ bob.id        │
                                                    └───────────────┘
  Budoucí mutace:
    Změna Alice -> žádné přehodnocení (neindexováno)
    Změna Boba  -> přehodnocení (indexováno)
```

Dynamické závislosti jsou nezbytné pro dotazy, které navigují vztahy. Například dotaz, který nejprve přečte zákazníka, pak vyhledá jeho objednávky podle ID — pokud se zákazník změní, změní se i sada objednávek.

## Vzory závislostí napříč buckety

### Vzor 1: Jeden bucket, pouze úroveň záznamu

```typescript
// Sleduje přesně dva záznamy — minimální invalidační plocha
store.defineQuery('twoCustomers', async (ctx, params: { id1: string; id2: string }) => {
  const a = await ctx.bucket('customers').get(params.id1);
  const b = await ctx.bucket('customers').get(params.id2);
  return [a, b];
});
// Závislosti: recordLevel { customers -> { id1, id2 } }
// Přehodnotí se pouze při změně id1 nebo id2
```

### Vzor 2: Jeden bucket, úroveň bucketu

```typescript
// Agreguje celý bucket — jakákoliv změna spustí přehodnocení
store.defineQuery('orderStats', async (ctx) => {
  const bucket = ctx.bucket('orders');
  return {
    total: await bucket.count(),
    revenue: await bucket.sum('amount'),
    avgOrder: await bucket.avg('amount'),
  };
});
// Závislosti: bucketLevel { orders }
// Přehodnotí se při jakékoliv mutaci orders
```

### Vzor 3: Více bucketů, smíšené úrovně

```typescript
// Úroveň záznamu na customers, úroveň bucketu na orders
store.defineQuery('customerReport', async (ctx, params: { customerId: string }) => {
  const customer = await ctx.bucket('customers').get(params.customerId);
  const customerOrders = await ctx.bucket('orders').where({
    customerId: params.customerId,
  });
  const topProduct = customerOrders.length > 0
    ? await ctx.bucket('products').get(customerOrders[0].productSku as string)
    : null;
  return { customer, orders: customerOrders, topProduct };
});
// Závislosti:
//   recordLevel: { customers -> { customerId }, products -> { productSku } }
//   bucketLevel: { orders }
```

### Vzor 4: Podmíněné závislosti

```typescript
// Závislosti se mění na základě dat
store.defineQuery('conditionalQuery', async (ctx, params: { customerId: string }) => {
  const customer = await ctx.bucket('customers').get(params.customerId);
  if (!customer) return null;

  // Čte objednávky pouze pokud zákazník existuje — závislost je podmíněná
  if (customer.tier === 'enterprise') {
    return ctx.bucket('orders').where({ customerId: params.customerId });
  }

  return [];
});
// Pokud zákazník existuje a je enterprise:
//   recordLevel: { customers -> { customerId } }
//   bucketLevel: { orders }
// Pokud zákazník neexistuje nebo není enterprise:
//   recordLevel: { customers -> { customerId } }
//   bucketLevel: (prázdné) — k bucketu orders se nepřistupovalo
```

## Kompletní funkční příklad

Demonstrace přesnosti sledování závislostí s počítadly:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'deps-tracking-demo' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:   { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
      role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
    },
  });

  await store.defineBucket('posts', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      authorId: { type: 'string', required: true },
      title:    { type: 'string', required: true },
      draft:    { type: 'boolean', default: true },
    },
    indexes: ['authorId'],
  });

  const users = store.bucket('users');
  const posts = store.bucket('posts');

  const alice = await users.insert({ name: 'Alice', role: 'admin' });
  const bob = await users.insert({ name: 'Bob' });

  // Dotaz 1: úroveň záznamu — sleduje jednoho konkrétního uživatele
  store.defineQuery('watchUser', async (ctx, params: { userId: string }) => {
    return ctx.bucket('users').get(params.userId);
  });

  // Dotaz 2: úroveň bucketu — počítá všechny publikované příspěvky
  store.defineQuery('publishedCount', async (ctx) => {
    const all = await ctx.bucket('posts').all();
    return all.filter((p) => !p.draft).length;
  });

  let userUpdates = 0;
  let postUpdates = 0;

  const unsub1 = await store.subscribe(
    'watchUser',
    { userId: alice.id as string },
    (user) => {
      userUpdates++;
      console.log(`[uživatel #${userUpdates}] ${(user as any).name} (${(user as any).role})`);
    },
  );

  const unsub2 = await store.subscribe('publishedCount', (count) => {
    postUpdates++;
    console.log(`[příspěvky #${postUpdates}] Publikováno: ${count}`);
  });

  // --- Test přesnosti na úrovni záznamu ---

  // Aktualizace Alice — spustí watchUser
  await users.update(alice.id, { name: 'Alicia' });
  await store.settle();
  // [uživatel #1] Alicia (admin)

  // Aktualizace Boba — NESPUSTÍ watchUser (jiný záznam)
  await users.update(bob.id, { role: 'admin' });
  await store.settle();
  console.log(`Aktualizace uživatele po změně Boba: ${userUpdates}`); // 1

  // --- Test úrovně bucketu s deepEqual ---

  // Vložení konceptu příspěvku — dotaz se přehodnotí, ale počet publikovaných nezměněn
  await posts.insert({ authorId: alice.id as string, title: 'Koncept', draft: true });
  await store.settle();
  console.log(`Aktualizace příspěvků po vložení konceptu: ${postUpdates}`); // 0

  // Publikování příspěvku — počet se změní
  await posts.update(1, { draft: false });
  await store.settle();
  // [příspěvky #1] Publikováno: 1

  // Vložení dalšího konceptu — počet stále 1, callback potlačen
  await posts.insert({ authorId: bob.id as string, title: 'Další koncept', draft: true });
  await store.settle();
  console.log(`Aktualizace příspěvků po druhém konceptu: ${postUpdates}`); // 1

  console.log(`\nFinální: ${userUpdates} aktualizací uživatele, ${postUpdates} aktualizací příspěvků`);
  // Finální: 1 aktualizací uživatele, 1 aktualizací příspěvků

  unsub1();
  unsub2();
  await store.stop();
}

main();
```

## Cvičení

S přípravou z této kapitoly předpovězte chování a ověřte:

1. Definujte dotaz `'productLookup'`, který používá `get(sku)` k načtení jednoho produktu podle SKU.
2. Definujte dotaz `'expensiveOrders'`, který používá `where()` k nalezení objednávek se `status: 'paid'`.
3. Přihlaste se k odběru obou dotazů.
4. Vložte produkt s SKU `'WIDGET-1'`. Spustí se callback `productLookup`? Spustí se callback `expensiveOrders`?
5. Vložte objednávku se `status: 'pending'`. Spustí se callback `expensiveOrders`?
6. Aktualizujte čekající objednávku na `status: 'paid'`. Spustí se callback `expensiveOrders`?
7. Vložte nový produkt s SKU `'GADGET-2'`. Spustí se callback `productLookup`?

<details>
<summary>Řešení</summary>

```typescript
// 1. Závislost na úrovni záznamu na products
store.defineQuery('productLookup', async (ctx) => {
  return ctx.bucket('products').get('WIDGET-1');
});

// 2. Závislost na úrovni bucketu na orders
store.defineQuery('expensiveOrders', async (ctx) => {
  return ctx.bucket('orders').where({ status: 'paid' });
});

let productCalls = 0;
let orderCalls = 0;

const unsub1 = await store.subscribe('productLookup', () => { productCalls++; });
const unsub2 = await store.subscribe('expensiveOrders', () => { orderCalls++; });

// 4. Vložení produktu WIDGET-1
await products.insert({ sku: 'WIDGET-1', name: 'Widget', price: 10 });
await store.settle();
console.log(`Volání product: ${productCalls}`); // 1 — sledovaný záznam byl vytvořen
console.log(`Volání order: ${orderCalls}`);     // 0 — bucket products není závislost

// 5. Vložení čekající objednávky
await orders.insert({ customerId: 'x', amount: 100, status: 'pending' });
await store.settle();
// expensiveOrders se přehodnotí (závislost na úrovni bucketu na orders)
// Ale výsledek je stále [] (žádné zaplacené objednávky) — deepEqual potlačí callback
console.log(`Volání order: ${orderCalls}`); // 0

// 6. Aktualizace na paid
await orders.update(1, { status: 'paid' });
await store.settle();
// expensiveOrders se přehodnotí, výsledek se změnil z [] na [záznam]
console.log(`Volání order: ${orderCalls}`); // 1

// 7. Vložení GADGET-2
await products.insert({ sku: 'GADGET-2', name: 'Gadget', price: 20 });
await store.settle();
// productLookup závisí na záznamu 'WIDGET-1', ne 'GADGET-2'
// Sledování na úrovni záznamu — jiný klíč, žádné přehodnocení
console.log(`Volání product: ${productCalls}`); // 1 — nezměněno

unsub1();
unsub2();
```

</details>

## Shrnutí

- **Závislosti na úrovni záznamu** (`get(key)`) sledují konkrétní klíče — dotaz se přehodnotí pouze při změně těchto přesných záznamů
- **Závislosti na úrovni bucketu** (všechny ostatní metody) sledují celé buckety — jakákoliv mutace spustí přehodnocení
- Store udržuje **dvouindexovou strukturu**: index na úrovni bucketu (bucket → odběry) a index na úrovni záznamu (bucket + klíč → odběry) pro O(1) vyhledávání invalidace
- **`deepEqual()`** porovnává výsledky po přehodnocení — callback se spustí pouze když se výsledek skutečně liší, zvládá primitivy, pole, objekty, data a vnořené struktury
- **Dynamické závislosti** se zachytávají znovu při každém přehodnocení — pokud logika dotazu změní, která data čte, invalidační index se odpovídajícím způsobem aktualizuje
- Smíšené závislosti (úroveň záznamu na jednom bucketu, úroveň bucketu na jiném) dávají jemnozrnnou kontrolu nad invalidací
- **Úroveň bucketu pohlcuje úroveň záznamu** na stejném bucketu — jakmile se použije `where()` nebo jakákoliv skenovací metoda, všechny mutace v daném bucketu spustí přehodnocení
- Sledování závislostí je **automatické a implicitní** — píšete normální kód dotazu a store ho instrumentuje na pozadí skrze `QueryContext`

---

Další: [Systém událostí](../06-udalosti/01-system-udalosti.md)
