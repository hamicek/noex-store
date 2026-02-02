# Filtrování a vyhledávání

Umíte vkládat, číst, aktualizovat a mazat záznamy podle klíče. Ale aplikace jen zřídka potřebují najednou jen jeden záznam. Potřebujete odpovědi na otázky jako „které objednávky čekají na vyřízení?", „kolik uživatelů se dnes zaregistrovalo?" nebo „dej mi prvních pět úkolů." Ruční procházení všech záznamů a filtrování v aplikačním kódu je zdlouhavé, náchylné k chybám a rozptyluje logiku dotazů po celém kódu.

noex-store dává každému bucketu sadu dotazovacích metod, které zvládnou filtrování, počítání a řazené načítání v jediném volání. Všechny dotazy používají striktní rovnost s logikou AND — jednoduché na pochopení, snadné na skládání a rychlé díky sekundárním indexům.

## Co se naučíte

- Jak `where()` filtruje záznamy podle hodnot polí pomocí logiky AND
- Jak `findOne()` vrací jeden odpovídající záznam
- Jak `count()` vrací celkový nebo filtrovaný počet záznamů
- Jak `first()` a `last()` načítají záznamy od začátku nebo konce bucketu
- Jak se filtry skládají a co „striktní rovnost" znamená v praxi
- Kdy použít kterou dotazovací metodu a co očekávat v okrajových případech

## Příprava

Všechny příklady v této kapitole používají následující bucket:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'querying-demo' });

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    customer: { type: 'string', required: true },
    status:   { type: 'string', enum: ['pending', 'shipped', 'delivered', 'cancelled'], default: 'pending' },
    total:    { type: 'number', required: true, min: 0 },
    region:   { type: 'string', enum: ['us', 'eu', 'asia'] },
  },
  indexes: ['status', 'region'],
});

const orders = store.bucket('orders');
```

## `where()` — Filtrování podle hodnot polí

`where(filter)` vrací všechny záznamy, které odpovídají každému poli ve filtrovacím objektu. Porovnání používá striktní rovnost (`===`) a logiku AND — každá podmínka musí platit:

```typescript
await orders.insert({ customer: 'Alice', status: 'pending', total: 50, region: 'us' });
await orders.insert({ customer: 'Bob', status: 'shipped', total: 120, region: 'eu' });
await orders.insert({ customer: 'Carol', status: 'pending', total: 80, region: 'us' });
await orders.insert({ customer: 'Dave', status: 'delivered', total: 200, region: 'asia' });
await orders.insert({ customer: 'Eve', status: 'pending', total: 30, region: 'eu' });

// Filtr jednoho pole
const pending = await orders.where({ status: 'pending' });
console.log(pending.length); // 3

// Filtr více polí (logika AND)
const pendingUs = await orders.where({ status: 'pending', region: 'us' });
console.log(pendingUs.length); // 2
console.log(pendingUs.map((o) => o.customer)); // ['Alice', 'Carol']
```

### Jak filtrování funguje

```text
  where({ status: 'pending', region: 'us' })
      |
      v
  +-----------------------------------------------------------------+
  | Pro každý záznam v bucketu:                                      |
  |                                                                  |
  |   record.status === 'pending'  AND  record.region === 'us'      |
  |                                                                  |
  |   Alice:  'pending' === 'pending' AND 'us' === 'us'   -> SHODA  |
  |   Bob:    'shipped' === 'pending'                      -> PŘESKOČIT |
  |   Carol:  'pending' === 'pending' AND 'us' === 'us'   -> SHODA  |
  |   Dave:   'delivered' === 'pending'                    -> PŘESKOČIT |
  |   Eve:    'pending' === 'pending' AND 'eu' === 'us'   -> PŘESKOČIT |
  +-----------------------------------------------------------------+
```

### Okrajové případy

```typescript
// Prázdný filtr vrací všechny záznamy
const all = await orders.where({});
console.log(all.length); // 5

