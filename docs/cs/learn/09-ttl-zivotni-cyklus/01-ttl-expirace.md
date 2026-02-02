# TTL expirace

Váš cache bucket roste bez omezení. Session tokeny ze včerejška leží vedle tokenů z minulého měsíce. Cachované odpovědi z API endpointů, které už neexistují, zabírají paměť vedle čerstvých dat. Píšete cleanup skripty běžící na cronu, ručně iterujete každý záznam, kontrolujete časové značky a mažete — jenže závodí s inserty, přehlédnou okrajové případy a přidávají provozní zátěž, která roste s počtem bucketů.

noex-store poskytuje vestavěnou podporu TTL (Time-To-Live). Definujte trvání na bucketu a každý vložený záznam dostane časovou značku expirace. `TtlManager` na pozadí periodicky skenuje zaregistrované buckety a promazává expirované záznamy — emituje delete události, spouští aktualizace reaktivních dotazů a udržuje paměť ohraničenou. Můžete také přepsat expiraci per záznam nebo kdykoliv spustit manuální promazání.

## Co se naučíte

- Jak konfigurovat TTL na bucketu pomocí čitelných řetězců trvání
- Jak se `_expiresAt` vypočítá a uloží na každém záznamu
- Jak `TtlManager` plánuje a provádí promazávací cykly
- Jak přepsat TTL per záznam při vkládání
- Jak spustit manuální promazání pomocí `store.purgeTtl()`
- Jak TTL interaguje s událostmi, reaktivními dotazy a persistencí

## Syntaxe trvání

TTL přijímá buď číslo (milisekundy) nebo čitelný řetězec s příponou jednotky:

| Formát | Jednotka | Příklad | Milisekundy |
|--------|----------|---------|-------------|
| `number` | milisekundy | `5000` | `5000` |
| `"Ns"` | sekundy | `"30s"` | `30 000` |
| `"Nm"` | minuty | `"5m"` | `300 000` |
| `"Nh"` | hodiny | `"1h"` | `3 600 000` |
| `"Nd"` | dny | `"7d"` | `604 800 000` |

Desetinné hodnoty jsou podporovány: `"1.5h"` = 5 400 000ms, `"0.5d"` = 43 200 000ms.

Hodnota musí být kladná a konečná. Nula, záporné hodnoty a `Infinity` vyhodí chybu.

```typescript
// Všechny ekvivalentní — 5minutové TTL
await store.defineBucket('cache', { ...def, ttl: 300_000 });
await store.defineBucket('cache', { ...def, ttl: '5m' });
await store.defineBucket('cache', { ...def, ttl: '300s' });
```

## Konfigurace TTL bucketu

Přidejte vlastnost `ttl` do jakékoliv definice bucketu:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start();

await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token:  { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
    ip:     { type: 'string' },
  },
  ttl: '30m', // Relace expirují po 30 minutách
});

const session = await store.bucket('sessions').insert({
  userId: 'user-42',
  ip: '192.168.1.1',
});

console.log(session._expiresAt);
// session._createdAt + 1_800_000 (30 minut v ms)
```

Když je záznam vložen do bucketu s TTL, store vypočítá `_expiresAt = _createdAt + ttlMs` a připojí ho k metadatům záznamu. Pole `_expiresAt` je Unix milisekundová časová značka — stejný formát jako `Date.now()`.

### Jak se nastavuje `_expiresAt`

```text
  insert({ userId: 'user-42' })
      |
      v
  SchemaValidator.prepareInsert()
      |  - vygeneruje klíč (uuid)
      |  - nastaví _createdAt = Date.now()
      |  - nastaví _version = 1
      |
      v
  TTL kontrola: má bucket ttl A záznam nemá _expiresAt?
      |
      ano -> _expiresAt = _createdAt + ttlMs
      |
      v
  Záznam uložen do bucket Map
```

TTL se aplikuje **po** validaci a automatickém generování, ale **před** uložením záznamu. Pokud záznam již má hodnotu `_expiresAt` (přepsání per záznam), TTL bucketu se přeskočí.

## Přepsání TTL per záznam

Výchozí TTL bucketu můžete přepsat pro jednotlivé záznamy předáním `_expiresAt` přímo v datech pro vložení:

```typescript
await store.defineBucket('cache', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    url:   { type: 'string', required: true },
    body:  { type: 'string', required: true },
  },
  ttl: '1h', // Výchozí: 1hodinové TTL
});

