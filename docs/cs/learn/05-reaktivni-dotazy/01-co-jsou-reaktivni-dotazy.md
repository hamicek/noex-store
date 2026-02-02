# Co jsou reaktivní dotazy?

Váš dashboard zobrazuje seznam nevyřízených objednávek. Kolega vloží novou objednávku z jiné části systému. Váš dashboard stále ukazuje starý počet. Kliknete na obnovit — teď se aktualizuje. Za minutu někdo objednávku zruší. Zase zastaralé data. Nastavíte polling interval, ale teď volíte mezi plýtváním CPU cykly (příliš častý polling) a zastaralými daty (příliš pomalý polling). A když máte deset komponent, z nichž každá polluje jiný bucket, režie se rychle sčítá.

noex-store toto řeší **reaktivními dotazy** — funkcemi, které se automaticky znovu vyhodnotí, když se změní data, která čtou, a pushují aktualizované výsledky odběratelům. Žádný polling, žádné manuální obnovování, žádné propojování událostí. Definujete dotaz jednou, přihlásíte se k odběru a store se postará o zbytek.

## Co se naučíte

- Proč polling a manuální propojování událostí selhávají pro real-time data
- Jak se reaktivní dotazy liší od událostí a pollingu
- Životní cyklus odběru: definice, přihlášení, příjem aktualizací, odhlášení
- Jak store ví, které dotazy znovu spustit při změně dat
- Co znamená reaktivita „ve stylu Convex" a proč na tom záleží
- Kdy jsou reaktivní dotazy správný nástroj vs události nebo manuální čtení

## Problém: Udržení dat v synchronizaci

Představte si jednoduchý dashboard zobrazující statistiky objednávek:

```typescript
// Manuální přístup — dotaz jednou, doufejte v to nejlepší
const orders = store.bucket('orders');

const pending = await orders.where({ status: 'pending' });
const total = await orders.count();

renderDashboard({ pendingCount: pending.length, totalOrders: total });

// Nová objednávka vložená jinde — dashboard je nyní zastaralý
// Žádný mechanismus pro detekci a znovu-vykreslení
```

Existují tři běžné pokusy o opravu:

### Přístup 1: Polling

```typescript
setInterval(async () => {
  const pending = await orders.where({ status: 'pending' });
  const total = await orders.count();
  renderDashboard({ pendingCount: pending.length, totalOrders: total });
}, 1000);
```

**Problémy:**
- Plýtvá zdroji, když se nic nezměnilo (většina pollů vrací identická data)
- Stále zastaralé mezi intervaly — 1 sekunda není okamžité
- Více komponent s pollingem vytváří duplicitní práci
- Žádný čistý způsob zastavení pollingu při odpojení komponenty

### Přístup 2: Manuální propojení událostí

```typescript
let pendingCount = 0;
let totalOrders = 0;

// Počáteční načtení
const pending = await orders.where({ status: 'pending' });
pendingCount = pending.length;
totalOrders = await orders.count();
renderDashboard({ pendingCount, totalOrders });

// Naslouchat každé mutaci a znovu dotazovat
await store.on('bucket.orders.*', async () => {
  const pending = await orders.where({ status: 'pending' });
  pendingCount = pending.length;
  totalOrders = await orders.count();
  renderDashboard({ pendingCount, totalOrders });
});
```

**Problémy:**
- Znovu dotazuje při každé mutaci, i těch, které neovlivní výsledek
- Musíte manuálně sledovat, které buckety poslouchat
- Duplicitní logika dotazu mezi počátečním načtením a handlerem událostí
- Těžko skládatelné — dotaz čtoucí ze tří bucketů potřebuje tři odběry událostí
- Žádná deduplikace — pokud se výsledek nezměnil, stejně překreslíte

### Přístup 3: Reaktivní dotazy

```typescript
store.defineQuery('dashboardStats', async (ctx) => {
  const orders = ctx.bucket('orders');
  const pending = await orders.where({ status: 'pending' });
  const total = await orders.count();
  return { pendingCount: pending.length, totalOrders: total };
});

await store.subscribe('dashboardStats', (stats) => {
  renderDashboard(stats);
});
```

**Výhody:**
- Logika dotazu definována jednou — žádná duplikace
- Store automaticky detekuje, které buckety dotaz čte
- Znovu vyhodnotí pouze při změně relevantních dat
- Callback se spustí pouze když se výsledek skutečně liší (kontrola hluboké rovnosti)
- Čisté odhlášení pro úklid

## Srovnání: Tři přístupy

| | Polling | Události + manuální dotaz | Reaktivní dotazy |
|---|---|---|---|
| **Aktuálnost** | Zpožděná (interval) | Okamžitá | Okamžitá |
| **Zbytečná práce** | Vysoká (většina pollů redundantní) | Střední (znovu dotazuje při všech mutacích) | Nízká (znovu dotazuje pouze při relevantních změnách) |
| **Duplikace dotazů** | Ano (v callback intervalu) | Ano (počáteční + handler událostí) | Ne (jediná definice) |
| **Více bucketů** | Jeden interval na bucket | Jeden listener na bucket | Automatické sledování |
| **Deduplikace výsledků** | Žádná | Žádná | Vestavěná (deepEqual) |
| **Úklid** | clearInterval | Více volání unsub | Jedno volání unsub |

