# Klíčové koncepty

Než se ponoříme do kódu, pojďme si vytvořit jasný mentální model fungování noex-store. Knihovna má malý počet základních konceptů, které se skládají do výkonné vrstvy pro správu dat. Jakmile jim porozumíte, vše ostatní bude přímočaré.

## Co se naučíte

- Jak spolu souvisí Store, Buckets a BucketHandles
- Co jsou schemas a records a proč každý record nese metadata
- Jak systém Events notifikuje odběratele o změnách
- K čemu slouží Reactive Queries a jak se liší od jednorázového čtení
- Jak Transactions zajišťují atomicitu napříč více buckety
- Jakou roli hraje TTL, persistence a supervision tree

## Store na první pohled

```text
                       ┌─────────────────────────────────────────────────────┐
                       │                       STORE                          │
                       │                                                      │
                       │   ┌──────────┐   ┌──────────┐   ┌──────────┐       │
   store.bucket(name)──┼──►│  Bucket  │   │  Bucket  │   │  Bucket  │       │
                       │   │  Server  │   │  Server  │   │  Server  │       │
                       │   │ (actor)  │   │ (actor)  │   │ (actor)  │       │
                       │   └────┬─────┘   └────┬─────┘   └────┬─────┘       │
                       │        │              │              │              │
                       │        ▼              ▼              ▼              │
                       │   ┌────────────────────────────────────────┐        │
                       │   │              EVENT BUS                  │        │
                       │   │  bucket.users.inserted                 │        │
                       │   │  bucket.orders.updated                 │        │
                       │   │  bucket.sessions.deleted               │        │
                       │   └────────┬───────────────┬───────────────┘        │
                       │            │               │                        │
                       │            ▼               ▼                        │
                       │   ┌──────────────┐  ┌──────────────┐               │
                       │   │   Reactive   │  │  Persistence │               │
                       │   │   Queries    │  │   Layer      │               │
                       │   └──────────────┘  └──────────────┘               │
                       │                                                      │
                       │   ┌──────────────┐  ┌──────────────┐               │
                       │   │  TTL Manager │  │  Supervisor  │               │
                       │   └──────────────┘  └──────────────┘               │
                       └─────────────────────────────────────────────────────┘
```

Store je vstupní bod. Vytváří a spravuje buckety, směruje události, obsluhuje Reactive Queries a koordinuje Transactions. Každý bucket je izolovaný actor (GenServer) s vlastním schématem, indexy a daty.

## Store

Store je kontejner nejvyšší úrovně. Spustíte ho, definujete v něm buckety a přes něj přistupujete ke všem ostatním funkcím:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'my-app' });

// Definice kolekcí
await store.defineBucket('users', { /* … */ });
await store.defineBucket('orders', { /* … */ });

// Přístup ke kolekcím
const users = store.bucket('users');

// Transactions, dotazy, události, statistiky…
await store.transaction(async (tx) => { /* … */ });
store.defineQuery('topUsers', async (ctx) => { /* … */ });
await store.on('bucket.*.*', (event) => { /* … */ });
const stats = await store.getStats();

// Čisté ukončení
await store.stop();
```

### Životní cyklus Store

```text
  Store.start(options)
        │
        ▼
  ┌─────────────┐     defineBucket()     ┌─────────────┐
  │   RUNNING   │ ─────────────────────► │  + Bucket    │
  │             │ ◄───────────────────── │    Server    │
  │  EventBus   │     dropBucket()       └─────────────┘
  │  Supervisor │
  │  TTL Manager│
  │  Queries    │
  └──────┬──────┘
         │
         │  store.stop()
         ▼
  ┌─────────────┐
  │   STOPPED   │  Persistence flushed, actors terminated
  └─────────────┘
```

Metoda `start()` inicializuje event bus, supervisor, TTL manager a (volitelně) persistenci. Buckety se přidávají dynamicky pomocí `defineBucket()`. Metoda `stop()` uloží persistenci, ukončí všechny bucketactory a vypne event bus.

## Buckets a BucketHandles

**Bucket** je pojmenovaná kolekce záznamů se schématem — podobně jako tabulka v databázi. Každý bucket běží jako nezávislý actor (GenServer) spravovaný supervisorem.

**BucketHandle** je lehký, bezstavový proxy, který posílá zprávy actoru bucketu. Vytvoření handle je levné — sám o sobě nedrží žádný stav:

```typescript
// Definice bucketu (spustí actor)
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', format: 'email', unique: true },
  },
  indexes: ['email'],
});