const cache = store.bucket('cache');

// Použije výchozí 1hodinové TTL
const normal = await cache.insert({
  url: '/api/users',
  body: '{"users": [...]}',
});
console.log(normal._expiresAt); // _createdAt + 3_600_000

// Přepsání: tato odpověď platí jen 30 sekund
const shortLived = await cache.insert({
  url: '/api/health',
  body: '{"status": "ok"}',
  _expiresAt: Date.now() + 30_000,
});
console.log(shortLived._expiresAt); // ~30 sekund od teď

// Přepsání: tato odpověď má žít 24 hodin
const longLived = await cache.insert({
  url: '/api/config',
  body: '{"theme": "dark"}',
  _expiresAt: Date.now() + 86_400_000,
});
```

To je užitečné, když různé záznamy ve stejném bucketu mají různé požadavky na čerstvost — odpovědi health checku expirují za sekundy, zatímco konfigurační odpovědi mohou žít hodiny.

## TtlManager

`TtlManager` je plánovač na pozadí, který periodicky skenuje všechny TTL buckety a promazává expirované záznamy. Vytváří se automaticky při startu store.

### Architektura

```text
  Store.start()
      |
      v
  Vytvoření TtlManager(checkIntervalMs)
      |
      v
  Pro každý defineBucket() s ttl:
      |
      +-- ttlManager.registerBucket(name, ref, ttlMs)
      |
      v
  ttlManager.start()
      |
      v
  Naplánování tick (setTimeout)
      |
      +-- tick() -> pro každý bucket: GenServer.call({ type: 'purgeExpired' })
      |                  |
      |                  v
      |            BucketServer skenuje všechny záznamy:
      |              pokud record._expiresAt <= Date.now() -> smazat + emitovat událost
      |                  |
      |                  v
      |            Vrátit počet promazaných záznamů
      |
      +-- Naplánování dalšího tick (setTimeout)
      |
      (opakuje se dokud se nezavolá stop())
```

### Klíčová návrhová rozhodnutí

| Rozhodnutí | Zdůvodnění |
|------------|-----------|
| Řetězení `setTimeout`, ne `setInterval` | Zabraňuje překrývání ticků, když promazávací cyklus běží déle než interval kontroly |
| Přeskakuje zastavené buckety | Bucket může být odstraněn mezi ticky — `TtlManager` kontroluje `GenServer.isRunning()` před každým voláním |
| Spolkne chyby per bucket | Jeden selhávající bucket nebrání promazání ostatních bucketů |
| Běží ve stejné event loop | Žádné worker thready — promazání je série async GenServer volání |

### Konfigurace intervalu kontroly

Výchozí interval kontroly je 1000ms (1 sekunda). Konfigurujte ho přes `ttlCheckIntervalMs` ve volbách store:

```typescript
// Výchozí: kontrola každou 1 sekundu
const store = await Store.start();

// Agresivní: kontrola každých 100ms (vyšší CPU, nižší latence expirace)
const store = await Store.start({ ttlCheckIntervalMs: 100 });

// Uvolněný: kontrola každých 10 sekund (nižší CPU, záznamy mohou žít až 10s po expiraci)
const store = await Store.start({ ttlCheckIntervalMs: 10_000 });

// Vypnutý: žádné automatické kontroly (pouze manuální promazání)
const store = await Store.start({ ttlCheckIntervalMs: 0 });
```

| Interval | Latence expirace | CPU režie | Případy použití |
|----------|-----------------|-----------|-----------------|
| `100` | ~100ms | Vyšší | Real-time systémy, krátká TTL |
| `1000` (výchozí) | ~1s | Nízká | Obecné cachování |
| `10000` | ~10s | Minimální | Dlouhá TTL (hodiny/dny), nízký provoz |
| `0` | Pouze manuální | Žádná | Testy, plná kontrola |

Latence expirace je nejhorší možné zpoždění mezi `_expiresAt` záznamu a jeho skutečným odstraněním. Záznam s `_expiresAt = 1000` a intervalem kontroly 5000ms může žít až do `t = 5999`.

## Manuální promazání

Zavolejte `store.purgeTtl()` pro spuštění okamžité kontroly expirace napříč všemi TTL buckety:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 }); // Automatické kontroly vypnuty

await store.defineBucket('tokens', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '1h',
});

await store.bucket('tokens').insert({ userId: 'user-1' });
await store.bucket('tokens').insert({ userId: 'user-2' });

// Později, když víte, že tokeny by měly být expirované...
const purged = await store.purgeTtl();
console.log(`Promazáno ${purged} expirovaných záznamů`);
```

