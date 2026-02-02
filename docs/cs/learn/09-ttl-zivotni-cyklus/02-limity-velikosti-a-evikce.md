# Limity velikosti a evikce

Váš cache bucket uchovává každý vložený záznam. Sto záznamů se stane tisícem, pak deseti tisíci. Paměť roste proporcionálně a nakonec proces narazí na svůj limit. Mohli byste sledovat počet sami, rozhodovat, které záznamy smazat, řešit okrajové případy — ale každý bucket s omezením velikosti by potřeboval stejný boilerplate.

noex-store poskytuje `maxSize` — per-bucket strop na počet záznamů. Když by vložení přesáhlo limit, nejstarší záznamy (podle `_createdAt`) se automaticky evikují před uložením nového záznamu. Evikce emitují standardní delete události, spouští aktualizace reaktivních dotazů a udržují konzistenci indexů.

## Co se naučíte

- Jak konfigurovat `maxSize` na bucketu
- Jak evikční algoritmus vybírá záznamy k odstranění
- Jak evikce interaguje s událostmi, reaktivními dotazy a indexy
- Jak kombinovat `maxSize` s TTL pro dvojitě ohraničené buckety
- Jak uvažovat o pořadí evikce a okrajových případech

## Konfigurace maxSize

Přidejte vlastnost `maxSize` do jakékoliv definice bucketu:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start();

await store.defineBucket('recentLogs', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    level:   { type: 'string', enum: ['info', 'warn', 'error'], required: true },
    message: { type: 'string', required: true },
  },
  maxSize: 1000, // Uchovat jen posledních 1000 záznamů
});
```

`maxSize` musí být kladné celé číslo. Žádná výchozí hodnota není — buckety bez `maxSize` rostou bez omezení.

## Jak evikce funguje

Když by vložení způsobilo překročení `maxSize` bucketu, store evikuje nejstarší záznamy před uložením nového:

```text
  insert(newRecord)
      |
      v
  Je table.size >= maxSize?
      |
      ne -> Uložit newRecord normálně
      |
      ano -> Vypočítat evictCount = table.size - maxSize + 1
      |
      v
  Seřadit všechny záznamy podle _createdAt (vzestupně)
      |
      v
  Vzít prvních `evictCount` záznamů (nejstarší)
      |
      v
  Pro každý záznam k evikci:
      |
      +-- Odstranit z IndexManager
      +-- Odstranit z in-memory Map
      +-- Emitovat událost bucket.<jméno>.deleted
      |
      v
  Uložit newRecord normálně
```

### Vlastnosti evikce

| Vlastnost | Chování |
|-----------|---------|
| **Řadicí klíč** | `_createdAt` (vzestupně) — nejstarší záznamy se evikují jako první |
| **Počet evikcí** | `table.size - maxSize + 1` — uvolní místo přesně pro jeden nový záznam |
| **Atomické per vložení** | Evikce a vložení probíhají v rámci jedné GenServer zprávy — žádné souběžné mutace se neprokládají |
| **Konzistence indexů** | Evikované záznamy se odstraní ze všech sekundárních a unikátních indexů před přidáním nového záznamu |
| **Emise událostí** | Každý evikovaný záznam emituje standardní událost `bucket.<jméno>.deleted` |

### Příklad evikce

```typescript
const store = await Store.start();

await store.defineBucket('buffer', {
  key: 'id',
  schema: {
    id:   { type: 'number', generated: 'autoincrement' },
    data: { type: 'string', required: true },
  },
  maxSize: 3,
});

const buf = store.bucket('buffer');

const r1 = await buf.insert({ data: 'první' });   // velikost: 1
const r2 = await buf.insert({ data: 'druhý' });   // velikost: 2
const r3 = await buf.insert({ data: 'třetí' });   // velikost: 3

// Na kapacitě. Další vložení evikuje nejstarší záznam (r1).
const r4 = await buf.insert({ data: 'čtvrtý' });  // velikost: 3