// Získání handle (bezstavový proxy — levné vytvoření)
const users = store.bucket('users');

// CRUD operace přes handle
const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
const found = await users.get(alice.id);
await users.update(alice.id, { name: 'Alice Smith' });
await users.delete(alice.id);
```

### Definice Bucket

Každý bucket má `key` (pole primárního klíče) a `schema` (definice polí). Volitelné vlastnosti se deklarují ve stejném objektu:

| Vlastnost | Účel | Příklad |
|-----------|------|---------|
| `key` | Název pole primárního klíče | `'id'` |
| `schema` | Definice polí s typy a omezeními | `{ id: { type: 'string' } }` |
| `indexes` | Sekundární indexy pro rychlé vyhledávání | `['email', 'role']` |
| `ttl` | Doba životnosti před automatickým vypršením | `'1h'`, `'7d'`, `30000` |
| `maxSize` | Maximální počet záznamů; nejstarší se odstraní při naplnění | `10_000` |
| `persistent` | Vyřazení z persistence (pokud je zapnutá na úrovni Store) | `false` |

## Schemas

Schema deklaruje tvar každého záznamu v bucketu. Každé pole má typ a volitelná omezení:

```typescript
{
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    name:      { type: 'string', required: true, minLength: 1, maxLength: 100 },
    email:     { type: 'string', format: 'email', unique: true },
    age:       { type: 'number', min: 0, max: 150 },
    role:      { type: 'string', enum: ['admin', 'user', 'guest'], default: 'user' },
    bio:       { type: 'string', pattern: '^[A-Za-z]' },
    tags:      { type: 'array', default: [] },
    settings:  { type: 'object', default: {} },
    active:    { type: 'boolean', default: true },
    birthDate: { type: 'date' },
  },
}
```

### Typy polí

| Typ | JavaScript typ | Příklady hodnot |
|-----|---------------|-----------------|
| `string` | `string` | `'hello'`, `''` |
| `number` | `number` | `42`, `3.14` |
| `boolean` | `boolean` | `true`, `false` |
| `object` | `Record<string, unknown>` | `{ theme: 'dark' }` |
| `array` | `unknown[]` | `['a', 'b']` |
| `date` | `string` (ISO-8601) | `'2025-01-15'` |

### Omezení a vlastnosti

| Omezení | Platí pro | Účel |
|---------|-----------|------|
| `required` | Všechny typy | Pole musí být přítomno a nesmí být undefined |
| `enum` | Všechny typy | Hodnota musí být jedna z uvedených možností |
| `default` | Všechny typy | Statická hodnota nebo funkce `() => value` |
| `generated` | `string`, `number` | Automaticky generováno: `uuid`, `cuid`, `autoincrement`, `timestamp` |
| `unique` | Všechny typy | Vynucená unikátnost pomocí automatického indexu |
| `min` / `max` | `number` | Číselný rozsah |
| `minLength` / `maxLength` | `string` | Rozsah délky řetězce |
| `pattern` | `string` | Regulární výraz |
| `format` | `string` | Vestavěný formát: `email`, `url`, `iso-date` |

Pokud zápis poruší jakékoli omezení, Store vyhodí `ValidationError` s podrobným seznamem problémů — záznam se nikdy neuloží.

## Records a metadata

Každý record ve Store automaticky nese metadata pole:

```typescript
const user = await users.insert({ name: 'Alice', email: 'alice@example.com' });