`purgeTtl()` vrací celkový počet promazaných záznamů napříč všemi buckety. Je užitečné v testech, kde chcete deterministickou expiraci bez čekání na automatický plánovač, nebo v aplikacích, které preferují explicitní kontrolu.

## TTL a události

Expirované záznamy se mažou stejnou cestou jako manuální smazání. Každý promazaný záznam emituje událost `bucket.<jméno>.deleted`:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('cache', {
  key: 'id',
  schema: {
    id:  { type: 'string', generated: 'uuid' },
    url: { type: 'string', required: true },
  },
  ttl: 100, // 100ms pro demonstraci
});

// Naslouchání smazáním (manuálním i TTL)
await store.on('bucket.cache.deleted', (event) => {
  console.log(`Záznam expiroval: key=${event.key}`);
});

await store.bucket('cache').insert({ url: '/api/data' });

// Počkat na expiraci, pak promazat
await new Promise((r) => setTimeout(r, 150));
await store.purgeTtl();
// Konzole: "Záznam expiroval: key=<uuid>"
```

Neexistuje žádný samostatný typ události "expired". Konzumenti vidí standardní událost `deleted` — nemusí vědět, jestli bylo smazání manuální nebo řízené TTL. Pokud potřebujete rozlišovat, zkontrolujte `record._expiresAt` v payloadu události: pokud existuje a je menší nebo roven `Date.now()`, smazání bylo pravděpodobně spuštěno expirací TTL.

## TTL a reaktivní dotazy

Když se expirované záznamy promazávají, jakýkoliv reaktivní dotaz závislý na dotčeném bucketu se automaticky přehodnotí:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token:  { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: 100,
});

store.defineQuery('activeSessions', async (ctx) => {
  return ctx.bucket('sessions').all();
});

const snapshots: unknown[][] = [];
await store.subscribe('activeSessions', (result) => {
  snapshots.push(result);
});

// Vložení relace
await store.bucket('sessions').insert({ userId: 'user-1' });
await store.settle();
console.log(snapshots.length);    // 1
console.log(snapshots[0].length); // 1 relace

// Počkat na expiraci, pak promazat
await new Promise((r) => setTimeout(r, 150));
await store.purgeTtl();
await store.settle();
console.log(snapshots.length);    // 2
console.log(snapshots[1].length); // 0 relací — reaktivní dotaz se aktualizoval automaticky
```

Reaktivní dotaz vidí prázdný bucket po promazání — žádné manuální znovu-odběry ani polling není potřeba. Jedná se o stejný mechanismus, který zpracovává manuální smazání a aktualizace.

## TTL a persistence

TTL a persistence fungují nezávisle. Bucket s TTL může být persistentní — pole `_expiresAt` je součástí záznamu a přežije restart:

```typescript
import { MemoryAdapter } from '@hamicek/noex';

const adapter = new MemoryAdapter();

// První běh: vložení záznamu s 1hodinovým TTL
const store1 = await Store.start({
  name: 'app',
  persistence: { adapter },
  ttlCheckIntervalMs: 0,
});

await store1.defineBucket('cache', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    data: { type: 'string', required: true },
  },
  ttl: '1h',
});

const record = await store1.bucket('cache').insert({ data: 'cached response' });
console.log(record._expiresAt); // 1 hodina od teď

await store1.stop();

// Druhý běh: záznam je obnoven s neporušeným _expiresAt
const store2 = await Store.start({
  name: 'app',
  persistence: { adapter },
  ttlCheckIntervalMs: 0,
});

await store2.defineBucket('cache', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    data: { type: 'string', required: true },
  },
  ttl: '1h',
});

const restored = await store2.bucket('cache').get(record.id);
console.log(restored?._expiresAt === record._expiresAt); // true

// Pokud TTL vypršelo během výpadku, další promazání ho odstraní
await store2.purgeTtl();

await store2.stop();
```