// Žádná shoda vrací prázdné pole (ne chybu)
const none = await orders.where({ status: 'cancelled' });
console.log(none.length); // 0

// Filtrovat lze podle libovolného pole — nejen indexovaných
const alice = await orders.where({ customer: 'Alice' });
console.log(alice.length); // 1
```

### Striktní rovnost

Filtry používají porovnání `===`. To znamená:

| Výraz | Výsledek | Proč |
|---|---|---|
| `'pending' === 'pending'` | Shoda | Stejný řetězec |
| `100 === 100` | Shoda | Stejné číslo |
| `100 === '100'` | Neshoda | Různé typy |
| `null === undefined` | Neshoda | Striktní rovnost je rozlišuje |
| `true === 1` | Neshoda | Různé typy |

Neexistují žádné rozsahové operátory (`>`, `<`), žádné porovnání regexem a žádná logika OR ve filtrech. Pro tyto případy načtěte širší sadu pomocí `where()` nebo `all()` a filtrujte v aplikačním kódu.

## `findOne()` — Načtení jednoho záznamu

`findOne(filter)` funguje jako `where()`, ale vrací první odpovídající záznam místo pole. Vrací `undefined`, pokud nic neodpovídá:

```typescript
// Najdi jednu čekající objednávku
const pending = await orders.findOne({ status: 'pending' });
console.log(pending?.customer); // 'Alice'

// Žádná shoda vrací undefined
const cancelled = await orders.findOne({ status: 'cancelled' });
console.log(cancelled); // undefined
```

Použijte `findOne()`, když očekáváte nula nebo jeden výsledek, nebo když vás zajímá jen první shoda. Interně se předčasně ukončí — jakmile je nalezena shoda, skenování se zastaví.

### `findOne()` vs `where()` vs `get()`

| Metoda | Vrací | Kdy použít |
|---|---|---|
| `get(key)` | Záznam nebo `undefined` | Znáte primární klíč |
| `findOne(filter)` | Záznam nebo `undefined` | Potřebujete jeden záznam podle hodnot polí |
| `where(filter)` | `StoreRecord[]` | Potřebujete všechny odpovídající záznamy |

## `count()` — Počítání záznamů

`count(filter?)` vrací počet odpovídajících záznamů. Bez filtru spočítá vše:

```typescript
// Celkový počet záznamů
const total = await orders.count();
console.log(total); // 5

// Filtrovaný počet
const pendingCount = await orders.count({ status: 'pending' });
console.log(pendingCount); // 3

const euCount = await orders.count({ region: 'eu' });
console.log(euCount); // 2
```

`count()` je efektivnější než `where(filter).length`, když potřebujete jen číslo — vyhnete se budování celého pole výsledků.

## `first()` — Záznamy od začátku

`first(n)` vrací prvních `n` záznamů z bucketu, seřazených podle primárního klíče:

```typescript
const firstTwo = await orders.first(2);
console.log(firstTwo.length); // 2
console.log(firstTwo.map((o) => o.customer)); // První 2 zákazníci podle pořadí klíčů
```

### Řazení závisí na `etsType`

Pořadí záznamů v `first()` a `last()` závisí na nastavení `etsType` bucketu:

| `etsType` | Pořadí |
|---|---|
| `'ordered_set'` | Klíče seřazené numericky/lexikograficky (výchozí pro `ordered_set`) |
| `'set'` | Pořadí vložení (výchozí) |

```typescript
// S etsType: 'ordered_set' a numerickými klíči (1, 2, 3):
// first(2) vrací záznamy s klíči 1, 2

// S etsType: 'set' (výchozí):
// first(2) vrací první dva vložené záznamy
```

### Okrajové případy

```typescript
// Požadavek na více než existuje vrátí co je k dispozici
const allFive = await orders.first(100);
console.log(allFive.length); // 5 (existuje jen 5 záznamů)