## Jak reaktivní dotazy fungují

Systém reaktivních dotazů má tři fáze:

```text
  Fáze 1: DEFINICE           Fáze 2: ODBĚR                    Fáze 3: REAKCE
  ┌───────────────────┐      ┌───────────────────────────┐     ┌──────────────────────┐
  │                   │      │                           │     │                      │
  │  defineQuery(     │      │  subscribe(               │     │  Data se změní v     │
  │    'stats',       │      │    'stats',               │     │  bucketu 'orders'    │
  │    async (ctx) => │      │    (result) => { ... }    │     │                      │
  │      ...          │      │  )                        │     │  Store detekuje, že  │
  │  )                │      │                           │     │  'stats' čte z       │
  │                   │ ───> │  1. Vykonat dotaz         │     │  'orders'            │
  │  Zaregistruje     │      │  2. Sledovat závislosti   │  >  │                      │
  │  funkci dotazu    │      │  3. Uložit počáteční výsl.│     │  Znovu vykonat dotaz │
  │  podle jména      │      │  4. Vrátit unsub funkci   │     │  Porovnat výsledky   │
  │                   │      │                           │     │  Zavolat callback    │
  │                   │      │                           │     │  pokud se změnil     │
  └───────────────────┘      └───────────────────────────┘     └──────────────────────┘
```

### Fáze 1: Definice

`defineQuery(name, fn)` zaregistruje pojmenovanou funkci dotazu. Funkce přijímá `QueryContext`, který poskytuje přístup k bucketům pouze pro čtení. Dotaz se nevykoná okamžitě.

### Fáze 2: Odběr

`subscribe(name, callback)` vykoná dotaz poprvé. Během vykonávání store sleduje každou metodu bucketu, kterou dotaz zavolá — tím se vytváří **sada závislostí**. Počáteční výsledek se uloží interně a vrátí se funkce pro odhlášení.

Poznámka: callback se **nevolá** s počátečním výsledkem. Spouští se pouze při následných změnách.

### Fáze 3: Reakce

Když se změní data v jakémkoli bucketu, store zkontroluje, které odběry na tomto bucketu závisí. Pro každý dotčený odběr se dotaz znovu vyhodnotí, zachytí se nová sada závislostí a nový výsledek se porovná s předchozím pomocí `deepEqual()`. Callback se spustí pouze pokud se výsledek skutečně změnil.

## Sledování závislostí: Klíčový princip

Nejdůležitější vlastností reaktivního systému je **automatické sledování závislostí**. Nedeklarujete, které buckety dotaz čte — store to zjistí pozorováním, které metody voláte:

```typescript
store.defineQuery('ordersByRegion', async (ctx, params: { region: string }) => {
  // Store vidí toto volání a zaznamenává: "tento dotaz závisí na 'orders'"
  const orders = await ctx.bucket('orders').where({ region: params.region });

  // Store vidí toto volání a zaznamenává: "tento dotaz závisí také na 'customers'"
  const customerIds = [...new Set(orders.map((o) => o.customerId))];
  const customers = await Promise.all(
    customerIds.map((id) => ctx.bucket('customers').get(id)),
  );

  return { orders, customers: customers.filter(Boolean) };
});
```

Tento dotaz závisí na dvou bucketech: `orders` (na úrovni bucketu, protože používá `where()`) a `customers` (na úrovni záznamů, protože používá `get()` s konkrétními klíči). Store sleduje obojí a přehodnocuje pouze tehdy, když je některá z těchto závislostí dotčena. Změna v nesouvisejícím bucketu jako `products` nemá žádný efekt.

Závislosti jsou **dynamické** — zachytávají se znovu při každém přehodnocení. Pokud dotaz podmíněně čte z různých bucketů na základě dat, sada závislostí se odpovídajícím způsobem aktualizuje.

## Kdy použít reaktivní dotazy

Reaktivní dotazy jsou správná volba, když:

- **Více spotřebitelů potřebuje stejná odvozená data** — definujte jednou, odebírejte mnohokrát
- **Data se často mění** a potřebujete okamžité aktualizace bez pollingu
- **Dotazy pokrývají více bucketů** a chcete automatické sledování závislostí
- **Záleží na deduplikaci výsledků** — vyhnete se zbytečným překreslením, když je výstup stejný

Události (`store.on()`) jsou lepší, když:

- Potřebujete reagovat na **jednotlivé mutace** (konkrétní záznam, který se změnil)
- Potřebujete **stav před/po** (události nesou `oldRecord` a `newRecord`)
- Budujete **vedlejší efekty** jako auditní logy nebo notifikace
- Záleží vám na **tom, jaká operace proběhla**, ne na agregovaném výsledku

Jednorázový `runQuery()` je lepší, když:

- Potřebujete výsledek **jednou** bez průběžných aktualizací
- Budujete API endpoint typu request/response
- Dotaz běží v kontextu, kde odběry nemají smysl (např. CLI nástroj)

## Kompletní funkční příklad