Pokud byl proces vypnutý déle než TTL, `_expiresAt` záznamu bude po restartu v minulosti. První promazávací cyklus (automatický nebo manuální) ho odstraní.

## Statistiky bucketu

Informace související s TTL jsou dostupné přes statistiky bucketu:

```typescript
const stats = await store.bucket('sessions').stats();

console.log(stats.hasTtl);   // true — bucket má nakonfigurované TTL
console.log(stats.hasMaxSize); // false — žádné maxSize na tomto bucketu
```

A na úrovni store:

```typescript
const storeStats = await store.stats();

console.log(storeStats.ttl.enabled);        // true — TtlManager běží
console.log(storeStats.ttl.checkIntervalMs); // 1000
```

## Kompletní funkční příklad

Zkracovač URL s cachovaným vyhledáváním přesměrování, které expiruje po 15 minutách:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ ttlCheckIntervalMs: 0 });

  // Trvalý bucket pro definice krátkých URL
  await store.defineBucket('urls', {
    key: 'slug',
    schema: {
      slug:      { type: 'string', required: true },
      targetUrl: { type: 'string', required: true },
      createdBy: { type: 'string', required: true },
      clicks:    { type: 'number', default: 0 },
    },
    indexes: ['createdBy'],
  });

  // Cache bucket pro vyřešená přesměrování (TTL: 15 minut)
  await store.defineBucket('redirectCache', {
    key: 'slug',
    schema: {
      slug:      { type: 'string', required: true },
      targetUrl: { type: 'string', required: true },
    },
    ttl: '15m',
  });

  // Naslouchání expiracím cache
  await store.on('bucket.redirectCache.deleted', (event) => {
    console.log(`Cache expirovala pro slug: ${event.key}`);
  });

  // Reaktivní dotaz: počet aktivních záznamů cache
  store.defineQuery('cacheSize', async (ctx) => {
    return ctx.bucket('redirectCache').count();
  });

  await store.subscribe('cacheSize', (count) => {
    console.log(`Aktivní záznamy cache: ${count}`);
  });

  // Vytvoření URL mapování
  const urls = store.bucket('urls');
  const cache = store.bucket('redirectCache');

  await urls.insert({ slug: 'docs', targetUrl: 'https://docs.example.com', createdBy: 'admin' });
  await urls.insert({ slug: 'blog', targetUrl: 'https://blog.example.com', createdBy: 'admin' });
  await urls.insert({ slug: 'gh', targetUrl: 'https://github.com/example', createdBy: 'dev' });

  // Simulace vyřešení přesměrování (naplní cache)
  async function resolve(slug: string): Promise<string | undefined> {
    // Nejprve zkontrolovat cache
    const cached = await cache.get(slug);
    if (cached) return cached.targetUrl as string;

    // Cache miss: vyhledat a uložit do cache
    const url = await urls.get(slug);
    if (!url) return undefined;

    await cache.insert({ slug, targetUrl: url.targetUrl as string });
    await urls.update(slug, { clicks: (url.clicks as number) + 1 });
    return url.targetUrl as string;
  }

  console.log(await resolve('docs'));  // https://docs.example.com (cache miss)
  console.log(await resolve('docs'));  // https://docs.example.com (cache hit)
  console.log(await resolve('blog')); // https://blog.example.com (cache miss)

  await store.settle();
  // Konzole: "Aktivní záznamy cache: 2"

  console.log(`Záznamy cache: ${await cache.count()}`); // 2
  console.log(`Kliknutí URL:`, (await urls.get('docs'))?.clicks); // 1

  // Simulace uplynutí času — v produkci TtlManager toto zvládá automaticky
  // V tomto příkladu demonstrujeme manuální promazání:
  console.log('\n--- Simulace expirace ---');

  // V reálné aplikaci by po 15 minutách automatické promazání tyto záznamy odstranilo.
  // Zde demonstrujeme manuální promazání:
  await store.purgeTtl();
  await store.settle();

  console.log(`Záznamy cache po promazání: ${await cache.count()}`);

  await store.stop();
}

main();
```

## Cvičení

Vytváříte rate limiter. Každý API požadavek vytvoří záznam v bucketu `rateLimits` s 1minutovým TTL. Pro kontrolu, zda je uživatel omezen, spočítáte jeho záznamy — pokud počet překročí práh, požadavek odmítnete.

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('rateLimits', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
    path:   { type: 'string', required: true },
  },
  indexes: ['userId'],
  ttl: '1m',
});
```

