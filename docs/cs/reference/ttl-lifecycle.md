# TTL a životní cyklus — API reference

> Expirace pomocí time-to-live, evikce na základě velikosti a metadata záznamů — automatická správa životního cyklu dat v bucketech.

## Přehled

noex-store poskytuje dva mechanismy pro omezení dat v bucketu: **TTL** (time-to-live) automaticky odstraňuje záznamy po konfigurovatelné době a **maxSize** evikuje nejstarší záznamy, když bucket překročí svůj kapacitní limit. Oba mechanismy emitují standardní události `deleted`, takže reaktivní dotazy a event handlery reagují na odstranění v rámci životního cyklu stejně jako na manuální smazání.

Metadata záznamu (`_version`, `_createdAt`, `_updatedAt`, `_expiresAt`) jsou udržována automaticky storem a řídí jak expiraci, tak evikci.

---

## TTL (Time-to-Live)

### Konfigurace

Nastavte `ttl` na BucketDefinition pro zapnutí automatické expirace:

```typescript
await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token: { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '30m', // Záznamy expirují po 30 minutách
});
```

Vlastnost `ttl` přijímá dva formáty:

| Formát | Typ | Interpretace | Příklad |
|--------|-----|--------------|---------|
| Number | `number` | Milisekundy (musí být kladné a konečné) | `300000` |
| String | `string` | Lidsky čitelné trvání s příponou jednotky | `"30m"` |

### Syntaxe řetězce trvání

Řetězce mají formát `<hodnota><jednotka>`, kde hodnota může být celé číslo nebo desetinné:

| Jednotka | Přípona | Násobitel | Příklady |
|----------|---------|-----------|----------|
| Sekundy | `s` | 1 000 ms | `"30s"`, `"2.5s"` |
| Minuty | `m` | 60 000 ms | `"5m"`, `"1.5m"` |
| Hodiny | `h` | 3 600 000 ms | `"1h"`, `"0.5h"` |
| Dny | `d` | 86 400 000 ms | `"7d"`, `"90d"` |

Mezery mezi číslem a jednotkou jsou povoleny (`"30 m"` funguje).

**Neplatné vstupy** vyhodí `Error`:

```typescript
parseTtl(0);         // Error: TTL must be a positive finite number
parseTtl(-100);      // Error: TTL must be a positive finite number
parseTtl(Infinity);  // Error: TTL must be a positive finite number
parseTtl('');        // Error: Invalid TTL format
parseTtl('fast');    // Error: Invalid TTL format
parseTtl('10w');     // Error: Invalid TTL format (unsupported unit)
```

### Jak funguje expirace

1. **Při insertu** — pokud má bucket nastavené `ttl` a záznam ještě nemá `_expiresAt`, store nastaví `_expiresAt = _createdAt + ttlMs`.
2. **Automatické kontroly** — TtlManager periodicky prochází všechny buckety s povoleným TTL a odstraňuje záznamy, kde `_expiresAt <= Date.now()`.
3. **Manuální spuštění** — zavolejte `store.purgeTtl()` pro vynucení okamžité kontroly expirace.

Každý odstraněný záznam emituje událost `bucket.<name>.deleted`, která spustí přehodnocení reaktivních dotazů a sledování persistence.

### Přepsání pro jednotlivý záznam

Záznam může přepsat výchozí TTL bucketu tím, že při insertu poskytne vlastní `_expiresAt`:

```typescript
const sessions = store.bucket('sessions');

// Použije TTL bucketu (30 minut od teď)
await sessions.insert({ userId: 'u1' });

// Vlastní expirace: 7 dní od teď
await sessions.insert({
  userId: 'u2',
  _expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
});
```

Pokud je `_expiresAt` již nastaveno na vstupních datech, výchozí TTL bucketu jej nepřepíše.

---

## `parseTtl(ttl): number`

Exportovaná utility funkce, která převádí hodnotu TTL na milisekundy.

```typescript
import { parseTtl } from '@hamicek/noex-store';
```

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `ttl` | `number \| string` | Hodnota TTL — milisekundy (number) nebo řetězec trvání (`"30s"`, `"5m"`, `"1h"`, `"7d"`) |

