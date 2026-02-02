# Sekundární indexy

V předchozí kapitole jste filtrovali záznamy pomocí `where()`. V pozadí filtr bez indexu nutí store projít každý záznam v bucketu — porovnávat ho s filtrem, dokud nezkontroluje všechny. Pro bucket s 10 záznamy je to nepostřehnutelné. Pro bucket se 100 000 záznamy každý dotaz platí plnou cenu skenování.

Sekundární indexy toto řeší. Index mapuje hodnotu pole na množinu primárních klíčů, které danou hodnotu sdílejí. Místo skenování 100 000 záznamů pro nalezení objednávek se `status: 'pending'` store vyhledá `'pending'` v indexu a získá zpět jen odpovídající klíče — pak přímo načte tyto záznamy.

## Co se naučíte

- Jak deklarovat sekundární indexy na bucketu
- Rozdíl mezi ne-unikátními a unikátními indexy
- Jak `IndexManager` ukládá a udržuje data indexů
- Jak store zrychluje `where()` a `findOne()` pomocí indexů
- Výkonnostní rozdíl mezi plným skenem a indexovaným vyhledáváním
- Jak indexy interagují s hodnotami null/undefined a aktualizacemi

## Deklarace indexů

Indexy se deklarují v definici bucketu pomocí pole `indexes`:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'index-demo' });

await store.defineBucket('customers', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', required: true, unique: true },
    tier:  { type: 'string', enum: ['free', 'basic', 'premium'], default: 'free' },
    city:  { type: 'string' },
  },
  indexes: ['tier', 'city'],
});
```

Tím se vytvoří tři indexy:

| Pole | Typ indexu | Zdroj |
|---|---|---|
| `email` | Unikátní | `unique: true` ve schématu |
| `tier` | Ne-unikátní | Uvedeno v `indexes` |
| `city` | Ne-unikátní | Uvedeno v `indexes` |

Dva způsoby vytvoření indexu:

1. **`indexes: ['field']`** — vytvoří ne-unikátní index pro rychlejší vyhledávání
2. **`unique: true`** na poli schématu — vytvoří unikátní index, který zároveň vynucuje unikátnost

## Ne-unikátní indexy

Ne-unikátní index mapuje každou hodnotu pole na **množinu** primárních klíčů. Více záznamů může sdílet stejnou hodnotu:

```text
  Ne-unikátní index: tier
  +----------------------------------+
  | 'free'    -> { key1, key4, key7 }|
  | 'basic'   -> { key2, key5 }     |
  | 'premium' -> { key3, key6 }     |
  +----------------------------------+
```

```typescript
const customers = store.bucket('customers');

await customers.insert({ name: 'Alice', email: 'alice@a.com', tier: 'premium', city: 'Prague' });
await customers.insert({ name: 'Bob', email: 'bob@b.com', tier: 'free', city: 'Berlin' });
await customers.insert({ name: 'Carol', email: 'carol@c.com', tier: 'premium', city: 'Prague' });
await customers.insert({ name: 'Dave', email: 'dave@d.com', tier: 'free', city: 'London' });

// Zrychleno indexem: vyhledá 'premium' v indexu tier
const premium = await customers.where({ tier: 'premium' });
console.log(premium.length); // 2
console.log(premium.map((c) => c.name)); // ['Alice', 'Carol']

// Také zrychleno indexem: vyhledá 'Prague' v indexu city
const prague = await customers.where({ city: 'Prague' });
console.log(prague.length); // 2
```

## Unikátní indexy

Unikátní index mapuje každou hodnotu pole na přesně **jeden** primární klíč. Vynucuje, že žádné dva záznamy nesdílejí stejnou hodnotu:

```text
  Unikátní index: email
  +----------------------------------------+
  | 'alice@a.com' -> key1                  |
  | 'bob@b.com'   -> key2                  |
  | 'carol@c.com' -> key3                  |
  | 'dave@d.com'  -> key4                  |
  +----------------------------------------+
```

```typescript
// Unikátní index umožňuje rychlé přesné vyhledávání
const alice = await customers.findOne({ email: 'alice@a.com' });
console.log(alice?.name); // 'Alice'

