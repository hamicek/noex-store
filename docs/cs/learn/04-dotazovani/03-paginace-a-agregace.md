# Paginace a agregace

Zavolání `all()` na bucketu s 50 000 záznamy načte každý jeden do paměti najednou. To je plýtvání, když potřebujete jen 20 záznamů pro UI tabulku. A někdy záznamy vůbec nepotřebujete — potřebujete celkový součet, průměr nebo maximální hodnotu.

noex-store poskytuje kurzorovou paginaci pro efektivní procházení a agregační funkce pro výpočet souhrnů přímo uvnitř bucketu, bez vytahování záznamů do aplikačního kódu.

## Co se naučíte

- Jak funguje kurzorová paginace s `paginate()`
- Jak procházet celý bucket stránku po stránce
- Jak `sum()`, `avg()`, `min()` a `max()` počítají agregáty
- Jak kombinovat agregaci s filtry
- Jak agregace zpracovávají ne-numerické hodnoty a prázdné buckety

## Příprava

Všechny příklady používají následující bucket:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'pagination-demo' });

await store.defineBucket('products', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    name:     { type: 'string', required: true },
    category: { type: 'string', required: true, enum: ['electronics', 'clothing', 'food'] },
    price:    { type: 'number', required: true, min: 0 },
    rating:   { type: 'number', min: 1, max: 5 },
    sold:     { type: 'number', default: 0 },
  },
  indexes: ['category'],
});

const products = store.bucket('products');

// Vložení dat
await products.insert({ name: 'Laptop', category: 'electronics', price: 1200, rating: 5, sold: 340 });
await products.insert({ name: 'Mouse', category: 'electronics', price: 25, rating: 4, sold: 1500 });
await products.insert({ name: 'T-Shirt', category: 'clothing', price: 20, rating: 3, sold: 800 });
await products.insert({ name: 'Jacket', category: 'clothing', price: 90, rating: 4, sold: 250 });
await products.insert({ name: 'Coffee', category: 'food', price: 12, rating: 5, sold: 3000 });
await products.insert({ name: 'Rice', category: 'food', price: 5, rating: 3, sold: 2100 });
await products.insert({ name: 'Headphones', category: 'electronics', price: 150, rating: 4, sold: 600 });
await products.insert({ name: 'Sneakers', category: 'clothing', price: 110, rating: 5, sold: 420 });
```

## Kurzorová paginace

`paginate(options)` načte stránku záznamů pomocí kurzoru (primární klíč posledního záznamu z předchozí stránky):

```typescript
// První stránka — bez kurzoru
const page1 = await products.paginate({ limit: 3 });

console.log(page1.records.map((p) => `#${p.id} ${p.name}`));
// ['#1 Laptop', '#2 Mouse', '#3 T-Shirt']
console.log(page1.hasMore);    // true
console.log(page1.nextCursor); // 3 (primární klíč posledního záznamu)
```

### Rozhraní `PaginateOptions`

```typescript
interface PaginateOptions {
  readonly after?: unknown;  // Primární klíč, od kterého začít (vynechejte pro první stránku)
  readonly limit: number;    // Maximální počet záznamů na stránku
}
```

### Rozhraní `PaginatedResult`

```typescript
interface PaginatedResult {
  readonly records: StoreRecord[];          // Záznamy pro tuto stránku
  readonly hasMore: boolean;                // true pokud existují další záznamy za touto stránkou
  readonly nextCursor: unknown | undefined; // Primární klíč posledního záznamu (použijte jako 'after' pro další stránku)
}
```

### Procházení stránku po stránce

Použijte `nextCursor` jako hodnotu `after` pro další stránku:

```typescript
// Stránka 1
const page1 = await products.paginate({ limit: 3 });
console.log(page1.records.map((p) => p.name));
// ['Laptop', 'Mouse', 'T-Shirt']
console.log(page1.hasMore); // true

