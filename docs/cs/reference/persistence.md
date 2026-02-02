# Reference API persistence

> Automatické debounced snapshoty stavu bucketu do zásuvných storage adaptérů s plynulou obnovou při restartu.

## Přehled

Vrstva persistence ukládá data bucketů do trvalého úložiště, takže přežijí restart procesu. Naslouchá mutačním událostem bucketu, seskupuje změny pomocí konfigurovatelného debounce časovače a zapisuje úplné snapshoty bucketu prostřednictvím `StorageAdapter`. Při spuštění jsou uložené snapshoty načteny dříve, než se bucket zpřístupní, čímž se obnoví záznamy, autoinkrement čítače, indexy a unikátní omezení.

Persistence je na úrovni store opt-in a na úrovni bucketu opt-out.

## Konfigurace

### `StoreOptions.persistence`

Předejte `StorePersistenceConfig` do `Store.start()` pro zapnutí persistence:

```typescript
import { Store } from '@hamicek/noex-store';
import { FileAdapter } from '@hamicek/noex';

const store = await Store.start({
  name: 'my-app',
  persistence: {
    adapter: new FileAdapter('./data'),
    debounceMs: 200,
    onError: (err) => console.error('Persistence error:', err.message),
  },
});
```

Bez volby `persistence` běží store čistě v paměti.

---

## Typy

### `StorePersistenceConfig`

```typescript
interface StorePersistenceConfig {
  readonly adapter: StorageAdapter;
  readonly debounceMs?: number;
  readonly onError?: (error: Error) => void;
}
```

| Vlastnost | Typ | Výchozí | Popis |
|-----------|-----|---------|-------|
| `adapter` | `StorageAdapter` | *(povinný)* | Instance storage backendu (`MemoryAdapter`, `FileAdapter` nebo `SQLiteAdapter` z `@hamicek/noex`) |
| `debounceMs` | `number` | `100` | Počet milisekund čekání před seskupením zápisů. Více mutací v tomto okně vyvolá jediný zápis adaptéru na postižený bucket. |
| `onError` | `(error: Error) => void` | `undefined` | Callback vyvolaný při nefatálních chybách persistence (selhání načtení/uložení). Store pokračuje v provozu v paměti. |

### `StorageAdapter`

Rozhraní adaptéru z `@hamicek/noex`, které implementují všechny storage backendy:

```typescript
interface StorageAdapter {
  save<T>(key: string, data: PersistedState<T>): Promise<void>;
  load<T>(key: string): Promise<PersistedState<T> | undefined>;
  close?(): Promise<void>;
}
```

| Metoda | Popis |
|--------|-------|
| `save(key, data)` | Uloží data pod daným klíčem |
| `load(key)` | Načte dříve uložená data, nebo `undefined` pokud nebyla nalezena |
| `close()` | Volitelný úklid (zavření file handlerů, databázových spojení) |

### `PersistedState<T>`

Obálkový formát zapisovaný do adaptéru:

