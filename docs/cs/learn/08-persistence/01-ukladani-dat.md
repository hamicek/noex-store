# Ukládání dat

Váš store uchovává tisíce záznamů — uživatelské relace, konfiguraci, cachované odpovědi z API. Proces se restartuje (deployment, pád, restart serveru) a všechno je pryč. Znovu sestavujete data z externích zdrojů, opakujete API volání a doufáte, že se nic mezi tím neztratilo. Mezitím vaši uživatelé vidí prázdné dashboardy a zastaralá data, dokud se systém nedožene.

Persistence v noex-store ukládá stav bucketů do trvalého úložiště automaticky. Mutace spouští debounced snapshoty zapisované přes vyměnitelný adaptér. Když se store restartuje, načte poslední snapshot a pokračuje tam, kde skončil — indexy přestavěné, autoincrement čítače obnovené, unikátní omezení vynucená.

## Co se naučíte

- Jak konfigurovat persistenci pomocí `StorePersistenceConfig`
- Jak fungují úložištní adaptéry (`MemoryAdapter`, `FileAdapter`, `SQLiteAdapter`)
- Jak debounced snapshoty sdružují zápisy pro efektivitu
- Jak vyloučit jednotlivé buckety z persistence
- Jak persistence interaguje se systémem událostí
- Jak se zpracovávají chyby bez pádu store

## Konfigurace

Persistence je opt-in funkce konfigurovaná při vytváření store přes volbu `persistence`:

```typescript
import { Store } from '@hamicek/noex-store';
import { MemoryAdapter } from '@hamicek/noex';

const store = await Store.start({
  name: 'my-app',
  persistence: {
    adapter: new MemoryAdapter(),
    debounceMs: 100,
    onError: (err) => console.error('Chyba persistence:', err.message),
  },
});
```

### StorePersistenceConfig

| Vlastnost | Typ | Výchozí | Popis |
|-----------|-----|---------|-------|
| `adapter` | `StorageAdapter` | *(povinný)* | Úložištní backend pro operace načtení/uložení |
| `debounceMs` | `number` | `100` | Počet milisekund čekání před sdružením zápisů |
| `onError` | `(error: Error) => void` | `undefined` | Callback pro nekritické chyby persistence |

Bez volby `persistence` store běží čistě v paměti. Její pozdější přidání nevyžaduje změny kódu — stejné definice bucketů a CRUD operace fungují identicky.

## Úložištní adaptéry

Adaptér je most mezi store a trvalým úložištěm. Všechny adaptéry implementují stejné rozhraní `StorageAdapter` z `@hamicek/noex`:

```typescript
interface StorageAdapter {
  save<T>(key: string, data: PersistedState<T>): Promise<void>;
  load<T>(key: string): Promise<PersistedState<T> | undefined>;
  close?(): Promise<void>;
}
```

### Dostupné adaptéry

| Adaptér | Import | Použití |
|---------|--------|---------|
| `MemoryAdapter` | `@hamicek/noex` | Testy, prototypování, dočasné úložiště |
| `FileAdapter` | `@hamicek/noex` | Jednoprocesové aplikace, jednoduchý deployment |
| `SQLiteAdapter` | `@hamicek/noex` | Produkční zátěž, souběžný přístup |

### MemoryAdapter

Ukládá data do obyčejné `Map`. Data se ztratí při ukončení procesu, ale přežijí restart store v rámci stejného procesu — užitečné pro testování persistence logiky bez přístupu na souborový systém:

```typescript
import { MemoryAdapter } from '@hamicek/noex';

const adapter = new MemoryAdapter();

const store = await Store.start({
  name: 'test-store',
  persistence: { adapter },
});
```

### FileAdapter

Zapisuje JSON soubory do adresáře. Každý bucket má vlastní soubor:

```typescript
import { FileAdapter } from '@hamicek/noex';

const adapter = new FileAdapter('./data');

const store = await Store.start({
  name: 'my-app',
  persistence: { adapter },
});
```

### SQLiteAdapter

Používá SQLite pro ukládání. Efektivně zvládá souběžné čtení a poskytuje crash-safe zápisy:

```typescript
import { SQLiteAdapter } from '@hamicek/noex';

const adapter = new SQLiteAdapter('./data/store.db');

const store = await Store.start({
  name: 'my-app',
  persistence: { adapter },
});
```

### Volba adaptéru