console.log(await buf.get(r1.id)); // undefined — evikován
console.log(await buf.get(r2.id)); // { id: 2, data: 'druhý', ... }
console.log(await buf.get(r3.id)); // { id: 3, data: 'třetí', ... }
console.log(await buf.get(r4.id)); // { id: 4, data: 'čtvrtý', ... }
console.log(await buf.count());    // 3
```

Bucket nikdy nepřekročí 3 záznamy. Každé nové vložení nad kapacitu vytlačí nejstarší.

## Evikce a události

Každý evikovaný záznam emituje událost `bucket.<jméno>.deleted` — identickou s manuálním voláním `delete()`:

```typescript
const store = await Store.start();

await store.defineBucket('ring', {
  key: 'id',
  schema: {
    id:    { type: 'number', generated: 'autoincrement' },
    value: { type: 'string', required: true },
  },
  maxSize: 2,
});

const evicted: unknown[] = [];
await store.on('bucket.ring.deleted', (event) => {
  evicted.push(event.record);
});

await store.bucket('ring').insert({ value: 'a' });
await store.bucket('ring').insert({ value: 'b' });

// Toto vložení evikuje 'a'
await store.bucket('ring').insert({ value: 'c' });
await store.settle();

console.log(evicted.length); // 1
console.log((evicted[0] as Record<string, unknown>).value); // 'a'
```

Konzumenti událostí nemusí vědět, jestli bylo smazání manuální, řízené TTL nebo způsobené evikcí — všechny produkují stejný tvar události. Pokud potřebujete rozlišovat, zkontrolujte `record._expiresAt` pro TTL (přítomné na TTL bucketech) nebo sledujte zdroj ve vaší logice handleru událostí.

## Evikce a reaktivní dotazy

Reaktivní dotazy závislé na bucketu s omezením velikosti vidí aktualizace při každé evikci:

```typescript
const store = await Store.start();