console.log(user);
// {
//   id: 'a1b2c3d4-…',            ← vygenerované UUID
//   name: 'Alice',
//   email: 'alice@example.com',
//   role: 'user',                  ← aplikovaná výchozí hodnota
//   _version: 1,                   ← zvyšuje se při každém updatu
//   _createdAt: 1706745600000,     ← Unix ms při vložení
//   _updatedAt: 1706745600000,     ← Unix ms, aktualizuje se při každém zápisu
// }
```

| Pole | Nastaveno při | Účel |
|------|--------------|------|
| `_version` | Insert (1), update (+1) | Optimistické řízení souběžnosti v transakcích |
| `_createdAt` | Insert | Kdy byl záznam poprvé vytvořen (Unix ms) |
| `_updatedAt` | Insert, update | Kdy byl záznam naposledy změněn (Unix ms) |
| `_expiresAt` | Insert (pouze u bucketů s TTL) | Kdy bude záznam odstraněn (Unix ms) |

Metadata pole nelze nastavit ani přepsat aplikačním kódem. Spravuje je výhradně Store.

## Events

Každá mutace (insert, update, delete) publikuje událost do event busu Store. Události následují formát topicu `bucket.{name}.{type}`:

```typescript
// Odběr všech událostí na bucketu "users"
await store.on('bucket.users.*', (event, topic) => {
  console.log(topic, event.type, event.key);
});

await users.insert({ name: 'Alice', email: 'alice@example.com' });
// bucket.users.inserted  inserted  a1b2c3d4-…

await users.update(alice.id, { name: 'Alice Smith' });
// bucket.users.updated  updated  a1b2c3d4-…

await users.delete(alice.id);
// bucket.users.deleted  deleted  a1b2c3d4-…
```

### Typy Events

| Událost | Obsah | Spouštěč |
|---------|-------|----------|
| `inserted` | `{ bucket, key, record }` | Po úspěšném insertu |
| `updated` | `{ bucket, key, oldRecord, newRecord }` | Po úspěšném updatu |
| `deleted` | `{ bucket, key, record }` | Po úspěšném smazání |

### Vzory s wildcards

| Vzor | Odpovídá |
|------|----------|
| `bucket.users.inserted` | Pouze insert události na `users` |
| `bucket.users.*` | Všechny události na `users` |
| `bucket.*.*` | Všechny události na všech bucketech |
| `bucket.*.deleted` | Delete události na všech bucketech |

Events jsou základem pro Reactive Queries, persistenci a externí integrace.

## Reactive Queries

Reactive Query je pojmenovaná funkce, která čte data z jednoho nebo více bucketů. Když se přihlásíte k odběru, engine sleduje, ke kterým bucketům (a kterým záznamům) dotaz přistoupil. Pokud se některý z nich změní, dotaz se znovu spustí a doručí nový výsledek.

```text
  defineQuery('stats', fn)           subscribe('stats', callback)
        │                                     │
        ▼                                     ▼
  ┌──────────────┐                   ┌──────────────────┐
  │ Query Store  │                   │  Subscription    │
  │              │                   │  callback(result) │
  └──────┬───────┘                   └────────┬─────────┘
         │                                    │
         │         bucket change event        │
         │◄───────────────────────────────────┘
         │         re-execute query
         │────────────────────────────────────►│
         │         if result differs           │
         │         callback(newResult)          │
