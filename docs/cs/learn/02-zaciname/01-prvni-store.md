# Váš první Store

Viděli jste, co noex-store nabízí na vysoké úrovni. Teď je čas psát skutečný kód. V této kapitole nainstalujete knihovnu, spustíte Store, prozkoumáte jeho stav a čistě ho ukončíte. Na konci budete mít běžící Store připravený na buckety.

## Co se naučíte

- Jak nainstalovat `@hamicek/noex-store` a jeho peer závislost
- Jak spustit Store pomocí `Store.start()` a nakonfigurovat ho přes `StoreOptions`
- Kompletní životní cyklus Store: start, běh, stop
- Jak prozkoumat běžící Store pomocí `getStats()`
- Jak počkat na dokončení asynchronní práce před asercemi nebo ukončením

## Instalace

noex-store je postaven na actor frameworku `@hamicek/noex`. Nainstalujte oba:

```bash
npm install @hamicek/noex-store @hamicek/noex
```

`@hamicek/noex` poskytuje primitiva GenServer, Supervisor a EventBus, která Store interně využívá. Později z něj budete importovat i adaptéry persistence.

## Spuštění Store

Store se vytváří asynchronní factory metodou `Store.start()`:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start();
```

To je vše. Store běží. Pod kapotou `start()` provede následující:

```text
  Store.start(options?)
        │
        ├── 1. Vytvoření EventBus (pro notifikace o změnách)
        ├── 2. Vytvoření Supervisoru (pro správu bucket actorů)
        ├── 3. Inicializace Persistence (pokud je nakonfigurována)
        ├── 4. Vytvoření TtlManageru (pro expiraci záznamů)
        ├── 5. Napojení vrstvy reaktivních dotazů na EventBus
        │
        ▼
  Instance Store (připravena pro defineBucket, transaction, …)
```

Konstruktor je privátní — vždy používáte `Store.start()`. Tím je zaručeno, že veškerá asynchronní inicializace (event bus, supervisor, načítání persistence) se dokončí dříve, než získáte referenci na Store.

## StoreOptions

`Store.start()` přijímá volitelný konfigurační objekt:

```typescript
const store = await Store.start({
  name: 'my-app',
  ttlCheckIntervalMs: 5000,
});
```

| Volba | Typ | Výchozí | Účel |
|-------|-----|---------|------|
| `name` | `string` | `'store-1'`, `'store-2'`, … | Čitelný identifikátor. Zobrazuje se v chybových zprávách a statistikách. |
| `persistence` | `StorePersistenceConfig` | `undefined` | Zapnutí persistence s adaptérem úložiště (probíráno v pozdější kapitole). |
| `ttlCheckIntervalMs` | `number` | `1000` | Jak často (v ms) TTL manager kontroluje expirované záznamy. Nastavte na `0` pro vypnutí automatických kontrol. |

### Název Store

Pokud název vynecháte, Store si ho vygeneruje automaticky (`store-1`, `store-2` atd.). Pro testy to stačí. V produkci vždy uveďte název — usnadní to ladění a logování:

```typescript
// Test — automatický název stačí
const store = await Store.start();

// Produkce — explicitní název
const store = await Store.start({ name: 'order-service' });
```

Název je po vytvoření pouze pro čtení:

```typescript
console.log(store.name); // 'order-service'
```

### Interval kontroly TTL

TTL manager periodicky prochází buckety s TTL a odstraňuje expirované záznamy. Výchozí interval je 1000 ms. Při vysokém throughputu ho můžete zvýšit pro snížení režie:

```typescript
// Kontrola každých 5 sekund místo každou sekundu
const store = await Store.start({ ttlCheckIntervalMs: 5000 });
```

Nastavte na `0` pro úplné vypnutí automatických TTL kontrol. Ruční čištění můžete stále spustit pomocí `store.purgeTtl()`:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

// Později, když chcete explicitně pročistit:
const purged = await store.purgeTtl();
console.log(`Pročištěno ${purged} expirovaných záznamů`);
```

## Životní cyklus Store

Store má tři fáze:

```text
  ┌──────────────────────────────────────────────────────────────┐
  │                    ŽIVOTNÍ CYKLUS STORE                        │
  │                                                               │
  │   Store.start()                                               │
  │        │                                                      │
  │        ▼                                                      │
  │   ┌─────────────────────────────────────────────────────┐    │
  │   │                      BĚŽÍ                            │    │
  │   │                                                      │    │
  │   │  defineBucket() ──── přidání kolekcí                 │    │
  │   │  bucket()       ──── získání handle pro CRUD         │    │
  │   │  transaction()  ──── atomické multi-bucket zápisy    │    │
  │   │  on()           ──── odběr událostí                  │    │
  │   │  defineQuery()  ──── registrace reaktivních dotazů   │    │
  │   │  subscribe()    ──── naslouchání výsledkům dotazů    │    │
  │   │  dropBucket()   ──── odebrání kolekce                │    │
  │   │  getStats()     ──── inspekce stavu Store            │    │
  │   │  purgeTtl()     ──── ruční expirace záznamů          │    │
  │   │  settle()       ──── čekání na nedokončenou práci    │    │
  │   │                                                      │    │
  │   └──────────────────────────┬───────────────────────────┘    │
  │                              │                                │
  │                     store.stop()                              │
  │                              │                                │
  │                              ▼                                │
  │   ┌─────────────────────────────────────────────────────┐    │
  │   │                    ZASTAVENO                         │    │
  │   │                                                      │    │
  │   │  TTL manager zastaven                                │    │
  │   │  Reaktivní dotazy zrušeny                            │    │
  │   │  Persistence uložena do úložiště                     │    │
  │   │  Všechny bucket actory ukončeny                      │    │
  │   │  EventBus vypnut                                     │    │
  │   └─────────────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────────────┘
```

### Spuštění

`Store.start()` je jediný způsob, jak vytvořit Store. Vrací `Promise<Store>`, protože inicializace zahrnuje spuštění actorů a (volitelně) načtení persistovaných dat:

```typescript
const store = await Store.start({ name: 'my-app' });
// Store je plně inicializován a připraven k použití
```

### Běh

Jakmile je spuštěn, Store přijímá všechny operace. Můžete definovat buckety, provádět CRUD operace, nastavovat reaktivní dotazy, spouštět transakce a přihlašovat se k odběru událostí. Neexistuje žádný explicitní krok „open" nebo „connect" — Store je připraven ihned po dokončení `start()`.

### Ukončení

Vždy Store ukončete, jakmile s ním skončíte. `stop()` provede řádné vypnutí ve správném pořadí:

```typescript
await store.stop();
```

Sekvence vypnutí:

1. **Zastavení TTL manageru** — žádné další automatické cykly čištění
2. **Zrušení reaktivních dotazů** — odhlášení všech naslouchačů
3. **Uložení persistence** — uložení finálních snapshotů do úložiště (vyžaduje živé bucket actory)
4. **Ukončení všech bucket actorů** — přes Supervisor
5. **Zastavení EventBus** — vypnutí systému událostí

Na pořadí záleží: persistence se musí uložit *před* ukončením bucket actorů, protože ukládání vyžaduje odesílání požadavků na snapshoty živým actorům.

## Inspekce Store

`getStats()` vrací komplexní snapshot aktuálního stavu Store:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'stats-demo' });

  // Prázdný Store
  const stats = await store.getStats();
  console.log(stats);
  // {
  //   name: 'stats-demo',
  //   buckets: { count: 0, names: [] },
  //   records: { total: 0, perBucket: {} },
  //   indexes: { total: 0, perBucket: {} },
  //   queries: { defined: 0, activeSubscriptions: 0 },
  //   persistence: { enabled: false },
  //   ttl: { enabled: true, checkIntervalMs: 1000 },
  // }

  // Definice bucketu a vložení dat
  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:   { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
    },
    indexes: ['name'],
  });

  const users = store.bucket('users');
  await users.insert({ name: 'Alice' });
  await users.insert({ name: 'Bob' });

  const updated = await store.getStats();
  console.log(updated.buckets);
  // { count: 1, names: ['users'] }
  console.log(updated.records);
  // { total: 2, perBucket: { users: 2 } }
  console.log(updated.indexes);
  // { total: 1, perBucket: { users: 1 } }

  await store.stop();
}

main();
```

### Tvar StoreStats

| Pole | Typ | Popis |
|------|-----|-------|
| `name` | `string` | Identifikátor Store |
| `buckets.count` | `number` | Počet definovaných bucketů |
| `buckets.names` | `string[]` | Seznam názvů bucketů |
| `records.total` | `number` | Celkový počet záznamů napříč všemi buckety |
| `records.perBucket` | `Record<string, number>` | Počet záznamů na bucket |
| `indexes.total` | `number` | Celkový počet indexů napříč všemi buckety |
| `indexes.perBucket` | `Record<string, number>` | Počet indexů na bucket |
| `queries.defined` | `number` | Počet registrovaných reaktivních dotazů |
| `queries.activeSubscriptions` | `number` | Počet aktivních odběrů dotazů |
| `persistence.enabled` | `boolean` | Zda je persistence nakonfigurována |
| `ttl.enabled` | `boolean` | Zda běží automatické TTL kontroly |
| `ttl.checkIntervalMs` | `number` | Interval TTL kontrol v milisekundách |

## Usazení asynchronní práce

Reaktivní dotazy se přehodnocují asynchronně při změně dat. Pokud potřebujete zajistit, že všechna nedokončená vyhodnocení proběhla (například před asercí v testu), použijte `settle()`:

```typescript
const store = await Store.start({ name: 'settle-demo' });