**Vrací:** `number` — TTL v milisekundách.

**Vyhazuje:** `Error` — pokud je formát neplatný nebo hodnota není kladná.

**Příklad:**

```typescript
parseTtl(5000);    // 5000
parseTtl('30s');   // 30000
parseTtl('5m');    // 300000
parseTtl('1h');    // 3600000
parseTtl('7d');    // 604800000
parseTtl('1.5h'); // 5400000
parseTtl('0.5d'); // 43200000
```

---

## Limity velikosti (`maxSize`)

### Konfigurace

Nastavte `maxSize` na BucketDefinition pro omezení počtu záznamů:

```typescript
await store.defineBucket('recentLogs', {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    message: { type: 'string', required: true },
  },
  maxSize: 1000, // Maximálně 1000 záznamů
});
```

### Chování evikce

Když by `insert` způsobil překročení `maxSize` počtu záznamů, **nejstarší** záznamy (podle časového razítka `_createdAt`) jsou evikovány předtím, než je nový záznam přidán:

1. Záznamy jsou seřazeny podle `_createdAt` vzestupně.
2. Je odstraněno dostatečné množství záznamů, aby se uvolnilo místo pro nový.
3. Každý evikovaný záznam emituje událost `bucket.<name>.deleted`.
4. Nový záznam je poté vložen běžným způsobem.

```typescript
const logs = store.bucket('recentLogs');

// Vložení 1000 záznamů...
for (let i = 0; i < 1000; i++) {
  await logs.insert({ message: `Log entry ${i}` });
}

// Tento insert evikuje nejstarší záznam (entry 0)
await logs.insert({ message: 'Log entry 1000' });

const count = await logs.count(); // 1000
```

Evikce nastává pouze při `insert`. Aktualizace a jiné operace evikci nespouštějí.

### Kombinace TTL + maxSize

Oba mechanismy lze použít společně. Fungují nezávisle:

- **maxSize** evikuje při insertu, když je kapacita překročena.
- **TTL** čistí expirované záznamy na periodickém časovači nebo při manuálním volání `purgeTtl()`.

```typescript
await store.defineBucket('cache', {
  key: 'id',
  schema: {
    id: { type: 'string', required: true },
    data: { type: 'object' },
  },
  ttl: '1h',      // Expirace po 1 hodině
  maxSize: 500,    // Nikdy nepřekročí 500 záznamů
});
```

---

## TtlManager

Třída TtlManager orchestruje periodické kontroly expirace napříč všemi buckety s povoleným TTL. Je vytvářena interně metodou `Store.start()` a je rovněž exportována pro pokročilé případy použití.

```typescript
import { TtlManager } from '@hamicek/noex-store';
```

### `new TtlManager(checkIntervalMs?)`

Vytvoří nový TTL manager.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `checkIntervalMs` | `number` | `1000` | Interval mezi automatickými kontrolami expirace v milisekundách |

### Vlastnosti

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `bucketCount` | `number` | Počet aktuálně registrovaných bucketů s povoleným TTL |
| `enabled` | `boolean` | Zda běží automatické periodické kontroly |
| `checkIntervalMs` | `number` | Nakonfigurovaný interval kontrol v milisekundách |

### `ttlManager.registerBucket(name, ref, ttlMs): void`

Registruje bucket pro periodické TTL kontroly.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `name` | `string` | Název bucketu |
| `ref` | `BucketRef` | GenServer reference na bucket |
| `ttlMs` | `number` | Trvání TTL v milisekundách |

Pokud je bucket se stejným názvem již registrován, předchozí záznam je přepsán.

### `ttlManager.unregisterBucket(name): void`

Odstraní bucket z periodických TTL kontrol.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `name` | `string` | Název bucketu k odregistrování |

### `ttlManager.start(): void`

Spustí automatické periodické kontroly expirace. Idempotentní — volání `start()` na již běžícím manageru je no-op.

Používá řetězení `setTimeout` (nikoliv `setInterval`), aby se zabránilo překrývání tiků, když cyklus čištění trvá déle než interval kontrol.