// Stránka 2 — použij nextCursor ze stránky 1
const page2 = await products.paginate({ after: page1.nextCursor, limit: 3 });
console.log(page2.records.map((p) => p.name));
// ['Jacket', 'Coffee', 'Rice']
console.log(page2.hasMore); // true

// Stránka 3 — použij nextCursor ze stránky 2
const page3 = await products.paginate({ after: page2.nextCursor, limit: 3 });
console.log(page3.records.map((p) => p.name));
// ['Headphones', 'Sneakers']
console.log(page3.hasMore); // false (poslední stránka — jen 2 záznamy)
console.log(page3.nextCursor); // 8
```

### Jak kurzorová paginace funguje

```text
  paginate({ after: 3, limit: 3 })
      |
      v
  +---------------------------------------------------------------+
  | 1. Získej všechny klíče v pořadí:                               |
  |    [1, 2, 3, 4, 5, 6, 7, 8]                                   |
  |                                                                 |
  | 2. Najdi pozici kurzoru:                                        |
  |    after = 3  ->  index klíče 3 je 2  ->  začni na indexu 3   |
  |                                                                 |
  | 3. Vyřízni [startIdx, startIdx + limit]:                        |
  |    keys[3..6] = [4, 5, 6]                                      |
  |                                                                 |
  | 4. Načti záznamy pro klíče [4, 5, 6]:                           |
  |    [Jacket, Coffee, Rice]                                       |
  |                                                                 |
  | 5. hasMore = startIdx + limit < celkem klíčů                    |
  |    3 + 3 = 6 < 8 = true                                        |
  |                                                                 |
  | 6. nextCursor = primární klíč posledního záznamu = 6            |
  +---------------------------------------------------------------+
```

### Řazení

Pořadí paginace závisí na `etsType` bucketu:

| `etsType` | Pořadí |
|---|---|
| `'set'` (výchozí) | Pořadí vložení |
| `'ordered_set'` | Klíče seřazené numericky / lexikograficky |

Pro numerické autoincrement klíče jsou pořadí vložení i seřazené pořadí identické.

### Okrajové případy

```typescript
// První stránka: vynechejte 'after'
const first = await products.paginate({ limit: 2 });
console.log(first.records.length); // 2

// Za koncem: vrátí prázdno
const pastEnd = await products.paginate({ after: 999, limit: 10 });
console.log(pastEnd.records.length); // 0
console.log(pastEnd.hasMore);        // false
console.log(pastEnd.nextCursor);     // undefined

// Limit větší než celkem: vrátí všechny záznamy
const all = await products.paginate({ limit: 100 });
console.log(all.records.length); // 8
console.log(all.hasMore);       // false
```

### Procházení celého bucketu

Pomocný vzor pro zpracování všech záznamů stránku po stránce:

```typescript
let cursor: unknown | undefined;
let pageNum = 0;

do {
  const page = await products.paginate({ after: cursor, limit: 3 });
  pageNum++;
  console.log(`Stránka ${pageNum}: ${page.records.map((p) => p.name).join(', ')}`);
  cursor = page.nextCursor;

  if (!page.hasMore) break;
} while (true);

// Stránka 1: Laptop, Mouse, T-Shirt
// Stránka 2: Jacket, Coffee, Rice
// Stránka 3: Headphones, Sneakers
```

## Agregační funkce

Agregační funkce počítají jednu hodnotu z numerického pole napříč odpovídajícími záznamy. Všechny čtyři funkce přijímají volitelný filtr pro zúžení vstupní sady.

### `sum()` — Součet numerických hodnot

```typescript
// Celkem prodáno
const totalSold = await products.sum('sold');
console.log(totalSold); // 9010

// Součet s filtrem
const electronicsSold = await products.sum('sold', { category: 'electronics' });
console.log(electronicsSold); // 2440 (340 + 1500 + 600)
```

### `avg()` — Průměr numerických hodnot

```typescript
// Průměrná cena napříč všemi produkty
const avgPrice = await products.avg('price');
console.log(avgPrice); // 201.5 ((1200+25+20+90+12+5+150+110) / 8)