// Pokus o duplicitní email vyhodí UniqueConstraintError
try {
  await customers.insert({ name: 'Fake Alice', email: 'alice@a.com', tier: 'free' });
} catch (err) {
  console.log(err.name); // 'UniqueConstraintError'
}
```

Unikátní indexy byly podrobně pokryty v kapitole [Unikátní omezení](../03-schema-validace/03-unikatni-omezeni.md). Tato kapitola se zaměřuje na jejich roli jako akcelerátorů dotazů.

## Jak funguje vyhledávání v indexu

Když `where()` obdrží filtr, store zkontroluje každé pole filtru oproti dostupným indexům. Pokud je nalezeno indexované pole, použije index k zúžení množiny kandidátů před aplikací zbylých filtrů:

```text
  where({ tier: 'premium', city: 'Prague' })
      |
      v
  +---------------------------------------------------------------+
  | Fáze 1: Vyhledání v indexu                                      |
  |                                                                 |
  |   tier je indexovaný?  -> ANO                                   |
  |   lookup('premium') -> { key1, key3 }                          |
  |   2 kandidáti (místo skenování všech 4 záznamů)                |
  |                                                                 |
  | Fáze 2: Aplikace zbylých filtrů                                 |
  |                                                                 |
  |   Zbylý filtr: { city: 'Prague' }                               |
  |   key1 (Alice): city === 'Prague'  -> SHODA                    |
  |   key3 (Carol): city === 'Prague'  -> SHODA                    |
  |                                                                 |
  |   Výsledek: [Alice, Carol]                                      |
  +---------------------------------------------------------------+
```

Dvoufázový přístup:

1. **Vyhledání v indexu** — jedno indexované pole zúží prohledávaný prostor
2. **Skenování zbytku** — neindexovaná pole filtru se kontrolují oproti kandidátům

Pokud filtr neobsahuje žádné indexované pole, store se uchýlí k plnému skenování tabulky:

```text
  where({ name: 'Alice' })
      |
      v
  +---------------------------------------------------------------+
  | Žádný index na 'name'                                           |
  | Plné skenování: kontrola každého záznamu oproti { name: 'Alice'}|
  +---------------------------------------------------------------+
```

## Výkon: Sken vs index

Výkonnostní rozdíl roste s velikostí bucketu:

```text
  Záznamy    Plné skenování   Indexované vyhledání
  -------    ---------------  ---------------------
       10    10 kontrol       1 vyhledání + ~k kontrol (k = shody)
      100    100 kontrol      1 vyhledání + ~k kontrol
    1 000    1 000 kontrol    1 vyhledání + ~k kontrol
   10 000    10 000 kontrol   1 vyhledání + ~k kontrol
  100 000    100 000 kontrol  1 vyhledání + ~k kontrol
```

| Scénář | Bez indexu | S indexem |
|---|---|---|
| `where({ status: 'pending' })` na 10 000 záznamech, 50 čekajících | Skenuje 10 000 | Vyhledá 50 klíčů |
| `findOne({ email: 'x@y.com' })` na 10 000 záznamech | Skenuje dokud nenajde (průměrně 5 000) | Přímé vyhledání: 1 krok |
| `count({ tier: 'vip' })` na 10 000 záznamech, 200 VIP | Skenuje 10 000 | Vyhledá 200 klíčů |

### Kdy přidat index

Přidejte index když:
- Pole je často používané ve filtrech `where()` nebo `findOne()`
- Bucket má mnoho záznamů a záleží na výkonu dotazů
- Pole má střední kardinalitu (mnoho různých hodnot v poměru k celkovému počtu záznamů)

Nepřidávejte index když:
- Bucket má velmi málo záznamů (< 100) — režie se nevyplatí
- Pole se dotazuje zřídka
- Pole má velmi nízkou kardinalitu (např. boolean se 2 hodnotami) a bucket je malý

Každý index přidává paměťovou režii a zpomaluje inserty/updaty/delety (index musí být aktualizován při každém zápisu). Kompromis se vyplatí, když čtení výrazně převažují nad zápisy pro dané pole.

## Údržba indexů

Indexy jsou automaticky udržovány při každé mutaci. Nikdy je nemusíte ručně přestavovat nebo obnovovat:

### Při insertu

```text
  insert({ name: 'Eve', email: 'eve@e.com', tier: 'basic', city: 'Paris' })
      |
      v
  +------------------------------------------------------+
  | 1. Validuj unikátní omezení (index email)             |
  |    'eve@e.com' není v unikátním indexu -> OK          |
  |                                                       |
  | 2. Přidej do všech indexů:                             |
  |    email: 'eve@e.com' -> key5                         |
  |    tier:  'basic'     -> { ..., key5 }                |
  |    city:  'Paris'     -> { key5 }                     |
  +------------------------------------------------------+