Živý dashboard reagující na změny objednávek:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'reactive-intro' });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:     { type: 'number', generated: 'autoincrement' },
      item:   { type: 'string', required: true },
      status: { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
      total:  { type: 'number', required: true, min: 0 },
    },
    indexes: ['status'],
  });

  const orders = store.bucket('orders');

  // Definice reaktivního dotazu
  store.defineQuery('orderSummary', async (ctx) => {
    const bucket = ctx.bucket('orders');
    const pending = await bucket.count({ status: 'pending' });
    const paid = await bucket.count({ status: 'paid' });
    const shipped = await bucket.count({ status: 'shipped' });
    const total = await bucket.count();
    return { pending, paid, shipped, total };
  });

  // Odběr — callback se spustí pouze při změně výsledku
  const unsub = await store.subscribe('orderSummary', (stats) => {
    console.log('[dashboard]', stats);
  });

  // Počáteční stav: zatím žádný callback (subscribe nevolá callback pro počáteční výsledek)

  await orders.insert({ item: 'Laptop', total: 999 });
  await store.settle();
  // [dashboard] { pending: 1, paid: 0, shipped: 0, total: 1 }

  await orders.insert({ item: 'Mouse', total: 25 });
  await store.settle();
  // [dashboard] { pending: 2, paid: 0, shipped: 0, total: 2 }

  await orders.update(1, { status: 'paid' });
  await store.settle();
  // [dashboard] { pending: 1, paid: 1, shipped: 0, total: 2 }

  await orders.update(1, { status: 'shipped' });
  await store.settle();
  // [dashboard] { pending: 1, paid: 0, shipped: 1, total: 2 }

  // Úklid
  unsub();
  await store.stop();
}

main();
```

## Cvičení

Máte store s buckety `tasks` a `users`. Aniž byste implementovali reaktivní dotazy (to bude v další kapitole), odpovězte na tyto konceptuální otázky:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    title:    { type: 'string', required: true },
    assignee: { type: 'string', required: true },
    done:     { type: 'boolean', default: false },
  },
  indexes: ['assignee'],
});

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
  },
});
```

Představte si reaktivní dotaz, který počítá nedokončené úkoly na uživatele:

```typescript
store.defineQuery('incompleteTasks', async (ctx) => {
  const tasks = await ctx.bucket('tasks').where({ done: false });
  return tasks.length;
});
```

1. Na kterých bucketech tento dotaz závisí?
2. Na jaké úrovni — úroveň bucketu nebo úroveň záznamu?
3. Pokud je vložen nový úkol s `done: true`, spustí se callback?
4. Pokud je aktualizováno jméno uživatele, spustí se callback?
5. Pokud je smazán úkol, znovu se dotaz vyhodnotí? Spustí se callback, pokud měl smazaný úkol `done: true`?

<details>
<summary>Řešení</summary>

1. Pouze `tasks` — dotaz volá `ctx.bucket('tasks').where(...)`, ale nikdy nepřistupuje k `users`.
2. Na úrovni bucketu — `where()` vytváří závislost na úrovni bucketu (jakákoliv změna v bucketu spustí přehodnocení).
3. Ano, dotaz se znovu vyhodnotí (jakákoliv změna v `tasks` ho spustí). Ale callback se spustí pouze pokud se počet skutečně změnil. Jelikož má nový úkol `done: true`, `where({ done: false })` vrací stejnou sadu, takže `deepEqual` nedetekuje žádnou změnu — **callback se nespustí**.
4. Ne — dotaz vůbec nezávisí na bucketu `users`. Změny v `users` nemají žádný efekt.
5. Ano, dotaz se znovu vyhodnotí (smazání je změna v `tasks`). Pokud měl smazaný úkol `done: true`, počet nedokončených se nezmění, takže `deepEqual` vrátí `true` — **callback se nespustí**. Pokud měl smazaný úkol `done: false`, počet se sníží, takže se callback spustí.

</details>

## Shrnutí

- **Polling** plýtvá zdroji a zavádí latenci; **manuální propojování událostí** duplikuje logiku a znovu dotazuje při každé mutaci
- **Reaktivní dotazy** definují funkci dotazu jednou a automaticky ji znovu vyhodnotí při změně podkladových dat
- Životní cyklus odběru je: `defineQuery()` pro registraci, `subscribe()` pro začátek příjmu aktualizací, odhlášení pro zastavení
- Store **sleduje závislosti automaticky** pozorováním, které metody bucketu dotaz volá během vykonávání
- Callbacky se spouštějí pouze při skutečné změně výsledku, ověřené **porovnáním hluboké rovnosti** (`deepEqual`)
- Závislosti jsou **dynamické** — zachytávají se znovu při každém přehodnocení a přizpůsobují se podmíněné logice dotazu
- Používejte reaktivní dotazy pro živé dashboardy a odvozená data; používejte události pro vedlejší efekty a reakce na úrovni mutací; používejte `runQuery()` pro jednorázová čtení
- `store.settle()` čeká na dokončení všech čekajících přehodnocení — nezbytné pro deterministické testování

---

Další: [Definice a odběr](./02-definice-a-odber.md)