// Průměrné hodnocení jídla
const avgFoodRating = await products.avg('rating', { category: 'food' });
console.log(avgFoodRating); // 4 ((5 + 3) / 2)
```

### `min()` — Minimální numerická hodnota

```typescript
// Nejlevnější produkt
const cheapest = await products.min('price');
console.log(cheapest); // 5

// Nejlevnější elektronika
const cheapestElectronics = await products.min('price', { category: 'electronics' });
console.log(cheapestElectronics); // 25
```

### `max()` — Maximální numerická hodnota

```typescript
// Nejdražší produkt
const mostExpensive = await products.max('price');
console.log(mostExpensive); // 1200

// Nejvyšší hodnocení oblečení
const bestClothing = await products.max('rating', { category: 'clothing' });
console.log(bestClothing); // 5
```

### Signatury agregací

| Metoda | Signatura | Vrací |
|---|---|---|
| `sum(field, filter?)` | `(string, Record?) => Promise<number>` | Součet numerických hodnot, `0` pokud prázdné |
| `avg(field, filter?)` | `(string, Record?) => Promise<number>` | Průměr numerických hodnot, `0` pokud prázdné |
| `min(field, filter?)` | `(string, Record?) => Promise<number \| undefined>` | Minimální hodnota, `undefined` pokud prázdné |
| `max(field, filter?)` | `(string, Record?) => Promise<number \| undefined>` | Maximální hodnota, `undefined` pokud prázdné |

### Jak agregace fungují

```text
  sum('price', { category: 'electronics' })
      |
      v
  +---------------------------------------------------------------+
  | 1. Získej odpovídající záznamy:                                 |
  |    Filtr { category: 'electronics' } -> vyhledání v indexu     |
  |    -> [Laptop(1200), Mouse(25), Headphones(150)]               |
  |                                                                 |
  | 2. Iteruj a akumuluj:                                           |
  |    sum = 0                                                      |
  |    Laptop:     price = 1200 (číslo) -> sum = 1200              |
  |    Mouse:      price = 25   (číslo) -> sum = 1225              |
  |    Headphones: price = 150  (číslo) -> sum = 1375              |
  |                                                                 |
  | 3. Vrať 1375                                                    |
  +---------------------------------------------------------------+
```

### Ne-numerické hodnoty

Agregační funkce tiše přeskakují ne-numerické hodnoty. Nevyhazují výjimku:

```typescript
await store.defineBucket('mixed', {
  key: 'id',
  schema: {
    id:    { type: 'number', generated: 'autoincrement' },
    value: { type: 'string' }, // Není číslo!
  },
});

const mixed = store.bucket('mixed');
await mixed.insert({ value: 'hello' });
await mixed.insert({ value: 'world' });

// Řetězcové pole — všechny hodnoty přeskočeny
const total = await mixed.sum('value');
console.log(total); // 0

const average = await mixed.avg('value');
console.log(average); // 0

const minimum = await mixed.min('value');
console.log(minimum); // undefined

const maximum = await mixed.max('value');
console.log(maximum); // undefined