await store.defineBucket('latest', {
  key: 'id',
  schema: {
    id:   { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
  maxSize: 2,
});

store.defineQuery('allLatest', async (ctx) => {
  return ctx.bucket('latest').all();
});

const snapshots: Array<Array<Record<string, unknown>>> = [];
await store.subscribe('allLatest', (result) => {
  snapshots.push(result);
});

await store.bucket('latest').insert({ name: 'Alice' });
await store.settle();
// snapshots[0]: [Alice]

await store.bucket('latest').insert({ name: 'Bob' });
await store.settle();
// snapshots[1]: [Alice, Bob]

await store.bucket('latest').insert({ name: 'Carol' });
await store.settle();
// snapshots[2]: [Bob, Carol] — Alice evikována, Carol přidána

const names = snapshots[2].map((r) => r.name);
console.log(names); // ['Bob', 'Carol']
```

Reaktivní dotaz automaticky odráží evikci — konzumenti vždy vidí aktuální stav ohraničeného bucketu.

## Evikce a indexy

Evikované záznamy se odstraní ze všech sekundárních a unikátních indexů před přidáním nového záznamu. Konzistence indexů je zajištěna v rámci jedné GenServer zprávy:

```text
  insert(newRecord) — bucket na maxSize
      |
      v
  evictOldest():
      |
      +-- indexManager.removeRecord(oldKey, oldRecord)
      +-- table.delete(oldKey)
      +-- emitovat událost deleted
      |
      v
  indexManager.addRecord(newKey, newRecord)
  table.set(newKey, newRecord)
  emitovat událost inserted
```

To znamená, že dotazy používající indexovaná pole vždy vracejí správné výsledky, i když evikce a vložení probíhají ve stejné operaci:

```typescript
const store = await Store.start();

await store.defineBucket('taggedItems', {
  key: 'id',
  schema: {
    id:  { type: 'number', generated: 'autoincrement' },
    tag: { type: 'string', required: true },
  },
  indexes: ['tag'],
  maxSize: 3,
});

const items = store.bucket('taggedItems');

await items.insert({ tag: 'urgent' });   // id: 1
await items.insert({ tag: 'normal' });   // id: 2
await items.insert({ tag: 'urgent' });   // id: 3

// Na kapacitě. Další vložení evikuje id:1 (tag: 'urgent'), pak přidá id:4.
await items.insert({ tag: 'low' });      // id: 4

const urgent = await items.where({ tag: 'urgent' });
console.log(urgent.length); // 1 (pouze id:3 — id:1 byl evikován a odstraněn z indexu)
```

## Kombinace maxSize a TTL

Bucket může mít jak `maxSize`, tak `ttl`. Fungují nezávisle — `maxSize` evikuje při vložení, když je bucket na kapacitě, a TTL promazává expirované záznamy podle plánu:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('sessionCache', {
  key: 'token',
  schema: {
    token:  { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '30m',   // Záznamy expirují po 30 minutách
  maxSize: 1000, // Nikdy více než 1000 záznamů v paměti
});
```

### Jak spolu interagují

```text
  Časová osa:
  ──────────────────────────────────────────────────────>

  t=0     vložení #1          velikost: 1
  t=1     vložení #2          velikost: 2
  ...
  t=999   vložení #1000       velikost: 1000 (na maxSize)
  t=1000  vložení #1001       evikuje #1 (nejstarší podle _createdAt), velikost: 1000
  ...
  t=1800  TTL promazání       odstraní všechny záznamy s _expiresAt <= now
                              (záznamy od t=0 do t=~800 expirovaly)
                              velikost: ~200
  t=1801  vložení #N          velikost: ~201 (hluboko pod maxSize, žádná evikce)
```

| Scénář | maxSize | TTL | Co se stane |
|--------|---------|-----|-------------|
| Nízký provoz, krátké TTL | 1000 | 5m | TTL provádí většinu čištění; maxSize se spouští zřídka |
| Vysoký provoz, dlouhé TTL | 100 | 24h | maxSize provádí většinu čištění; TTL zachytí zbytek |
| Nárazový provoz | 50 | 1h | maxSize omezuje paměť během nárazů; TTL čistí poté |

### Pořadí operací při vložení

```text
  insert(data)
      |
      v
  1. Validace a příprava záznamu (schéma, automatické generování)
      |
      v
  2. Nastavit _expiresAt pokud má bucket TTL a záznam ho nemá
      |
      v
  3. Pokud table.size >= maxSize: evikovat nejstarší záznamy
      |
      v
  4. Přidat do indexu, uložit do Map, emitovat událost inserted
```

TTL expirace se nastaví na záznamu **před** kontrolou maxSize. To znamená, že evikovaný záznam s TTL by byl nakonec promazán TtlManagerem — evikce ho jen odstraní dříve.

## Statistiky bucketu

Informace o velikosti jsou dostupné přes statistiky bucketu:

```typescript
const stats = await store.bucket('sessionCache').stats();

console.log(stats.hasMaxSize); // true
console.log(stats.maxSize);    // 1000
console.log(stats.recordCount); // aktuální počet záznamů
console.log(stats.hasTtl);     // true (pokud je TTL také nakonfigurované)
```

## Kompletní funkční příklad

Notifikační systém s ohraničenou schránkou — každý uživatel vidí jen svých posledních 50 notifikací:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start();

  await store.defineBucket('notifications', {
    key: 'id',
    schema: {
      id:      { type: 'number', generated: 'autoincrement' },
      userId:  { type: 'string', required: true },
      type:    { type: 'string', enum: ['info', 'warning', 'error'], required: true },
      message: { type: 'string', required: true },
      read:    { type: 'boolean', default: false },
    },
    indexes: ['userId', 'type'],
    maxSize: 50, // Globální strop: uchovat jen 50 nejnovějších notifikací
  });

  // Sledování evikcí pro audit
  let evictedCount = 0;
  await store.on('bucket.notifications.deleted', () => {
    evictedCount++;
  });

  // Reaktivní dotaz: počet nepřečtených
  store.defineQuery('unreadCount', async (ctx) => {
    const all = await ctx.bucket('notifications').where({ read: false });
    return all.length;
  });

  await store.subscribe('unreadCount', (count) => {
    console.log(`Nepřečtené notifikace: ${count}`);
  });

  const notif = store.bucket('notifications');

  // Simulace záplavy notifikací
  for (let i = 1; i <= 60; i++) {
    await notif.insert({
      userId: i <= 40 ? 'alice' : 'bob',
      type: i % 10 === 0 ? 'error' : 'info',
      message: `Notifikace #${i}`,
    });
  }

  await store.settle();

  // Zbývá jen 50 notifikací (prvních 10 bylo evikováno)
  console.log(`\nCelkem notifikací: ${await notif.count()}`); // 50
  console.log(`Evikováno: ${evictedCount}`); // 10

  // Nejstarších 10 (ID 1-10) bylo evikováno
  console.log(`ID 1 existuje: ${(await notif.get(1)) !== undefined}`);  // false
  console.log(`ID 11 existuje: ${(await notif.get(11)) !== undefined}`); // true
  console.log(`ID 60 existuje: ${(await notif.get(60)) !== undefined}`); // true

  // Indexované dotazy fungují správně po evikci
  const aliceNotifs = await notif.where({ userId: 'alice' });
  console.log(`Notifikace Alice: ${aliceNotifs.length}`); // 30 (40 vloženo - 10 evikováno)

  const errors = await notif.where({ type: 'error' });
  console.log(`Chybové notifikace: ${errors.length}`);

  // Agregace odrážejí ohraničený stav
  const total = await notif.count();
  const unread = (await notif.where({ read: false })).length;
  console.log(`${unread}/${total} nepřečtených`);

  await store.stop();
}

main();
```

## Cvičení

Vytváříte žebříčkový systém. Bucket `scores` sleduje nejlepší skóre hráčů, omezený na top 10. Bucket `recentGames` zaznamenává posledních 100 her s 24hodinovým TTL.

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('scores', {
  key: 'playerId',
  schema: {
    playerId: { type: 'string', required: true },
    score:    { type: 'number', required: true, min: 0 },
    game:     { type: 'string', required: true },
  },
  maxSize: 10,
});
```

1. Definujte bucket `recentGames` s poli `id` (number, autoincrement), `playerId` (string, povinný), `score` (number, povinný), `map` (string, povinný). Měl by mít `maxSize: 100` a `ttl: '24h'`. Indexujte podle `playerId`.
2. Vložte 12 skóre do bucketu `scores` pro různé hráče. Po všech vloženích, kolik záznamů existuje? Kteří 2 hráči byli evikováni?
3. Definujte reaktivní dotaz `topScores`, který vrací všechny záznamy z bucketu `scores`. Přihlaste se k odběru. Vložte jedno další skóre — spustí se odběr? Co obsahuje?
4. Vložte 5 her do `recentGames`. Ověřte, že všech 5 má nastavený `_expiresAt`. Co se stane, když zavoláte `purgeTtl()` okamžitě (před vypršením TTL)?

<details>
<summary>Řešení</summary>

1. Bucket `recentGames`:

```typescript
await store.defineBucket('recentGames', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    playerId: { type: 'string', required: true },
    score:    { type: 'number', required: true },
    map:      { type: 'string', required: true },
  },
  indexes: ['playerId'],
  maxSize: 100,
  ttl: '24h',
});
```

2. Vložení 12 skóre — zbude jen 10:

```typescript
const scores = store.bucket('scores');

const players = [
  { playerId: 'p1', score: 100, game: 'chess' },
  { playerId: 'p2', score: 250, game: 'chess' },
  { playerId: 'p3', score: 180, game: 'checkers' },
  { playerId: 'p4', score: 300, game: 'chess' },
  { playerId: 'p5', score: 90, game: 'checkers' },
  { playerId: 'p6', score: 420, game: 'chess' },
  { playerId: 'p7', score: 350, game: 'checkers' },
  { playerId: 'p8', score: 200, game: 'chess' },
  { playerId: 'p9', score: 275, game: 'checkers' },
  { playerId: 'p10', score: 310, game: 'chess' },
  { playerId: 'p11', score: 500, game: 'chess' },
  { playerId: 'p12', score: 150, game: 'checkers' },
];

for (const p of players) {
  await scores.insert(p);
}

console.log(await scores.count()); // 10
// p1 (vložen první, _createdAt je nejstarší) a p2 (druhý nejstarší) byli evikováni.
// Evikce je podle pořadí _createdAt, NE podle hodnoty skóre.
console.log(await scores.get('p1'));  // undefined
console.log(await scores.get('p2'));  // undefined
console.log(await scores.get('p3'));  // { playerId: 'p3', score: 180, ... }
console.log(await scores.get('p12')); // { playerId: 'p12', score: 150, ... }
```

3. Reaktivní dotaz se aktualizuje při evikci:

```typescript
store.defineQuery('topScores', async (ctx) => {
  return ctx.bucket('scores').all();
});

const snapshots: unknown[][] = [];
await store.subscribe('topScores', (result) => {
  snapshots.push(result);
});
await store.settle();

console.log(snapshots.length); // 1
console.log(snapshots[0].length); // 10

// Vložení dalšího — evikuje p3 (nyní nejstarší)
await scores.insert({ playerId: 'p13', score: 600, game: 'chess' });
await store.settle();

console.log(snapshots.length); // 2
console.log(snapshots[1].length); // 10 (stále 10 — jeden evikován, jeden přidán)
const ids = snapshots[1].map((r: Record<string, unknown>) => r.playerId);
console.log(ids.includes('p3'));  // false — evikován
console.log(ids.includes('p13')); // true — přidán
```

4. Hry s TTL:

```typescript
const games = store.bucket('recentGames');

const g1 = await games.insert({ playerId: 'p1', score: 100, map: 'arena' });
const g2 = await games.insert({ playerId: 'p2', score: 250, map: 'forest' });
const g3 = await games.insert({ playerId: 'p1', score: 180, map: 'arena' });
const g4 = await games.insert({ playerId: 'p3', score: 300, map: 'desert' });
const g5 = await games.insert({ playerId: 'p2', score: 90, map: 'forest' });

// Všechny mají nastavený _expiresAt (24 hodin od _createdAt)
console.log(g1._expiresAt); // _createdAt + 86_400_000
console.log(g2._expiresAt); // _createdAt + 86_400_000
console.log(g3._expiresAt); // _createdAt + 86_400_000
console.log(g4._expiresAt); // _createdAt + 86_400_000
console.log(g5._expiresAt); // _createdAt + 86_400_000

// Okamžité promazání — nic neexpiruje, protože _expiresAt je 24 hodin daleko
const purged = await store.purgeTtl();
console.log(purged); // 0
console.log(await games.count()); // 5 — všechny záznamy stále přítomny
```

</details>

## Shrnutí

- **`maxSize`** nastavuje per-bucket strop na počet záznamů — bucket nikdy nepřekročí tento počet
- **Pořadí evikce** je podle `_createdAt` vzestupně — nejstarší záznamy se odstraní jako první, aby uvolnily místo pro nové vložení
- Počet evikcí je `table.size - maxSize + 1` — přesně tolik místa pro nový záznam
- Evikce je **atomická** v rámci jedné GenServer zprávy — žádné souběžné mutace se nemohou prokládat mezi evikcí a vložením
- Evikované záznamy se **odstraní ze všech indexů** (sekundárních i unikátních) před přidáním nového záznamu
- Každý evikovaný záznam emituje standardní událost **`bucket.<jméno>.deleted`** — nerozlišitelnou od manuálního smazání
- **Reaktivní dotazy** závislé na bucketech s omezením velikosti se automaticky přehodnotí při evikci
- **`maxSize` a `ttl` jsou nezávislé**: maxSize evikuje při vložení, když je bucket na kapacitě, TTL promazává podle plánu, když záznamy expirují — vzájemně se doplňují pro dvojitě ohraničené buckety
- Při vložení je pořadí: validace, nastavení `_expiresAt` (pokud TTL), evikce (pokud na maxSize), uložení a indexace
- **Statistiky bucketu** vystavují `hasMaxSize`, `maxSize` a `recordCount` pro monitoring

---

Další: [Strom supervize](../10-architektura/01-strom-supervize.md)