| Kritérium | MemoryAdapter | FileAdapter | SQLiteAdapter |
|-----------|---------------|-------------|---------------|
| **Přežije restart procesu** | Ne | Ano | Ano |
| **Odolnost proti pádu** | N/A | Částečná (poslední zápis se může ztratit) | Plná (atomické zápisy) |
| **Nastavení** | Žádné | Cesta k adresáři | Cesta k souboru |
| **Nejlepší pro** | Testy | Jednoduché aplikace | Produkci |

## Jak fungují debounced snapshoty

Persistence nezapisuje do úložiště při každé mutaci. Místo toho sdružuje změny pomocí debounce časovače:

```text
  Mutace 1 (insert)        t=0ms
      |
      v
  Označit bucket jako dirty, spustit časovač (100ms)
      |
  Mutace 2 (update)        t=30ms
      |
      v
  Bucket je stále dirty, časovač běží
      |
  Mutace 3 (delete)        t=80ms
      |
      v
  Bucket je stále dirty, časovač běží
      |
  Časovač vypršel          t=100ms
      |
      v
  Snapshot bucketu -> adapter.save()
  (jeden zápis pro všechny tři mutace)
```

### Průběh debounce

1. Mutace (insert, update, delete) v bucketu vyvolá událost na EventBus
2. `StorePersistence` přijme událost a označí bucket jako „dirty"
3. Pokud neběží žádný debounce časovač, spustí se nový (výchozí: 100ms)
4. Po vypršení časovače se všechny dirty buckety snapshotoují paralelně
5. Každý snapshot zachytí úplný stav bucketu atomicky přes GenServer call
6. Snapshot se zapíše do adaptéru

### Proč debounce?

| Bez debounce | S debounce (100ms) |
|--------------|--------------------|
| 100 insertů = 100 zápisů adaptéru | 100 insertů za <100ms = 1 zápis adaptéru |
| Vysoký I/O tlak na úložiště | Minimální I/O režie |
| Každý zápis zachycuje inkrementální stav | Každý zápis zachycuje kompletní stav |

### Ladění debounceMs

```typescript
// Nízká latence: rychlé uložení, více zápisů
persistence: { adapter, debounceMs: 50 }

// Výchozí vyvážení
persistence: { adapter, debounceMs: 100 }

// Vysoká propustnost: větší dávky, méně zápisů
persistence: { adapter, debounceMs: 1000 }
```

Nižší hodnoty zmenšují okno pro ztrátu dat při pádu. Vyšší hodnoty snižují I/O za cenu většího potenciálního okna ztráty. Výchozí 100ms je dobrý výchozí bod pro většinu zátěží.

## Per-Bucket opt-out

Když je persistence konfigurovaná na store, všechny buckety jsou ve výchozím stavu persistentní. Konkrétní buckety můžete vyloučit pomocí `persistent: false` v definici bucketu:

```typescript
const store = await Store.start({
  name: 'my-app',
  persistence: { adapter: new MemoryAdapter() },
});

// Tento bucket je persistentní (výchozí: persistent: true)
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

// Tento bucket NENÍ persistentní
await store.defineBucket('sessionCache', {
  key: 'token',
  schema: {
    token:     { type: 'string', required: true },
    userId:    { type: 'string', required: true },
    expiresAt: { type: 'number', required: true },
  },
  persistent: false,
});
```

Po restartu:
- bucket `users` — data obnovena z adaptéru
- bucket `sessionCache` — začíná prázdný, data nebyla uložena

### Kdy vyloučit

| Scénář | Persistovat? | Důvod |
|--------|--------------|-------|
| Uživatelské účty, objednávky, konfigurace | Ano | Klíčová data, která musí přežít restarty |
| Session tokeny, cache požadavků | Ne | Dočasná data, která by měla být znovu vytvořena |
| Čítače rate-limitu | Ne | Krátkodobé, spravované TTL |
| Odvozená/vypočtená data | Ne | Lze přepočítat ze zdrojových bucketů |

## Zpracování chyb

Chyby persistence jsou nekritické. Store pokračuje v provozu v paměti i když adaptér selže:

```typescript
const store = await Store.start({
  name: 'my-app',
  persistence: {
    adapter,
    onError: (err) => {
      console.error(`Persistence selhala: ${err.message}`);
      // Zalogovat do monitoringu, upozornit provozní tým atd.
    },
  },
});
```

### Chování při chybách