### `ttlManager.stop(): void`

Zastaví automatické periodické kontroly a zruší jakýkoliv čekající časovač. Idempotentní — lze bezpečně volat vícekrát. Lze znovu spustit pomocí `start()`.

### `ttlManager.purge(): Promise<number>`

Manuálně spustí kontrolu expirace na všech registrovaných bucketech.

**Vrací:** `Promise<number>` — celkový počet odstraněných záznamů napříč všemi buckety.

Přeskakuje buckety, jejichž GenServer byl zastaven. Chyby v jednom bucketu nebrání zpracování ostatních bucketů.

---

## Integrace se Store

### `StoreOptions.ttlCheckIntervalMs`

Řídí interval automatické TTL kontroly na úrovni storu:

```typescript
const store = await Store.start({
  name: 'my-app',
  ttlCheckIntervalMs: 5000, // Kontrola každých 5 sekund
});
```

| Hodnota | Chování |
|---------|---------|
| `> 0` (výchozí: `1000`) | TtlManager se spustí automaticky s daným intervalem |
| `0` | Automatické kontroly jsou vypnuty; použijte `store.purgeTtl()` pro manuální řízení |

### `store.purgeTtl(): Promise<number>`

Manuálně spustí TTL kontrolu expirace na všech bucketech s povoleným TTL.

**Vrací:** `Promise<number>` — celkový počet odstraněných záznamů.

**Příklad:**

```typescript
const purged = await store.purgeTtl();
console.log(`Odstraněno ${purged} expirovaných záznamů`);
```

### `store.defineBucket()` — Registrace TTL

Když definice bucketu obsahuje `ttl`, store automaticky:

1. Parsuje hodnotu TTL pomocí `parseTtl()`.
2. Registruje bucket u TtlManager.

### `store.dropBucket()` — Odregistrace TTL

Zrušení bucketu automaticky odregistruje bucket z TtlManager.

### `store.stop()` — Vypnutí

`store.stop()` volá `ttlManager.stop()` před rozebráním stromu supervisorů, čímž zajistí, že žádné cykly čištění neběží proti zastaveným bucket serverům.

### `store.getStats()` — Stav TTL

Sekce `StoreStats.ttl` reportuje stav TTL subsystému:

```typescript
const stats = await store.getStats();
console.log(stats.ttl);
// { enabled: true, checkIntervalMs: 1000 }
```

```typescript
interface StoreStats {
  // ... další pole ...
  readonly ttl: {
    readonly enabled: boolean;       // Zda běží automatické kontroly
    readonly checkIntervalMs: number; // Nakonfigurovaný interval kontrol
  };
}
```

Stav TTL pro jednotlivý bucket je dostupný přes BucketStats:

```typescript
interface BucketStats {
  readonly hasTtl: boolean;             // Zda má bucket povolené TTL
  readonly hasMaxSize: boolean;         // Zda má bucket limit maxSize
  readonly maxSize: number | undefined; // Hodnota maxSize, pokud je nastavena
  // ... další pole ...
}
```

---

## Metadata záznamu

Každý záznam ve storu nese čtyři pole metadat, udržovaná automaticky pomocí SchemaValidator:

### `RecordMeta`

```typescript
interface RecordMeta {
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
  readonly _expiresAt?: number;
}
```

```typescript
type StoreRecord<T = Record<string, unknown>> = T & RecordMeta;
```

### Detail polí

#### `_version`

| Aspekt | Detail |
|--------|--------|
| Typ | `number` |
| Nastaveno při insertu | `1` |
| Nastaveno při updatu | Inkrementováno o 1 (`existing._version + 1`) |
| Účel | Optimistické zamykání v transakcích — TransactionConflictError je vyhozen, když se verze záznamu změnila mezi čtením a commitem |

#### `_createdAt`

| Aspekt | Detail |
|--------|--------|
| Typ | `number` |
| Hodnota | `Date.now()` v okamžiku vložení (Unix timestamp v milisekundách) |
| Neměnné | Nemění se při aktualizaci |
| Účel | Používáno evikcí `maxSize` (nejstarší podle `_createdAt` jsou evikovány jako první) |