// Prázdný bucket vrací prázdné pole
await orders.clear();
const empty = await orders.first(3);
console.log(empty.length); // 0
```

## `last()` — Záznamy od konce

`last(n)` vrací posledních `n` záznamů, ve stejném řazení jako `first()`:

```typescript
await orders.insert({ customer: 'Alice', total: 50, region: 'us' });
await orders.insert({ customer: 'Bob', total: 120, region: 'eu' });
await orders.insert({ customer: 'Carol', total: 80, region: 'us' });

const lastTwo = await orders.last(2);
console.log(lastTwo.length); // 2
console.log(lastTwo.map((o) => o.customer)); // Poslední 2 zákazníci podle pořadí klíčů
```

`last()` zrcadlí `first()` — stejná pravidla řazení, stejné chování okrajových případů pro překročené `n` a prázdné buckety.

## Jak dotazy procházejí Store

Každý dotaz prochází architekturou předávání zpráv GenServeru:

```text
  orders.where({ status: 'pending' })
      |
      v
  BucketHandle               BucketServer (GenServer)
  +-----------+   call()    +-----------------------------+
  | where()   | ----------> | handle_call('where', filter)|
  |           |             |                             |
  |           |             |  1. Zkontroluj indexy       |
  |           |             |     status je indexovaný?   |
  |           |             |     -> ANO: lookup('pending')|
  |           |             |     -> získej kandidátní klíče|
  |           |             |                             |
  |           |             |  2. Aplikuj zbylé filtry    |
  |           |             |     (v tomto případě žádné) |
  |           |             |                             |
  |           | <---------- |  3. Vrať odpovídající záznamy|
  +-----------+   reply     +-----------------------------+
```

Když má pole filtru sekundární index, store použije index k zúžení kandidátů před skenováním. To je podrobně pokryto v další kapitole.

## Kompletní funkční příklad

Systém zákaznické podpory, který dotazuje bucket ticketů různými způsoby:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'filtering-demo' });

  await store.defineBucket('tickets', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      title:    { type: 'string', required: true },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
      status:   { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open' },
      assignee: { type: 'string' },
    },
    indexes: ['priority', 'status', 'assignee'],
  });

  const tickets = store.bucket('tickets');

  // Vložení dat
  await tickets.insert({ title: 'Login page broken', priority: 'critical', assignee: 'alice' });
  await tickets.insert({ title: 'Typo in footer', priority: 'low', assignee: 'bob' });
  await tickets.insert({ title: 'API timeout', priority: 'high', status: 'in_progress', assignee: 'alice' });
  await tickets.insert({ title: 'Missing translations', priority: 'medium', assignee: 'carol' });
  await tickets.insert({ title: 'Dashboard crash', priority: 'critical', status: 'in_progress', assignee: 'bob' });
  await tickets.insert({ title: 'Slow search', priority: 'high', assignee: 'alice' });

  // 1. Všechny kritické tickety
  const critical = await tickets.where({ priority: 'critical' });
  console.log(`Kritické tickety: ${critical.length}`);
  // Kritické tickety: 2

  // 2. Aliciny otevřené tickety
  const aliceOpen = await tickets.where({ assignee: 'alice', status: 'open' });
  console.log(`Aliciny otevřené: ${aliceOpen.map((t) => t.title).join(', ')}`);
  // Aliciny otevřené: Login page broken, Slow search

  // 3. Jakýkoliv rozpracovaný ticket (první shoda)
  const inProgress = await tickets.findOne({ status: 'in_progress' });
  console.log(`Rozpracovaný: ${inProgress?.title}`);
  // Rozpracovaný: API timeout

  // 4. Počet otevřených ticketů
  const openCount = await tickets.count({ status: 'open' });
  console.log(`Otevřené tickety: ${openCount}`);
  // Otevřené tickety: 4

  // 5. Prvních 3 ticketů (podle autoincrement klíče)
  const firstThree = await tickets.first(3);
  console.log(`První 3: ${firstThree.map((t) => `#${t.id} ${t.title}`).join(', ')}`);
  // První 3: #1 Login page broken, #2 Typo in footer, #3 API timeout

  // 6. Poslední 2 tickety
  const lastTwo = await tickets.last(2);
  console.log(`Poslední 2: ${lastTwo.map((t) => `#${t.id} ${t.title}`).join(', ')}`);
  // Poslední 2: #5 Dashboard crash, #6 Slow search

  // 7. Celkový počet ticketů
  const totalCount = await tickets.count();
  console.log(`Celkem ticketů: ${totalCount}`);
  // Celkem ticketů: 6

  await store.stop();
}

main();
```