```

```typescript
// Definice dotazu, který počítá uživatele podle role
store.defineQuery('roleCounts', async (ctx) => {
  const all = await ctx.bucket('users').all();
  const counts: Record<string, number> = {};
  for (const user of all) {
    const role = user.role as string;
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
});

// Odběr — spustí se okamžitě a poté při každé relevantní změně
const unsub = await store.subscribe<Record<string, number>>(
  'roleCounts',
  (counts) => console.log('Počty rolí:', counts),
);
// Výstup: Počty rolí: { admin: 1, user: 3 }

// Insert spustí přehodnocení
await users.insert({ name: 'Eve', email: 'eve@example.com', role: 'admin' });
// Výstup: Počty rolí: { admin: 2, user: 3 }

unsub(); // Zastavení příjmu aktualizací
```

Klíčový poznatek: **napíšete obyčejnou async funkci a Store z ní udělá živý odběr**. Žádné ruční napojování událostí, žádné zastaralé cache, žádný polling.

## Transactions

Transactions zajišťují atomické zápisy napříč více buckety. Všechny zápisy buď uspějí společně, nebo se vrátí zpět:

```typescript
await store.transaction(async (tx) => {
  const orders = await tx.bucket('orders');
  const inventory = await tx.bucket('inventory');

  const item = await inventory.get('SKU-42');
  if (!item || (item.quantity as number) < 1) {
    throw new Error('Vyprodáno');
  }

  await orders.insert({ itemId: 'SKU-42', customerId: 'C-100' });
  await inventory.update('SKU-42', { quantity: (item.quantity as number) - 1 });

  // Oba zápisy se commitnou atomicky po návratu funkce.
  // Pokud jakýkoli zápis selže, vše se vrátí zpět.
});
```

### Záruky Transactions

| Vlastnost | Záruka |
|-----------|--------|
| **Atomicity** | Všechny zápisy se commitnou, nebo žádný |
| **Isolation** | Čtení uvnitř transakce vidí vaše vlastní zápisy |
| **Consistency** | Kontrola verzí zabraňuje konfliktním souběžným zápisům |
| **Rollback** | Při selhání se dříve commitnuté buckety vrátí zpět |

Transactions používají optimistické zamykání: `_version` každého záznamu se kontroluje v okamžiku commitu. Pokud jiný zápis záznam od vašeho čtení změnil, transakce vyhodí `TransactionConflictError`.

## TTL a životní cyklus

Buckety mohou deklarovat dobu životnosti (time-to-live). Záznamy automaticky expirují po uplynutí TTL:

```typescript
await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token: { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '30m',      // Expirace po 30 minutách
  maxSize: 10_000,  // Odstranění nejstarších při překročení 10 000 záznamů
});
```

| Funkce | Konfigurace | Chování |
|--------|-------------|---------|
| TTL | `ttl: '30m'` nebo `ttl: 1800000` | Záznamy dostanou `_expiresAt`; periodicky se odstraňují |
| Maximální velikost | `maxSize: 10_000` | Při naplnění se odstraní nejstarší záznamy (podle `_createdAt`) |
| Ruční čištění | `store.purgeTtl()` | Okamžitá kontrola expirace |

TTL podporuje čitelné formáty doby trvání: `'30s'`, `'5m'`, `'1h'`, `'7d'`.

## Persistence

Persistence je volitelná a založená na adapterech. Když je zapnutá, Store ukládá snapshoty bucketů při každé změně (s debouncem) a obnovuje data při restartu:

```typescript
import { MemoryAdapter } from '@hamicek/noex';

const store = await Store.start({
  name: 'persistent-app',
  persistence: {
    adapter: new MemoryAdapter(),  // Nebo FileAdapter, SQLiteAdapter
    debounceMs: 100,               // Dávkové zápisy (výchozí: 100ms)
  },
});
```

Jednotlivé buckety se mohou z persistence vyřadit nastavením `persistent: false`.

## Supervision Tree

Pod kapotou je noex-store postaven na actor modelu (`@hamicek/noex`). Každý bucket je GenServer actor spravovaný Supervisorem se strategií restartu `one_for_one`:

```text
                    ┌─────────────────────┐
                    │        Store        │
                    │    (orchestrator)    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │     Supervisor      │
                    │   one_for_one       │
                    └──┬──────┬──────┬────┘
                       │      │      │
               ┌───────▼┐ ┌──▼────┐ ┌▼───────┐
               │ Bucket │ │Bucket │ │ Bucket │
               │ Server │ │Server │ │ Server │
               │ users  │ │orders │ │sessions│
               └────────┘ └───────┘ └────────┘
               (GenServer) (GenServer) (GenServer)