| Situace | Chování |
|---------|---------|
| `adapter.save()` selže | Chyba nahlášena přes `onError`, store pokračuje, opakování v dalším debounce cyklu |
| `adapter.load()` selže | Chyba nahlášena přes `onError`, bucket začíná prázdný (graceful degradation) |
| Žádný `onError` callback | Chyby tiše spolknuty, store pokračuje |
| Adaptér vyhodí výjimku během `close()` | Chyba propagována do `store.stop()` |

Store nikdy nespadne kvůli chybě persistence. Tento design upřednostňuje dostupnost — datová vrstva v paměti pokračuje v obsluze požadavků i když je úložištní backend dočasně nedostupný.

## Persistence a události

Persistence vrstva se přihlásí k odběru na EventBus se vzorem `bucket.*.*`. Každá událost insert, update a delete spouští debounce mechanismus:

```text
  BucketServer
      |
      | emit('bucket.users.inserted', { ... })
      |
      v
  EventBus ──> StorePersistence.#onBucketChange('users')
      |              |
      |              v
      |        Označit 'users' jako dirty, spustit/prodloužit časovač
      |
      ──> QueryManager (reaktivní dotazy)
      |
      ──> Vaše handlery událostí (store.on)
```

Události proudí ke všem odběratelům současně. Persistence vrstva přijímá stejné události jako váš aplikační kód — žádná speciální priorita ani řazení.

## Kompletní funkční příklad

Systém správy uživatelů s persistencí a per-bucket opt-out:

```typescript
import { Store } from '@hamicek/noex-store';
import { MemoryAdapter } from '@hamicek/noex';

async function main() {
  const adapter = new MemoryAdapter();

  // --- První běh: vytvoření a naplnění ---

  const store1 = await Store.start({
    name: 'user-app',
    persistence: {
      adapter,
      debounceMs: 100,
      onError: (err) => console.error(`[persistence] ${err.message}`),
    },
  });

  await store1.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true, format: 'email', unique: true },
      role:  { type: 'string', enum: ['user', 'admin'], default: 'user' },
    },
    indexes: ['email', 'role'],
  });

  await store1.defineBucket('cache', {
    key: 'key',
    schema: {
      key:   { type: 'string', required: true },
      value: { type: 'string', required: true },
    },
    persistent: false, // Dočasný — neukládá se
  });

  const alice = await store1.bucket('users').insert({
    name: 'Alice', email: 'alice@example.com', role: 'admin',
  });
  const bob = await store1.bucket('users').insert({
    name: 'Bob', email: 'bob@example.com',
  });

  await store1.bucket('cache').insert({ key: 'theme', value: 'dark' });

  console.log(`Store 1: ${await store1.bucket('users').count()} uživatelů`);
  console.log(`Store 1: ${await store1.bucket('cache').count()} záznamů cache`);

  await store1.stop(); // Zapíše všechny dirty buckety před ukončením

  // --- Druhý běh: restart a ověření ---

  const store2 = await Store.start({
    name: 'user-app',
    persistence: { adapter },
  });

  await store2.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true, format: 'email', unique: true },
      role:  { type: 'string', enum: ['user', 'admin'], default: 'user' },
    },
    indexes: ['email', 'role'],
  });

  await store2.defineBucket('cache', {
    key: 'key',
    schema: {
      key:   { type: 'string', required: true },
      value: { type: 'string', required: true },
    },
    persistent: false,
  });

  // Uživatelé přežili restart
  console.log(`\nStore 2: ${await store2.bucket('users').count()} uživatelů`); // 2

  // Cache nepřežil (persistent: false)
  console.log(`Store 2: ${await store2.bucket('cache').count()} záznamů cache`); // 0

  // Data jsou neporušená
  const restoredAlice = await store2.bucket('users').get(alice.id);
  console.log(`Alice: ${restoredAlice?.name}, role=${restoredAlice?.role}`);

  // Indexy fungují po obnovení
  const admins = await store2.bucket('users').where({ role: 'admin' });
  console.log(`Administrátoři: ${admins.length}`); // 1

  // Unikátní omezení fungují po obnovení
  try {
    await store2.bucket('users').insert({
      name: 'Fake', email: 'alice@example.com',
    });
  } catch (err) {
    console.log(`Unikátní omezení: ${(err as Error).message}`);
  }

  await store2.stop();
}

main();
```

## Cvičení

Vytváříte systém feature-flagů. Store má dva buckety: `flags` (persistentní) ukládá definice feature flagů a `evaluationCache` (nepersistentní) ukládá nedávné výsledky vyhodnocení flagů pro zvýšení výkonu.