```typescript
interface PersistedState<T> {
  readonly state: T;
  readonly metadata: {
    readonly persistedAt: number;
    readonly serverId: string;
    readonly schemaVersion: number;
  };
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `state` | `T` | Data bucketu (záznamy a autoinkrement čítač) |
| `metadata.persistedAt` | `number` | Unix milisekundový timestamp uložení |
| `metadata.serverId` | `string` | Název store |
| `metadata.schemaVersion` | `number` | Vždy `1` |

### `BucketSnapshot`

Interní stav bucketu zachycený během persistence:

```typescript
interface BucketSnapshot {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `records` | `ReadonlyArray<readonly [unknown, StoreRecord]>` | Pole `[key, record]` tuplů — celý obsah bucketu |
| `autoincrementCounter` | `number` | Aktuální hodnota autoinkrementu pro pole s `generated: 'autoincrement'` |

### `BucketInitialData`

Data vrácená metodou `loadBucket()` a předaná bucketu při vytvoření:

```typescript
interface BucketInitialData {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}
```

Stejná struktura jako `BucketSnapshot`. Při obnově jsou záznamy vloženy do interní tabulky bucketu, indexy jsou přebudovány a unikátní omezení znovu ustanovena.

---

## Per-bucket odhlášení

Když je persistence zapnuta na store, všechny buckety jsou ve výchozím stavu persistentní. Nastavte `persistent: false` v `BucketDefinition` pro vyloučení bucketu:

```typescript
// Persistentní (výchozí, když store má persistence)
await store.defineBucket('users', {
  key: 'id',
  schema: { id: { type: 'string', generated: 'uuid' }, name: { type: 'string', required: true } },
});

// Nepersistentní
await store.defineBucket('sessionCache', {
  key: 'token',
  schema: { token: { type: 'string', required: true }, data: { type: 'object' } },
  persistent: false,
});
```

Vlastnost `persistent` na `BucketDefinition`:

| Hodnota | Chování |
|---------|---------|
| `true` (nebo vynecháno) | Bucket je načten z adaptéru při vytvoření a sledován pro persistence |
| `false` | Bucket začíná prázdný a mutace nejsou persistovány |

Bucket je persistentní pouze tehdy, když store **má** konfiguraci persistence **a zároveň** `persistent !== false` na definici bucketu.

---

## Formát klíče úložiště

Každý bucket je uložen pod klíčem s namespace:

```
{storeName}:bucket:{bucketName}
```

**Příklad:** Store s názvem `"my-app"` a bucketem s názvem `"users"` vytvoří klíč `"my-app:bucket:users"`.

Použití odlišných názvů store zabraňuje kolizím klíčů, když více store sdílí stejný adaptér.

---

## Dostupné adaptéry

Všechny adaptéry se importují z `@hamicek/noex`:

| Adaptér | Konstruktor | Případ použití |
|---------|-------------|----------------|
| `MemoryAdapter` | `new MemoryAdapter()` | Testy, prototypování, dočasné úložiště |
| `FileAdapter` | `new FileAdapter(directory)` | Jednoprocesové aplikace, jednoduchá nasazení |
| `SQLiteAdapter` | `new SQLiteAdapter(dbPath)` | Produkční zátěž, zápisy odolné proti pádu |

```typescript
import { MemoryAdapter, FileAdapter, SQLiteAdapter } from '@hamicek/noex';
```

### Porovnání

| Kritérium | MemoryAdapter | FileAdapter | SQLiteAdapter |
|-----------|---------------|-------------|---------------|
| Přežije restart procesu | Ne | Ano | Ano |
| Odolnost proti pádu | N/A | Částečná (poslední zápis může být ztracen) | Plná (atomické zápisy) |
| Nastavení | Žádné | Cesta k adresáři | Cesta k souboru |

---

## Třída StorePersistence

Třída `StorePersistence` je exportována z hlavního balíčku a spravuje celý životní cyklus persistence. Interně ji vytváří `Store.start()`, když je poskytnuta konfigurace `persistence`, ale je dostupná i pro pokročilé případy použití.

```typescript
import { StorePersistence } from '@hamicek/noex-store';
```

### `new StorePersistence(storeName, config)`

Vytvoří nového správce persistence.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `storeName` | `string` | Název store, použitý jako prefix klíčů úložiště |
| `config` | `StorePersistenceConfig` | Konfigurace adaptéru, debounce a chybového callbacku |

**Příklad:**

```typescript
const persistence = new StorePersistence('my-app', {
  adapter: new MemoryAdapter(),
  debounceMs: 200,
});
```

---

### `persistence.start(eventBusRef): Promise<void>`

Přihlásí se k odběru událostí bucketu na event busu. Musí být zavolána před jakýmikoli mutacemi bucketu.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `eventBusRef` | `EventBusRef` | Reference na event bus store |

Interně se přihlásí k vzoru `bucket.*.*` pro příjem všech insert, update a delete událostí.

---

### `persistence.loadBucket(name): Promise<BucketInitialData | undefined>`

Načte dříve uložený snapshot bucketu z adaptéru.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `name` | `string` | Název bucketu k načtení |

**Vrací:** `Promise<BucketInitialData | undefined>` — uložené záznamy a autoinkrement čítač, nebo `undefined` pokud data neexistují nebo došlo k chybě.

**Zpracování chyb:** Selhání adaptéru jsou zachycena, předána do callbacku `onError` a metoda vrátí `undefined`. Bucket pokračuje s prázdným stavem (graceful degradation).

**Příklad:**

```typescript
const data = await persistence.loadBucket('users');
if (data) {
  console.log(`Restored ${data.records.length} records`);
}
```

---

### `persistence.registerBucket(name, ref): void`

Zaregistruje bucket pro sledování persistence. Po registraci mutační události pro tento bucket spouštějí debounce mechanismus.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `name` | `string` | Název bucketu |
| `ref` | `BucketRef` | GenServer reference na bucket |

---

### `persistence.unregisterBucket(name): void`

Zastaví sledování bucketu. Odstraní jeho referenci a vyčistí ho ze sady dirty. Následné události pro tento bucket jsou ignorovány.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `name` | `string` | Název bucketu k odregistrování |

Voláno interně, když `store.dropBucket()` odstraní bucket.

---

### `persistence.flush(): Promise<void>`

Okamžitě uloží všechny dirty buckety bez čekání na debounce časovač. Pokud je debounce časovač aktivní, je zrušen.

Neprovede nic, pokud žádné buckety nejsou dirty.

**Zpracování chyb:** Chyby při ukládání jednotlivých bucketů vyvolají `onError`, ale nezabrání uložení ostatních bucketů.

**Příklad:**

```typescript
await store.bucket('users').insert({ name: 'Alice' });
await persistence.flush(); // Vynutit okamžitý zápis
```

---

### `persistence.stop(): Promise<void>`

Plynule ukončí vrstvu persistence:

1. Přestane naslouchat novým událostem
2. Označí všechny registrované buckety jako dirty
3. Zavolá `flush()` pro uložení všeho
4. Odhlásí se z event busu
5. Zavolá `adapter.close()`, pokud to adaptér implementuje

**Důležité:** `stop()` musí být zavolána, dokud jsou GenServery bucketů stále naživu, protože `flush()` jim posílá zprávy `getSnapshot`. Proto `Store.stop()` volá `persistence.stop()` před zastavením stromu supervizorů.

---

## Životní cyklus

### Inicializace

```
Store.start({ persistence: config })
  1. Vytvoření StorePersistence(name, config)
  2. persistence.start(eventBusRef)        -- přihlášení k odběru událostí
```

### Vytvoření bucketu

```
store.defineBucket('users', definition)
  1. Kontrola: isPersistent = persistence !== null && (definition.persistent ?? true)
  2. Pokud persistentní: initialData = await persistence.loadBucket('users')
  3. Vytvoření bucket GenServeru s initialData
  4. Pokud persistentní: persistence.registerBucket('users', ref)
```

### Běžný provoz

```
bucket.insert/update/delete
  → BucketServer aplikuje mutaci
  → EventBus publikuje bucket.users.inserted/updated/deleted
  → StorePersistence přijme událost
  → Označí bucket jako dirty
  → Spustí debounce časovač (pokud ještě neběží)
  → Časovač vyprší po debounceMs:
      → Získá snapshot z BucketServeru přes GenServer.call
      → adapter.save(key, { state, metadata })
```

### Ukončení

```
store.stop()
  1. persistence.stop()
     a. Nastavení isStopping = true (ignorování nových událostí)
     b. Označení všech registrovaných bucketů jako dirty
     c. flush() — uložení všeho
     d. Odhlášení z EventBusu
     e. adapter.close()
  2. Zastavení stromu supervizorů (BucketServery)
  3. Zastavení EventBusu
```

---

## Debounce mechanismus

Více rychlých mutací je seskupeno do jediného zápisu na bucket:

```
t=0ms    insert do 'users'       → dirty={users}, spuštění časovače
t=10ms   update v 'users'        → dirty={users}, časovač již běží
t=30ms   insert do 'orders'      → dirty={users, orders}
t=100ms  časovač vyprší           → uložení 'users' a 'orders' paralelně
                                  → dirty={}, timer=null
```

- První událost v klidovém období spustí časovač.
- Následné události přidávají buckety do dirty sady; časovač se neresetuje.
- Když časovač vyprší, všechny dirty buckety jsou snapshotovány souběžně pomocí `Promise.all`.
- Explicitní `flush()` zruší časovač a provede uložení okamžitě.

### Ladění `debounceMs`

| Hodnota | Kompromis |
|---------|-----------|
| `50` | Menší okno ztráty dat, častější zápisy |
| `100` (výchozí) | Vyvážené pro většinu zátěží |
| `500–1000` | Méně zápisů, větší okno ztráty dat při pádu |

---

## Zpracování chyb

### Nefatální chyby

Chyby persistence nikdy nezpůsobí pád store. Datová vrstva v paměti pokračuje v obsluze požadavků bez ohledu na selhání adaptéru.

| Situace | Chování |
|---------|---------|
| `adapter.save()` selže | Vyvolán callback `onError`, store pokračuje. Bucket je znovu uložen, když ho další mutace označí jako dirty. |
| `adapter.load()` selže | Vyvolán callback `onError`, bucket začíná prázdný |
| `onError` není poskytnut | Chyby jsou tiše ignorovány |

### Fatální chyby

| Situace | Chování |
|---------|---------|
| `adapter.close()` vyhodí výjimku během `stop()` | Chyba je propagována volajícímu `store.stop()` |

### Vzor chybového callbacku

```typescript
const store = await Store.start({
  name: 'my-app',
  persistence: {
    adapter,
    onError: (error) => {
      console.error('Persistence error:', error.message);
      // Odeslat do monitoringu, metrik atd.
    },
  },
});
```

---

## Statistiky store

`store.getStats()` oznamuje, zda je persistence zapnuta:

```typescript
const stats = await store.getStats();
console.log(stats.persistence.enabled); // true
```

Sekce `persistence` v `StoreStats`:

```typescript
{
  persistence: {
    enabled: boolean;  // true, když byl store vytvořen s konfigurací persistence
  };
}
```

---

## Viz také

- [Store API](./store.md) — volby `Store.start()` a životní cyklus `store.stop()`
- [Schéma a typy](./schema.md) — pole `BucketDefinition.persistent`
- [Event systém](./events.md) — události bucketu, které spouštějí persistence
- [TTL a životní cyklus](./ttl-lifecycle.md) — expirace TTL a evikce `maxSize` v interakci s persistence
- [Chyby](./errors.md) — kompletní katalog chyb
- **Výuka:** [Ukládání dat](../learn/08-persistence/01-ukladani-dat.md) — koncepční úvod s cvičeními
- **Výuka:** [Obnova a snapshoty](../learn/08-persistence/02-obnova-a-snapshoty.md) — průběh obnovy a interní mechanismy snapshotů
- **Zdrojový kód:** [`src/persistence/store-persistence.ts`](../../../src/persistence/store-persistence.ts)
- **Zdrojový kód:** [`src/types/schema.ts`](../../../src/types/schema.ts) — `StorePersistenceConfig`