```

### Při updatu

Když se hodnota pole změní, index je aktualizován tak, aby odrážel novou hodnotu:

```typescript
// Eve přechází z 'basic' na 'premium'
await customers.update(eve.id, { tier: 'premium' });
```

```text
  update(key5, { tier: 'premium' })
      |
      v
  +------------------------------------------------------+
  | 1. Odeber key5 z tier['basic']                        |
  | 2. Validuj unikátní omezení (pokud je to relevantní)  |
  | 3. Přidej key5 do tier['premium']                     |
  |                                                       |
  | Nezměněná pole (city, email) se nemodifikují           |
  +------------------------------------------------------+
```

Aktualizaci indexů spouštějí pouze změněná pole. Pokud update nemodifikuje žádné indexované pole, indexy se nezmění.

### Při smazání

```text
  delete(key5)
      |
      v
  +------------------------------------------------------+
  | Odeber key5 ze všech indexů:                           |
  |   email: odeber 'eve@e.com' -> key5                   |
  |   tier:  odeber key5 z množiny 'premium'              |
  |   city:  odeber key5 z množiny 'Paris'                |
  +------------------------------------------------------+
```

## Hodnoty null a undefined

Pole s hodnotami `null` nebo `undefined` **nejsou indexována**. To má dva důsledky:

1. **Více záznamů může mít null/undefined v unikátním poli** — unikátnost je vynucována pouze mezi non-null hodnotami
2. **Vyhledání null/undefined nevrací žádné výsledky** z indexu

```typescript
await store.defineBucket('profiles', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true },
    nickname: { type: 'string', unique: true }, // Volitelné, ale unikátní když je přítomno
  },
});

const profiles = store.bucket('profiles');

// Oba mají undefined nickname — žádný unikátní konflikt
await profiles.insert({ name: 'Alice' });
await profiles.insert({ name: 'Bob' });

// Nickname je nastaven — nyní je indexován a vynucován
await profiles.insert({ name: 'Carol', nickname: 'caz' });

// Duplicitní nickname selže
try {
  await profiles.insert({ name: 'Dave', nickname: 'caz' });
} catch (err) {
  console.log(err.name); // 'UniqueConstraintError'
}
```

## Kompletní funkční příklad

E-commerce katalog produktů, který demonstruje dopad indexů na vzory dotazů:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'index-example' });

  await store.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:      { type: 'string', required: true, pattern: '^[A-Z]{2}-\\d{4}$' },
      name:     { type: 'string', required: true },
      category: { type: 'string', required: true, enum: ['electronics', 'clothing', 'food', 'books'] },
      brand:    { type: 'string', required: true },
      price:    { type: 'number', required: true, min: 0 },
      inStock:  { type: 'boolean', default: true },
    },
    indexes: ['category', 'brand', 'inStock'],
  });

  const products = store.bucket('products');

  // Vložení produktů
  await products.insert({ sku: 'EL-0001', name: 'Laptop Pro', category: 'electronics', brand: 'TechCo', price: 1299 });
  await products.insert({ sku: 'EL-0002', name: 'Wireless Mouse', category: 'electronics', brand: 'TechCo', price: 29 });
  await products.insert({ sku: 'CL-0001', name: 'Cotton T-Shirt', category: 'clothing', brand: 'WearIt', price: 19 });
  await products.insert({ sku: 'CL-0002', name: 'Denim Jacket', category: 'clothing', brand: 'WearIt', price: 89 });
  await products.insert({ sku: 'BK-0001', name: 'TypeScript Handbook', category: 'books', brand: 'DevPress', price: 45 });
  await products.insert({ sku: 'FD-0001', name: 'Organic Coffee', category: 'food', brand: 'BeanCo', price: 15, inStock: false });

  // Dotazy zrychlené indexem
  const electronics = await products.where({ category: 'electronics' });
  console.log(`Elektronika: ${electronics.map((p) => p.name).join(', ')}`);
  // Elektronika: Laptop Pro, Wireless Mouse

  const techCoElectronics = await products.where({ category: 'electronics', brand: 'TechCo' });
  console.log(`TechCo elektronika: ${techCoElectronics.length}`);
  // TechCo elektronika: 2

  const outOfStock = await products.where({ inStock: false });
  console.log(`Vyprodáno: ${outOfStock.map((p) => p.name).join(', ')}`);
  // Vyprodáno: Organic Coffee

  // findOne s indexem
  const firstBook = await products.findOne({ category: 'books' });
  console.log(`První kniha: ${firstBook?.name}`);
  // První kniha: TypeScript Handbook

  // Count s indexem
  const clothingCount = await products.count({ category: 'clothing' });
  console.log(`Oblečení: ${clothingCount}`);
  // Oblečení: 2

  // Update mění index
  await products.update('FD-0001', { inStock: true });
  const nowOutOfStock = await products.where({ inStock: false });
  console.log(`Vyprodáno po doplnění: ${nowOutOfStock.length}`);
  // Vyprodáno po doplnění: 0

  await store.stop();
}

main();
```