#### `_updatedAt`

| Aspekt | Detail |
|--------|--------|
| Typ | `number` |
| Nastaveno při insertu | Stejné jako `_createdAt` |
| Nastaveno při updatu | `Date.now()` v okamžiku aktualizace |
| Účel | Sledování, kdy byl záznam naposledy změněn |

#### `_expiresAt`

| Aspekt | Detail |
|--------|--------|
| Typ | `number \| undefined` |
| Nastaveno při insertu | `_createdAt + ttlMs` pro buckety s povoleným TTL; `undefined` pro buckety bez TTL |
| Přepsání | Lze explicitně nastavit při insertu pro přepsání výchozí hodnoty bucketu |
| Účel | TtlManager odstraňuje záznamy, kde `_expiresAt <= Date.now()` |

### Metadata při aktualizaci

Metoda `SchemaValidator.prepareUpdate()` odstraní `_version`, `_createdAt` a `_updatedAt` z uživatelem poskytnutých změn — tato pole nelze přímo modifikovat:

```typescript
// Tato meta pole v objektu změn jsou tiše ignorována:
await bucket.update(key, {
  name: 'New name',     // Aplikováno
  _version: 999,        // Odstraněno — verze se inkrementuje automaticky
  _createdAt: 0,        // Odstraněno — časové razítko vytvoření je neměnné
  _updatedAt: 0,        // Odstraněno — nastaveno na Date.now() automaticky
});
```

---

## Události

Jak expirace TTL, tak evikce maxSize emitují standardní události `bucket.<name>.deleted`:

```typescript
const unsub = await store.on('bucket.sessions.deleted', (event) => {
  console.log('Záznam odstraněn:', event.key);
  // Funguje stejně, ať byl záznam smazán manuálně,
  // expirován pomocí TTL, nebo evikován pomocí maxSize
});
```

Typ události pro všechna smazání (manuální, TTL, evikce):

```typescript
interface BucketDeletedEvent {
  readonly type: 'deleted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord;
}
```

Tyto události také spouštějí:
- **Přehodnocení reaktivních dotazů** — odběry přepočítají výsledky, když jsou závislé záznamy odstraněny čištěním nebo evikcí
- **Sledování persistence** — bucket je označen jako změněný a bude persistován po uplynutí debounce intervalu

---

## Viz také

- [Store API](./store.md) — volby `Store.start()` (`ttlCheckIntervalMs`), `store.purgeTtl()`, `store.getStats()`
- [Schéma a typy](./schema.md) — `BucketDefinition.ttl`, `BucketDefinition.maxSize`, `RecordMeta`
- [BucketHandle API](./bucket-handle.md) — `insert()` a jak se nastavuje `_expiresAt`
- [Event systém](./events.md) — události `bucket.<name>.deleted` z čištění a evikce
- [Persistence](./persistence.md) — jak události životního cyklu spouštějí snímky persistence
- [Transakce](./transactions.md) — `_version` a optimistické zamykání
- [Utility funkce](./utilities.md) — reference funkce `parseTtl()`
- [Chyby](./errors.md) — TransactionConflictError související s `_version`
- **Výuka:** [TTL expirace](../learn/09-ttl-zivotni-cyklus/01-ttl-expirace.md) — konceptuální úvod s cvičeními
- **Výuka:** [Limity velikosti a evikce](../learn/09-ttl-zivotni-cyklus/02-limity-velikosti-a-evikce.md) — evikce maxSize s cvičeními
- **Zdrojový kód:** [`src/lifecycle/ttl-manager.ts`](../../../src/lifecycle/ttl-manager.ts)
- **Zdrojový kód:** [`src/utils/parse-ttl.ts`](../../../src/utils/parse-ttl.ts)
- **Zdrojový kód:** [`src/types/record.ts`](../../../src/types/record.ts)
- **Zdrojový kód:** [`src/core/bucket-server.ts`](../../../src/core/bucket-server.ts) — `handlePurgeExpired()`, `evictOldest()`
