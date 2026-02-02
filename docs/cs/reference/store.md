# Store API – Referenční příručka

> Centrální vstupní bod pro vytváření a správu in-memory úložiště se schématem řízenými buckety, reaktivními dotazy, transakcemi, událostmi, persistencí a TTL životním cyklem.

## Přehled

`Store` je hlavní třída knihovny `@hamicek/noex-store`. Spravuje kompletní životní cyklus úložiště — od inicializace přes registraci bucketů, dotazování až po elegantní ukončení. Interně orchestruje strom supervisorů, event bus, vrstvu persistence a TtlManager, vše postavené na noex actor modelu.

Store vytvoříte pomocí `Store.start()`, buckety definujete pomocí `defineBucket()` a k datům bucketu přistupujete přes instance `BucketHandle` vrácené metodou `bucket()`.

## API

### `Store.start(options?): Promise<Store>`

Statická tovární metoda. Vytvoří a inicializuje novou instanci Store.

Interně spustí supervisor, event bus, volitelnou vrstvu persistence a vrstvu reaktivních dotazů. Pokud je `ttlCheckIntervalMs > 0`, automatické kontroly expirace TTL začínají okamžitě.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `options` | [`StoreOptions`](#storeoptions) | `undefined` | Volitelná konfigurace úložiště |

**Vrací:** `Promise<Store>` — plně inicializovaná instance Store

**Příklad:**

```typescript
import { Store } from '@hamicek/noex-store';

// Minimální — automatický název, bez persistence, 1s interval kontroly TTL
const store = await Store.start();

// S volbami
const store = await Store.start({
  name: 'my-app',
  ttlCheckIntervalMs: 5_000,
});
```

---

### `store.name: string`

Vlastnost pouze pro čtení. Vrací název úložiště — buď ten, který byl předán v `StoreOptions`, nebo automaticky vygenerovaný `"store-1"`, `"store-2"` atd.

**Příklad:**

```typescript
const store = await Store.start({ name: 'inventory' });
console.log(store.name); // "inventory"
```

---

### `store.defineBucket(name, definition): Promise<void>`

Zaregistruje nový bucket v úložišti. Bucket je pojmenovaná, schématem validovaná kolekce záznamů.

Interně validuje definici (kontroluje, že `key` a `indexes` odkazují na pole ve schématu), spustí supervizovaný proces `BucketServer`, volitelně obnoví persistovaná data a zaregistruje sledování TTL, pokud je nastaveno `ttl`.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `name` | `string` | — | Jedinečný název bucketu |
| `definition` | [`BucketDefinition`](./schema.md) | — | Schéma, klíč, indexy, TTL a konfigurace velikosti |

**Vrací:** `Promise<void>`

**Vyhazuje:**

- `BucketAlreadyExistsError` — bucket se stejným názvem již existuje
- `Error` — pole `key` ve schématu neexistuje
- `Error` — pole indexu ve schématu neexistuje

**Příklad:**

```typescript
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 1 },
    email: { type: 'string', format: 'email', unique: true },
    role:  { type: 'string', enum: ['admin', 'member'], default: 'member' },
  },
  indexes: ['email', 'role'],
});
```

---

### `store.bucket(name): BucketHandle`

Vrací `BucketHandle` pro zadaný bucket. Handle poskytuje kompletní API pro CRUD operace, dotazování, stránkování a agregaci.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `name` | `string` | — | Název dříve definovaného bucketu |

**Vrací:** [`BucketHandle`](./bucket-handle.md) — fluent handle pro datové operace

**Vyhazuje:** `BucketNotDefinedError` — bucket nebyl definován

**Příklad:**

```typescript
const users = store.bucket('users');
const record = await users.insert({ name: 'Alice', email: 'alice@example.com' });
```

---

### `store.dropBucket(name): Promise<void>`

Odstraní bucket z úložiště. Odregistruje ho ze sledování TTL a persistence, ukončí jeho supervizovaný proces a smaže jeho definici.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `name` | `string` | — | Název bucketu k odstranění |

**Vrací:** `Promise<void>`

**Vyhazuje:** `BucketNotDefinedError` — bucket nebyl definován

**Příklad:**

```typescript
await store.dropBucket('sessions');
```

---

### `store.defineQuery(name, fn): void`

Zaregistruje pojmenovaný reaktivní dotaz. Funkce dotazu přijímá `QueryContext` a volitelné parametry a musí asynchronně vrátit výsledek. Smí pouze číst data — mutace uvnitř dotazu nejsou povoleny.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `name` | `string` | — | Jedinečný název dotazu |
| `fn` | `QueryFn<TParams, TResult>` | — | Asynchronní funkce `(ctx, params?) => Promise<TResult>` |

**Vrací:** `void`

**Vyhazuje:** `QueryAlreadyDefinedError` — dotaz se stejným názvem již existuje

**Příklad:**

```typescript
store.defineQuery('activeUsers', async (ctx) => {
  return ctx.bucket('users').where({ role: 'admin' });
});

store.defineQuery('userById', async (ctx, params: { id: string }) => {
  return ctx.bucket('users').get(params.id);
});
```

---

### `store.subscribe(queryName, callback): Promise<() => void>`

Přihlásí odběr reaktivního dotazu bez parametrů. Dotaz je okamžitě vyhodnocen pro získání počátečního výsledku a sady závislostí, ale callback **není** vyvolán při počátečním přihlášení — spouští se až při následných přehodnoceních, která produkují strukturálně odlišný výsledek (určený hlubokou rovností).

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `queryName` | `string` | — | Název definovaného dotazu |
| `callback` | `(result: TResult) => void` | — | Volána s výsledkem dotazu |

**Vrací:** `Promise<() => void>` — funkce pro odhlášení odběru

**Vyhazuje:** `QueryNotDefinedError` — dotaz nebyl definován

### `store.subscribe(queryName, params, callback): Promise<() => void>`

Přihlásí odběr reaktivního dotazu s parametry.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `queryName` | `string` | — | Název definovaného dotazu |
| `params` | `TParams` | — | Parametry předané funkci dotazu |
| `callback` | `(result: TResult) => void` | — | Volána s výsledkem dotazu |

**Vrací:** `Promise<() => void>` — funkce pro odhlášení odběru

**Příklad:**

```typescript
// Bez parametrů
const unsub = await store.subscribe('activeUsers', (users) => {
  console.log('Active users:', users.length);
});

// S parametry
const unsub = await store.subscribe('userById', { id: '123' }, (user) => {
  console.log('User:', user?.name);
});

// Později: ukončení odběru
unsub();
```

---

### `store.runQuery(queryName, params?): Promise<TResult>`

Spustí reaktivní dotaz jednou a vrátí výsledek. Nevytváří odběr.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `queryName` | `string` | — | Název definovaného dotazu |
| `params` | `unknown` | `undefined` | Volitelné parametry |

**Vrací:** `Promise<TResult>` — výsledek dotazu

**Vyhazuje:** `QueryNotDefinedError` — dotaz nebyl definován

**Příklad:**

```typescript
const admins = await store.runQuery<StoreRecord[]>('activeUsers');
```

---

### `store.transaction(fn): Promise<T>`

Provede asynchronní funkci uvnitř transakčního kontextu. Všechny mutace jsou bufferované a aplikované atomicky při úspěchu. Pokud funkce vyhodí výjimku, všechny změny jsou zahozeny (automatický rollback).

Transakční callback přijímá `TransactionContext` s vlastní metodou `tx.bucket(name)`, která vrací `TransactionBucketHandle` — nikoli běžný `BucketHandle`. Čtení uvnitř transakce vidí necommitované zápisy (read-your-own-writes).

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `fn` | `(tx: TransactionContext) => Promise<T>` | — | Asynchronní funkce provádějící transakční operace |

**Vrací:** `Promise<T>` — hodnota vrácená funkcí `fn`

**Vyhazuje:** `TransactionConflictError` — záznam byl změněn jinou operací mezi čtením a commitem (optimistické zamykání přes `_version`)

**Příklad:**

```typescript
const result = await store.transaction(async (tx) => {
  const users = tx.bucket('users');
  const orders = tx.bucket('orders');

  const user = await users.get('u1');
  await orders.insert({ userId: 'u1', total: 99 });
  await users.update('u1', { orderCount: (user?.orderCount ?? 0) + 1 });

  return 'done';
});
```

---

### `store.on(pattern, handler): Promise<() => Promise<void>>`

Zaregistruje handler událostí pro události úložiště odpovídající zadanému patternu. Používá interní event bus s pattern matchingem podporujícím wildcards.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `pattern` | `string` | — | Pattern topicu události (podporuje `*` wildcards) |
| `handler` | `(message: T, topic: string) => void` | — | Callback přijímající payload události a odpovídající topic |

**Vrací:** `Promise<() => Promise<void>>` — asynchronní funkce pro odhlášení

**Patterny:**

| Pattern | Odpovídá |
|---------|----------|
| `bucket.users.inserted` | Vložení do bucketu `users` |
| `bucket.users.*` | Všechny události v bucketu `users` |
| `bucket.*.inserted` | Všechna vložení napříč všemi buckety |
| `bucket.*.*` | Všechny události bucketů |

**Příklad:**

```typescript
const unsub = await store.on<BucketInsertedEvent>(
  'bucket.users.inserted',
  (event, topic) => {
    console.log(`New user: ${event.record.name}`);
  },
);

// Wildcard — všechny události bucketů
await store.on('bucket.*.*', (event) => {
  console.log(`${event.type} in ${event.bucket}`);
});

// Ukončení naslouchání
await unsub();
```

---

### `store.getStats(): Promise<StoreStats>`

Vrací snímek aktuálních statistik úložiště, včetně počtu bucketů, počtu záznamů, počtu indexů, informací o dotazech, stavu persistence a konfigurace TTL.

**Parametry:** žádné

**Vrací:** `Promise<`[`StoreStats`](#storestats)`>`

**Příklad:**

```typescript
const stats = await store.getStats();
console.log(`Buckets: ${stats.buckets.count}`);
console.log(`Total records: ${stats.records.total}`);
console.log(`Active subscriptions: ${stats.queries.activeSubscriptions}`);
```

---

### `store.purgeTtl(): Promise<number>`

Manuálně spustí expiraci TTL napříč všemi buckety s povoleným TTL. Užitečné v testech nebo když je potřeba okamžitý úklid místo čekání na automatický interval kontroly.

**Parametry:** žádné

**Vrací:** `Promise<number>` — celkový počet odstraněných expirovaných záznamů

**Příklad:**

```typescript
const purged = await store.purgeTtl();
console.log(`Purged ${purged} expired records`);
```

---

### `store.settle(): Promise<void>`

Počká na dokončení všech probíhajících přehodnocení reaktivních dotazů. Užitečné v testech pro zajištění, že odběry obdržely své nejnovější hodnoty po mutaci.

**Parametry:** žádné

**Vrací:** `Promise<void>`

**Příklad:**

```typescript
await store.bucket('users').insert({ name: 'Bob', email: 'bob@example.com' });
await store.settle(); // všechny reaktivní dotazy byly přehodnoceny
```

---

### `store.stop(): Promise<void>`

Elegantně ukončí úložiště. Zastaví TtlManager, zničí všechny reaktivní dotazy, vyprázdní persistenci (zajistí uložení dat), zastaví supervisor a event bus a vymaže veškerý interní stav.

**Parametry:** žádné

**Vrací:** `Promise<void>`

**Příklad:**

```typescript
await store.stop();
```

## Typy

### `StoreOptions`

Konfigurační objekt předávaný do `Store.start()`.

```typescript
interface StoreOptions {
  readonly name?: string;
  readonly persistence?: StorePersistenceConfig;
  readonly ttlCheckIntervalMs?: number;
}
```

| Vlastnost | Typ | Výchozí | Popis |
|-----------|-----|---------|-------|
| `name` | `string` | `"store-1"` (auto-increment) | Název úložiště, používaný jako prefix pro interní názvy actorů |
| `persistence` | [`StorePersistenceConfig`](./persistence.md) | `undefined` | Povolí persistenci, pokud je nastaveno. Konfiguruje adaptér, debounce a zpracování chyb |
| `ttlCheckIntervalMs` | `number` | `1000` | Interval v ms pro automatické kontroly expirace TTL. Nastavte na `0` pro deaktivaci automatických kontrol |

---

### `StoreStats`

Snímek vrácený metodou `store.getStats()`.

```typescript
interface StoreStats {
  readonly name: string;
  readonly buckets: {
    readonly count: number;
    readonly names: readonly string[];
  };
  readonly records: {
    readonly total: number;
    readonly perBucket: Readonly<Record<string, number>>;
  };
  readonly indexes: {
    readonly total: number;
    readonly perBucket: Readonly<Record<string, number>>;
  };
  readonly queries: {
    readonly defined: number;
    readonly activeSubscriptions: number;
  };
  readonly persistence: {
    readonly enabled: boolean;
  };
  readonly ttl: {
    readonly enabled: boolean;
    readonly checkIntervalMs: number;
  };
}
```

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `string` | Název úložiště |
| `buckets.count` | `number` | Počet definovaných bucketů |
| `buckets.names` | `readonly string[]` | Názvy všech definovaných bucketů |
| `records.total` | `number` | Celkový počet záznamů napříč všemi buckety |
| `records.perBucket` | `Record<string, number>` | Počet záznamů podle názvu bucketu |
| `indexes.total` | `number` | Celkový počet indexů napříč všemi buckety |
| `indexes.perBucket` | `Record<string, number>` | Počet indexů podle názvu bucketu |
| `queries.defined` | `number` | Počet zaregistrovaných dotazů |
| `queries.activeSubscriptions` | `number` | Počet aktivních odběrů |
| `persistence.enabled` | `boolean` | Zda je persistence nakonfigurována |
| `ttl.enabled` | `boolean` | Zda běží automatické kontroly TTL |
| `ttl.checkIntervalMs` | `number` | Nastavený interval kontrol TTL v ms |

## Viz také

- [BucketHandle API](./bucket-handle.md) — CRUD, filtrování, stránkování a agregace nad daty bucketu
- [Schéma a typy](./schema.md) — `BucketDefinition`, typy polí, omezení a validace
- [Reaktivní dotazy](./reactive-queries.md) — `defineQuery()`, `subscribe()` a sledování závislostí do hloubky
- [Transakce](./transactions.md) — `TransactionContext`, atomicita a optimistické zamykání
- [Události](./events.md) — typy událostí, wildcard patterny a registrace handlerů
- [Persistence](./persistence.md) — `StorePersistenceConfig`, adaptéry a životní cyklus snapshotů
- [TTL a životní cyklus](./ttl-lifecycle.md) — TTL syntaxe, `TtlManager` a `maxSize` evikce
- [Chyby](./errors.md) — kompletní katalog tříd chyb
- **Výuka:** [První Store](../learn/02-zaciname/01-prvni-store.md) — krok za krokem tutoriál pro vytvoření prvního úložiště
- **Výuka:** [Buckety a schémata](../learn/02-zaciname/02-buckety-a-schemata.md) — porozumění definicím bucketů
- **Zdrojový kód:** [`src/core/store.ts`](../../../src/core/store.ts)