await store.defineBucket('items', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

let latestCount = 0;

store.defineQuery('itemCount', async (ctx) => {
  const all = await ctx.bucket('items').all();
  return all.length;
});

await store.subscribe<number>('itemCount', (count) => {
  latestCount = count;
});

const items = store.bucket('items');
await items.insert({ name: 'Widget' });

// Reaktivní dotaz se přehodnocuje asynchronně.
// Bez settle() by latestCount mohl být stále 0.
await store.settle();

console.log(latestCount); // 1 — zaručeno po settle()

await store.stop();
```

`settle()` je užitečný především v testech. V produkci callbacky reaktivních dotazů zpracovávají aktualizace přirozeně, jak přicházejí.

## Kompletní příklad

Vše pohromadě — Store, který se spustí, definuje dva buckety, zkontroluje statistiky a ukončí se:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  // 1. Spuštění Store
  const store = await Store.start({
    name: 'getting-started',
    ttlCheckIntervalMs: 5000,
  });

  console.log(`Store "${store.name}" spuštěn`);

  // 2. Definice bucketů
  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', format: 'email', unique: true },
    },
    indexes: ['email'],
  });

  await store.defineBucket('logs', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      action:    { type: 'string', required: true },
      timestamp: { type: 'string', generated: 'timestamp' },
    },
    ttl: '7d',
  });

  // 3. Vložení dat
  const users = store.bucket('users');
  const logs = store.bucket('logs');

  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  console.log('Vložen uživatel:', alice.id);

  await logs.insert({ action: 'user.created' });

  // 4. Inspekce Store
  const stats = await store.getStats();
  console.log(`Buckety: ${stats.buckets.count}`);       // 2
  console.log(`Celkem záznamů: ${stats.records.total}`); // 2
  console.log(`TTL zapnuto: ${stats.ttl.enabled}`);      // true

  // 5. Čisté ukončení
  await store.stop();
  console.log('Store ukončen');
}

main();
```

## Cvičení

Bez spuštění kódu předpovězte výstup tohoto programu. Poté si ověřte své odpovědi.

```typescript
import { Store } from '@hamicek/noex-store';

async function quiz() {
  const store = await Store.start({ name: 'quiz' });

  // Otázka 1: Jaký je store.name?
  console.log('Q1:', store.name);

  await store.defineBucket('tasks', {
    key: 'id',
    schema: {
      id:     { type: 'number', generated: 'autoincrement' },
      title:  { type: 'string', required: true },
      done:   { type: 'boolean', default: false },
    },
  });

  const tasks = store.bucket('tasks');
  await tasks.insert({ title: 'Learn noex-store' });
  await tasks.insert({ title: 'Build something' });
  await tasks.insert({ title: 'Ship it' });

  const stats = await store.getStats();

  // Otázka 2: Kolik bucketů?
  console.log('Q2:', stats.buckets.count);

  // Otázka 3: Kolik celkem záznamů?
  console.log('Q3:', stats.records.total);

  // Otázka 4: Je persistence zapnuta?
  console.log('Q4:', stats.persistence.enabled);

  // Otázka 5: Co se stane tady?
  try {
    await store.defineBucket('tasks', {
      key: 'id',
      schema: { id: { type: 'string' } },
    });
    console.log('Q5: success');
  } catch (err) {
    console.log('Q5:', err.constructor.name);
  }

  await store.stop();
}

quiz();
```

<details>
<summary>Řešení</summary>

**Q1: `'quiz'`**
Volba name byla nastavena na `'quiz'`, takže `store.name` vrátí `'quiz'`.

**Q2: `1`**
Byl definován pouze jeden bucket (`tasks`).

**Q3: `3`**
Do bucketu `tasks` byly vloženy tři záznamy.

**Q4: `false`**
Do `Store.start()` nebyla předána volba `persistence`, takže persistence není zapnuta.

**Q5: `'BucketAlreadyExistsError'`**
Bucket `tasks` už byl definován. Opětovné volání `defineBucket('tasks', …)` vyhodí `BucketAlreadyExistsError`. Název bucketu musí být v rámci Store unikátní.

</details>

## Shrnutí

- Nainstalujte `@hamicek/noex-store` spolu s `@hamicek/noex` (podkladový actor framework)
- Store vytvořte pomocí `await Store.start(options?)` — konstruktor je privátní
- `StoreOptions` konfiguruje název, persistenci a interval TTL kontrol
- Životní cyklus Store je: **start** (asynchronní inicializace) → **běží** (všechny operace k dispozici) → **stop** (řádné ukončení ve správném pořadí)
- `getStats()` poskytuje komplexní snapshot: buckety, záznamy, indexy, dotazy, persistence a stav TTL
- `settle()` počká na dokončení všech nedokončených vyhodnocení reaktivních dotazů — užitečné v testech
- Vždy zavolejte `store.stop()`, jakmile skončíte, pro uložení persistence a uvolnění prostředků

---

Další: [Buckety a Schémata](./02-buckety-a-schemata.md)