```

Každý BucketServer zapouzdřuje:
- **Data**: In-memory Map záznamů
- **SchemaValidator**: Validuje a připravuje záznamy
- **IndexManager**: Udržuje sekundární indexy a omezení unikátnosti
- **Publikování událostí**: Posílá insert/update/delete události do EventBus

Pokud bucket actor spadne, supervisor ho restartuje. Ostatní buckety pokračují v provozu bez přerušení. To je strategie **one_for_one**: selhání jednoho potomka neshodí jeho sourozence.

## Jak se koncepty mapují na reálné problémy

| Koncept | Analogie z reálného světa | Příklad |
|---------|--------------------------|---------|
| **Store** | Databázový server | Centrální vstupní bod pro všechny datové operace |
| **Bucket** | Tabulka | Pojmenovaná kolekce se schématem |
| **BucketHandle** | Reference na tabulku | Lehký proxy pro operace čtení a zápisu |
| **Schema** | Definice tabulky (DDL) | Deklaruje typy polí, omezení, výchozí hodnoty |
| **Record** | Řádek | Data + automatická metadata (`_version`, `_createdAt`, …) |
| **Event** | Trigger / changelog | Notifikace o změně dat |
| **Reactive Query** | Materializovaný pohled | Živý výsledek, který se aktualizuje při změně podkladových dat |
| **Transaction** | Databázová transakce | Atomické zápisy napříč více buckety |
| **TTL** | Politika expirace řádků | Automatické čištění zastaralých dat |
| **Persistence** | Write-ahead log / snapshot | Přežije restart procesu |
| **Supervisor** | Správce procesů | Automaticky restartuje spadlé bucketactory |

## Cvičení

Tým buduje chatovací aplikaci v reálném čase. Potřebují ukládat uživatele, místnosti a zprávy. S využitím konceptů z této kapitoly odpovězte na následující otázky.

**Požadavky:**
- Uživatelé mají unikátní uživatelské jméno a e-mail
- Místnosti mají název a tvůrce (ID uživatele)
- Zprávy patří do místnosti a uživateli a obsahují text
- Dashboard by měl v reálném čase zobrazovat počet zpráv na místnost
- Zprávy starší než 30 dní by se měly automaticky mazat
- Při odeslání zprávy by systém měl ověřit, že uživatel i místnost existují, než zprávu vloží

1. Kolik bucketů potřebujete? Jaké jsou jejich názvy a klíčová pole?
2. Která pole byste indexovali?
3. Kde byste použili Reactive Query?
4. Kde byste použili Transaction?
5. Který bucket potřebuje TTL?

<details>
<summary>Řešení</summary>

**1. Tři buckety:**
- `users` — klíč: `id` (generované uuid). Schema: `id`, `username` (unique), `email` (format: email, unique).
- `rooms` — klíč: `id` (generované uuid). Schema: `id`, `name`, `creatorId` (reference na users).
- `messages` — klíč: `id` (generované uuid). Schema: `id`, `roomId`, `userId`, `text`, `sentAt` (generovaný timestamp).

**2. Indexy:**
- `users`: index na `username` (pro vyhledávání podle jména). Omezení unique automaticky vytváří index na `username` a `email`.
- `rooms`: žádné další indexy kromě klíče nejsou potřeba.
- `messages`: index na `roomId` (pro výpis zpráv v místnosti) a `userId` (pro výpis zpráv podle uživatele).

**3. Reactive Query pro dashboard:**
- Definujte dotaz `messageCountPerRoom`, který zavolá `ctx.bucket('messages').all()`, seskupí podle `roomId` a vrátí `Record<string, number>`.
- Přihlaste odběr z komponenty dashboardu. Počet se automaticky aktualizuje při vložení nebo smazání zpráv.

**4. Transaction pro odeslání zprávy:**
- Použijte `store.transaction()` k ověření, že uživatel existuje (`users.get(userId)`) a místnost existuje (`rooms.get(roomId)`) před vložením zprávy. Pokud některý chybí, vyhoďte chybu — transakce se přeruší bez vedlejších efektů.

**5. TTL na zprávách:**
- Nastavte `ttl: '30d'` na bucketu `messages`. Zprávy automaticky dostanou `_expiresAt = _createdAt + 30 dní` a TTL manager je odstraní bez jakéhokoli čistícího kódu.

</details>

## Shrnutí

- **Store** je centrální vstupní bod — spravuje buckety, události, dotazy a transakce
- **Bucket** je kolekce se schématem, kterou zajišťuje GenServer actor
- **BucketHandle** je bezstavový proxy — jeho vytvoření je zdarma
- **Schemas** deklarují typy polí, omezení, výchozí hodnoty a automaticky generované hodnoty
- Každý **Record** nese metadata: `_version`, `_createdAt`, `_updatedAt` a volitelně `_expiresAt`
- **Events** (`inserted`, `updated`, `deleted`) se publikují při každé mutaci
- **Reactive Queries** jsou obyčejné async funkce, které Store promění v živé odběry
- **Transactions** zajišťují atomické zápisy napříč více buckety s optimistickým zamykáním
- **TTL** a **maxSize** obstarávají automatický životní cyklus dat
- **Persistence** je založená na adapterech a volitelná pro každý bucket
- **Supervision Tree** izoluje selhání bucketů — jeden pád neshodí ostatní

---

Další: [Váš první Store](../../02-zaciname/01-prvni-store.md)