## Cvičení

Mějte následující bucket s daty zaměstnanců:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('employees', {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    name:       { type: 'string', required: true },
    department: { type: 'string', enum: ['engineering', 'design', 'marketing', 'sales'] },
    level:      { type: 'string', enum: ['junior', 'mid', 'senior', 'lead'] },
    active:     { type: 'boolean', default: true },
  },
  indexes: ['department', 'level'],
});

const employees = store.bucket('employees');

await employees.insert({ name: 'Alice', department: 'engineering', level: 'senior' });
await employees.insert({ name: 'Bob', department: 'engineering', level: 'junior' });
await employees.insert({ name: 'Carol', department: 'design', level: 'lead' });
await employees.insert({ name: 'Dave', department: 'marketing', level: 'mid' });
await employees.insert({ name: 'Eve', department: 'engineering', level: 'senior' });
await employees.insert({ name: 'Frank', department: 'sales', level: 'junior', active: false });
```

Napište dotazy, které zodpoví:

1. Kolik zaměstnanců je v oddělení engineering?
2. Najděte všechny senior inženýry (filtr oddělení + úroveň).
3. Existuje nějaký neaktivní zaměstnanec? Použijte `findOne()`.
4. Získejte první 2 zaměstnance (podle autoincrement klíče).
5. Spočítejte celkový počet zaměstnanců.

<details>
<summary>Řešení</summary>

```typescript
// 1. Počet v oddělení engineering
const engCount = await employees.count({ department: 'engineering' });
console.log(engCount); // 3

// 2. Senior inženýři
const seniorEng = await employees.where({ department: 'engineering', level: 'senior' });
console.log(seniorEng.map((e) => e.name)); // ['Alice', 'Eve']

// 3. Jakýkoliv neaktivní zaměstnanec
const inactive = await employees.findOne({ active: false });
console.log(inactive?.name); // 'Frank'

// 4. První 2 zaměstnanci
const firstTwo = await employees.first(2);
console.log(firstTwo.map((e) => `#${e.id} ${e.name}`)); // ['#1 Alice', '#2 Bob']

// 5. Celkový počet
const total = await employees.count();
console.log(total); // 6
```

</details>

## Shrnutí

- **`where(filter)`** vrací všechny záznamy odpovídající každému poli ve filtru pomocí striktní rovnosti a logiky AND
- **`findOne(filter)`** vrací první shodu nebo `undefined` — použijte, když potřebujete nanejvýš jeden výsledek
- **`count(filter?)`** vrací počet odpovídajících záznamů — vynechejte filtr pro celkový počet
- **`first(n)`** a **`last(n)`** vrací záznamy od začátku nebo konce bucketu, seřazené podle primárního klíče
- Filtry používají porovnání `===` — žádné rozsahové operátory, žádné regexy, žádná logika OR
- Prázdný filtr `{}` odpovídá všem záznamům; žádná shoda vrací prázdné pole (nikdy nevyhazuje výjimku)
- Všechny dotazy procházejí architekturou GenServeru a těží z akcelerace indexy, když jsou k dispozici
- Řazení v `first()` / `last()` závisí na `etsType`: seřazené klíče pro `ordered_set`, pořadí vložení pro `set`

---

Další: [Sekundární indexy](./02-sekundarni-indexy.md)