## Cvičení

Stavíte systém správy uživatelů. Navrhněte bucket s vhodnými indexy a poté napište dotazy, které z nich těží.

Požadavky:
1. Definujte bucket `users` s poli: `id` (uuid), `email` (unikátní), `role` (enum: admin/editor/viewer), `country` (string) a `active` (boolean, výchozí true)
2. Přidejte sekundární indexy na `role`, `country` a `active`
3. Vložte 5 uživatelů s různými rolemi, zeměmi a stavy aktivity
4. Napište dotazy pro:
   - Nalezení všech aktivních administrátorů (dvoupolový filtr s indexy)
   - Nalezení uživatele podle emailu (vyhledání přes unikátní index)
   - Počet uživatelů v konkrétní zemi
   - Zjištění, zda existuje neaktivní uživatel

<details>
<summary>Řešení</summary>

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'exercise' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:      { type: 'string', generated: 'uuid' },
      email:   { type: 'string', required: true, unique: true, format: 'email' },
      role:    { type: 'string', required: true, enum: ['admin', 'editor', 'viewer'] },
      country: { type: 'string', required: true },
      active:  { type: 'boolean', default: true },
    },
    indexes: ['role', 'country', 'active'],
  });

  const users = store.bucket('users');

  await users.insert({ email: 'alice@a.com', role: 'admin', country: 'CZ' });
  await users.insert({ email: 'bob@b.com', role: 'editor', country: 'DE' });
  await users.insert({ email: 'carol@c.com', role: 'admin', country: 'CZ', active: false });
  await users.insert({ email: 'dave@d.com', role: 'viewer', country: 'US' });
  await users.insert({ email: 'eve@e.com', role: 'admin', country: 'DE' });

  // Všichni aktivní administrátoři — použije index role, pak filtruje podle active
  const activeAdmins = await users.where({ role: 'admin', active: true });
  console.log(activeAdmins.map((u) => u.email));
  // ['alice@a.com', 'eve@e.com']

  // Nalezení podle emailu — unikátní index: přímé vyhledání
  const bob = await users.findOne({ email: 'bob@b.com' });
  console.log(bob?.role); // 'editor'

  // Počet uživatelů v CZ — použije index country
  const czCount = await users.count({ country: 'CZ' });
  console.log(czCount); // 2

  // Jakýkoliv neaktivní uživatel — použije index active
  const inactive = await users.findOne({ active: false });
  console.log(inactive?.email); // 'carol@c.com'

  await store.stop();
}

main();
```

</details>

## Shrnutí

- **`indexes: ['field']`** vytváří ne-unikátní sekundární index — mapuje hodnoty na množiny primárních klíčů
- **`unique: true`** na poli schématu vytváří unikátní index, který zároveň vynucuje unikátnost
- Indexy zrychlují `where()`, `findOne()` a `count()` zúžením kandidátů před skenováním
- Store používá **dvoufázový** přístup: vyhledání v indexu zúží množinu, pak se aplikují zbylé filtry
- Bez indexu každý dotaz skenuje všechny záznamy — O(n), kde n je velikost bucketu
- S indexem je vyhledání O(k), kde k je počet odpovídajících záznamů
- Indexy jsou automaticky udržovány při insertu, updatu a deletu — žádné ruční přestavby
- Aktualizaci indexů spouštějí pouze změněná pole při mutaci
- Hodnoty `null` a `undefined` nejsou indexovány — unikátní omezení jsou vynucována pouze mezi non-null hodnotami
- Indexy vyměňují výkon zápisu (cena aktualizace při každé mutaci) za výkon čtení (rychlé vyhledávání)

---

Další: [Paginace a agregace](./03-paginace-a-agregace.md)