1. Napište funkci `recordRequest(userId: string, path: string)`, která vloží záznam rate limitu.
2. Napište funkci `isRateLimited(userId: string, limit: number): Promise<boolean>`, která vrátí `true`, pokud má uživatel `limit` nebo více aktivních záznamů.
3. Zaznamenejte 3 požadavky pro uživatele `"alice"` na cestu `"/api/data"`. Je Alice omezená s limitem 5? S limitem 3?
4. Počkejte na expiraci TTL, spusťte `purgeTtl()` a zkontrolujte, zda je Alice stále omezená.
5. Bonus: Vložte požadavek s vlastním `_expiresAt` 10 sekund místo výchozí 1 minuty. Kdy tento záznam expiruje ve srovnání s ostatními?

<details>
<summary>Řešení</summary>

```typescript
const rl = store.bucket('rateLimits');

// 1. Zaznamenání požadavku
async function recordRequest(userId: string, path: string) {
  await rl.insert({ userId, path });
}

// 2. Kontrola rate limitu
async function isRateLimited(userId: string, limit: number): Promise<boolean> {
  const records = await rl.where({ userId });
  return records.length >= limit;
}

// 3. Zaznamenání 3 požadavků pro Alice
await recordRequest('alice', '/api/data');
await recordRequest('alice', '/api/data');
await recordRequest('alice', '/api/data');

console.log(await isRateLimited('alice', 5)); // false (3 < 5)
console.log(await isRateLimited('alice', 3)); // true  (3 >= 3)

// 4. Počkat na expiraci TTL a promazat
await new Promise((r) => setTimeout(r, 61_000)); // Počkat > 1 minutu
const purged = await store.purgeTtl();
console.log(`Promazáno: ${purged}`); // 3

console.log(await isRateLimited('alice', 3)); // false (0 < 3)

// 5. Vlastní expirace
const shortLived = await rl.insert({
  userId: 'alice',
  path: '/api/health',
  _expiresAt: Date.now() + 10_000, // 10 sekund místo 1 minuty
});

const defaultLived = await rl.insert({
  userId: 'alice',
  path: '/api/data',
});

console.log(shortLived._expiresAt);  // ~10 sekund od teď
console.log(defaultLived._expiresAt); // ~60 sekund od teď
// Krátkodobý záznam expiruje o 50 sekund dříve než výchozí.
```

</details>

## Shrnutí

- **TTL je per-bucket**: nastavte `ttl` v definici bucketu pomocí čísla (ms) nebo řetězce s příponou (`"30s"`, `"5m"`, `"1h"`, `"7d"`)
- **`_expiresAt`** je Unix milisekundová časová značka automaticky vypočtená jako `_createdAt + ttlMs` při vkládání
- **Přepsání per záznam**: předejte `_expiresAt` v datech pro vložení pro přepsání výchozí hodnoty bucketu — užitečné pro záznamy s různými požadavky na čerstvost
- **`TtlManager`** spouští smyčku na pozadí pomocí řetězení `setTimeout` — volá `purgeExpired` na každém zaregistrovaném bucketu v nakonfigurovaném intervalu (výchozí: 1s)
- Interval kontroly je konfigurovatelný přes `ttlCheckIntervalMs` ve volbách store — nastavte na `0` pro vypnutí automatických kontrol
- **`store.purgeTtl()`** spouští okamžité promazání napříč všemi TTL buckety a vrací celkový počet promazaných záznamů
- Expirované záznamy emitují standardní události **`bucket.<jméno>.deleted`** — žádný samostatný typ události "expired"
- **Reaktivní dotazy** závislé na TTL bucketu se automaticky přehodnotí při promazání záznamů
- TTL záznamy **přežívají persistenci** — `_expiresAt` je součástí záznamu a je obnoven po restartu; první promazávací cyklus odstraní záznamy, které expirovaly během výpadku
- **Statistiky bucketu** vystavují `hasTtl` a statistiky store vystavují `ttl.enabled` a `ttl.checkIntervalMs`

---

Další: [Limity velikosti a evikce](./02-limity-velikosti-a-evikce.md)