```typescript
const store = await Store.start({
  name: 'feature-flags',
  persistence: { adapter: new MemoryAdapter() },
});

await store.defineBucket('flags', {
  key: 'name',
  schema: {
    name:        { type: 'string', required: true },
    enabled:     { type: 'boolean', required: true },
    description: { type: 'string' },
    percentage:  { type: 'number', min: 0, max: 100, default: 100 },
  },
  indexes: ['enabled'],
});
```

1. Definujte bucket `evaluationCache` s poli `flagName` (string, klíč), `userId` (string, povinný), `result` (boolean, povinný) a `evaluatedAt` (number, povinný). Neměl by být persistentní.
2. Vložte tři feature flagy: `dark-mode` (zapnutý, 100%), `new-checkout` (zapnutý, 50%) a `beta-api` (vypnutý).
3. Zastavte a restartujte store se stejným adaptérem. Který bucket po restartu obsahuje data a který je prázdný?
4. Můžete po restartu dotazovat flagy podle `enabled: true`? Proč?

<details>
<summary>Řešení</summary>

1. Definice bucketu `evaluationCache`:

```typescript
await store.defineBucket('evaluationCache', {
  key: 'flagName',
  schema: {
    flagName:    { type: 'string', required: true },
    userId:      { type: 'string', required: true },
    result:      { type: 'boolean', required: true },
    evaluatedAt: { type: 'number', required: true },
  },
  persistent: false,
});
```

2. Vložení flagů:

```typescript
const flags = store.bucket('flags');

await flags.insert({ name: 'dark-mode', enabled: true, description: 'Tmavý motiv', percentage: 100 });
await flags.insert({ name: 'new-checkout', enabled: true, description: 'Přepracovaná pokladna', percentage: 50 });
await flags.insert({ name: 'beta-api', enabled: false, description: 'Beta API endpointy' });
```

3. Po restartu má `flags` 3 záznamy (persistentní) a `evaluationCache` má 0 záznamů (nepersistentní):

```typescript
await store.stop();

// Restart se stejným adaptérem
const store2 = await Store.start({
  name: 'feature-flags',
  persistence: { adapter },
});

// Znovu definovat oba buckety se stejnými schématy
await store2.defineBucket('flags', { /* stejná definice */ });
await store2.defineBucket('evaluationCache', { /* stejná definice, persistent: false */ });

console.log(await store2.bucket('flags').count());           // 3
console.log(await store2.bucket('evaluationCache').count()); // 0
```

4. Ano, po restartu můžete dotazovat `flags` podle `enabled: true`. Definice `indexes: ['enabled']` způsobí přestavení indexu z obnovených záznamů během `defineBucket()`. Obnovené záznamy jsou postupně předány do `IndexManager.addRecord()`, takže index je plně funkční:

```typescript
const enabledFlags = await store2.bucket('flags').where({ enabled: true });
console.log(enabledFlags.length); // 2 (dark-mode, new-checkout)
```

</details>

## Shrnutí

- **`StorePersistenceConfig`** má tři vlastnosti: `adapter` (povinný), `debounceMs` (výchozí 100) a `onError` (volitelný callback)
- **Úložištní adaptéry** implementují jednoduché rozhraní `save`/`load`/`close` — použijte `MemoryAdapter` pro testy, `FileAdapter` pro jednoduché aplikace, `SQLiteAdapter` pro produkci
- **Debounced snapshoty** sdružují více mutací do jednoho zápisu na bucket — 100 rychlých insertů má za výsledek jedno volání adaptéru, ne 100
- Snapshot zachycuje **úplný stav bucketu** atomicky přes GenServer call — záznamy a autoincrement čítač
- **Per-bucket opt-out**: nastavte `persistent: false` na dočasných bucketech (cache, relace, odvozená data) pro přeskočení persistence
- **Chyby jsou nekritické**: store pokračuje v provozu v paměti když adaptér selže; chyby jsou hlášeny přes `onError` callback
- Persistence se přihlásí k odběru na **EventBus** — stejné události, které řídí reaktivní dotazy a vaše handlery událostí, spouští i persistenci
- **`store.stop()`** zapíše všechny dirty buckety před ukončením a zajistí tak, že při řádném vypnutí se neztratí žádná data

---

Další: [Obnova a snapshoty](./02-obnova-a-snapshoty.md)