await store.stop();
```

### Chování při prázdném bucketu

| Funkce | Prázdný bucket | Žádné shody po filtru |
|---|---|---|
| `sum()` | `0` | `0` |
| `avg()` | `0` | `0` |
| `min()` | `undefined` | `undefined` |
| `max()` | `undefined` | `undefined` |

Tento rozdíl je důležitý: `sum` a `avg` vrací `0` (číslo, které lze použít v aritmetice), zatímco `min` a `max` vrací `undefined` (neexistuje smysluplné minimum prázdné množiny).

## Kompletní funkční příklad

Prodejní dashboard, který kombinuje paginaci a agregaci:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'dashboard' });

  await store.defineBucket('sales', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      product:  { type: 'string', required: true },
      region:   { type: 'string', required: true, enum: ['us', 'eu', 'asia'] },
      amount:   { type: 'number', required: true, min: 0 },
      units:    { type: 'number', required: true, min: 1 },
    },
    indexes: ['region'],
  });

  const sales = store.bucket('sales');

  // Vložení 10 prodejních záznamů
  await sales.insert({ product: 'Widget A', region: 'us', amount: 500, units: 10 });
  await sales.insert({ product: 'Widget B', region: 'eu', amount: 750, units: 15 });
  await sales.insert({ product: 'Widget A', region: 'asia', amount: 300, units: 6 });
  await sales.insert({ product: 'Gadget X', region: 'us', amount: 1200, units: 4 });
  await sales.insert({ product: 'Widget A', region: 'eu', amount: 450, units: 9 });
  await sales.insert({ product: 'Gadget Y', region: 'asia', amount: 800, units: 8 });
  await sales.insert({ product: 'Widget B', region: 'us', amount: 600, units: 12 });
  await sales.insert({ product: 'Gadget X', region: 'eu', amount: 950, units: 3 });
  await sales.insert({ product: 'Widget A', region: 'us', amount: 400, units: 8 });
  await sales.insert({ product: 'Gadget Y', region: 'asia', amount: 1100, units: 11 });

  // --- KPI Dashboard ---
  console.log('=== Prodejní dashboard ===\n');

  // Celkový příjem
  const totalRevenue = await sales.sum('amount');
  console.log(`Celkový příjem: $${totalRevenue}`);
  // Celkový příjem: $7050

  // Průměrná hodnota objednávky
  const avgOrder = await sales.avg('amount');
  console.log(`Průměrná objednávka: $${avgOrder}`);
  // Průměrná objednávka: $705

  // Příjem podle regionu
  for (const region of ['us', 'eu', 'asia'] as const) {
    const regionRevenue = await sales.sum('amount', { region });
    const regionCount = await sales.count({ region });
    const regionAvg = await sales.avg('amount', { region });
    console.log(`  ${region.toUpperCase()}: $${regionRevenue} (${regionCount} objednávek, průměr $${regionAvg})`);
  }
  // US:   $2700 (3 objednávek, průměr $900)
  // EU:   $2150 (3 objednávek, průměr $716.67)
  // ASIA: $2200 (3 objednávek, průměr $733.33) -- zaokrouhleno

  // Největší a nejmenší objednávky
  const largest = await sales.max('amount');
  const smallest = await sales.min('amount');
  console.log(`\nNejvětší objednávka: $${largest}`);
  console.log(`Nejmenší objednávka: $${smallest}`);
  // Největší objednávka: $1200
  // Nejmenší objednávka: $300

  // Celkem prodaných kusů
  const totalUnits = await sales.sum('units');
  console.log(`Celkem prodaných kusů: ${totalUnits}`);
  // Celkem prodaných kusů: 86

  // --- Stránkovaný prodejní report ---
  console.log('\n=== Stránkovaný report ===\n');

  let cursor: unknown | undefined;
  let page = 0;

  do {
    const result = await sales.paginate({ after: cursor, limit: 4 });
    page++;
    console.log(`Stránka ${page}:`);
    for (const sale of result.records) {
      console.log(`  #${sale.id} ${sale.product} (${sale.region}) — $${sale.amount}`);
    }

    cursor = result.nextCursor;
    if (!result.hasMore) break;
  } while (true);

  await store.stop();
}

main();
```

## Cvičení

Mějte následující bucket s výsledky zkoušek:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('scores', {
  key: 'id',
  schema: {
    id:      { type: 'number', generated: 'autoincrement' },
    student: { type: 'string', required: true },
    subject: { type: 'string', required: true, enum: ['math', 'science', 'english'] },
    score:   { type: 'number', required: true, min: 0, max: 100 },
  },
  indexes: ['subject'],
});

const scores = store.bucket('scores');

await scores.insert({ student: 'Alice', subject: 'math', score: 92 });
await scores.insert({ student: 'Bob', subject: 'math', score: 78 });
await scores.insert({ student: 'Carol', subject: 'science', score: 88 });
await scores.insert({ student: 'Alice', subject: 'science', score: 95 });
await scores.insert({ student: 'Bob', subject: 'english', score: 82 });
await scores.insert({ student: 'Carol', subject: 'math', score: 90 });
await scores.insert({ student: 'Alice', subject: 'english', score: 87 });
await scores.insert({ student: 'Dave', subject: 'science', score: 73 });
```

Napište kód, který:

1. Spočítá průměrné skóre z matematiky
2. Najde nejvyšší skóre z přírodních věd
3. Najde nejnižší skóre napříč všemi předměty
4. Spočítá součet všech skóre
5. Projde stránkováním všechny záznamy s velikostí stránky 3 a vypíše každou stránku

<details>
<summary>Řešení</summary>

```typescript
// 1. Průměrné skóre z matematiky
const avgMath = await scores.avg('score', { subject: 'math' });
console.log(`Průměrné skóre z matematiky: ${avgMath}`);
// Průměrné skóre z matematiky: 86.67 ((92 + 78 + 90) / 3)

// 2. Nejvyšší skóre z přírodních věd
const maxScience = await scores.max('score', { subject: 'science' });
console.log(`Nejvyšší skóre z přírodních věd: ${maxScience}`);
// Nejvyšší skóre z přírodních věd: 95

// 3. Nejnižší skóre celkově
const minScore = await scores.min('score');
console.log(`Nejnižší skóre: ${minScore}`);
// Nejnižší skóre: 73

// 4. Součet všech skóre
const totalScores = await scores.sum('score');
console.log(`Součet všech skóre: ${totalScores}`);
// Součet všech skóre: 685

// 5. Stránkování přes všechny záznamy
let cursor: unknown | undefined;
let page = 0;

do {
  const result = await scores.paginate({ after: cursor, limit: 3 });
  page++;
  console.log(`Stránka ${page}:`);
  for (const s of result.records) {
    console.log(`  ${s.student} - ${s.subject}: ${s.score}`);
  }

  cursor = result.nextCursor;
  if (!result.hasMore) break;
} while (true);

// Stránka 1:
//   Alice - math: 92
//   Bob - math: 78
//   Carol - science: 88
// Stránka 2:
//   Alice - science: 95
//   Bob - english: 82
//   Carol - math: 90
// Stránka 3:
//   Alice - english: 87
//   Dave - science: 73
```

</details>

## Shrnutí

- **`paginate({ after?, limit })`** implementuje kurzorovou paginaci pomocí primárních klíčů
- Pro první stránku vynechejte `after`; pro další stránky použijte `nextCursor` z výsledku
- `hasMore` říká, zda za aktuální stránkou existují další záznamy
- Pořadí paginace odpovídá `etsType`: pořadí vložení pro `set`, seřazené klíče pro `ordered_set`
- **`sum(field, filter?)`** vrací součet numerických hodnot — `0` pro prázdné množiny
- **`avg(field, filter?)`** vrací aritmetický průměr — `0` pro prázdné množiny
- **`min(field, filter?)`** vrací nejmenší numerickou hodnotu — `undefined` pro prázdné množiny
- **`max(field, filter?)`** vrací největší numerickou hodnotu — `undefined` pro prázdné množiny
- Všechny agregační funkce přijímají volitelný filtr pro zúžení vstupu
- Ne-numerické hodnoty jsou tiše přeskakovány — agregace nikdy nevyhazují výjimku kvůli nesprávným typům
- Agregace s filtry těží ze sekundárních indexů stejně jako `where()`

---

Další: [Co jsou reaktivní dotazy?](../05-reaktivni-dotazy/01-co-jsou-reaktivni-dotazy.md)
