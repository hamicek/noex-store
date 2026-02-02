# CRUD operace

Máte Store a bucket se schématem. Teď je čas pracovat s daty. Každý bucket vystavuje stejnou sadu operací přes svůj `BucketHandle`: insert, get, update, delete, clear a all. Každá operace se validuje oproti schématu, automaticky se verzuje a publikuje událost. V této kapitole se naučíte každou operaci detailně, pochopíte metadata záznamů a uvidíte, jak validace a verzování fungují v praxi.

## Co se naučíte

- Jak vkládat záznamy a co Store dělá v pozadí
- Jak číst záznamy podle klíče a získat všechny záznamy v bucketu
- Jak aktualizovat záznamy a která pole jsou chráněna před změnami
- Jak mazat jednotlivé záznamy nebo vyčistit celý bucket
- Co znamenají metadata pole (`_version`, `_createdAt`, `_updatedAt`, `_expiresAt`) a jak se mění
- Jak se validační chyby projevují při zápisech

## Příprava

Všechny příklady v této kapitole používají následující definici bucketu:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'crud-demo' });

await store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    title:    { type: 'string', required: true, minLength: 1, maxLength: 200 },
    status:   { type: 'string', enum: ['todo', 'in_progress', 'done'], default: 'todo' },
    priority: { type: 'number', min: 1, max: 5, default: 3 },
    tags:     { type: 'array', default: [] },
  },
  indexes: ['status'],
});

const tasks = store.bucket('tasks');
```

## Insert

`insert(data)` vytváří nový záznam v bucketu:

```typescript
const task = await tasks.insert({
  title: 'Napsat dokumentaci',
});

console.log(task);
// {
//   id: 'f47ac10b-58cc-…',       ← vygenerované UUID
//   title: 'Napsat dokumentaci',
//   status: 'todo',               ← aplikovaná výchozí hodnota
//   priority: 3,                  ← aplikovaná výchozí hodnota
//   tags: [],                     ← aplikovaná výchozí hodnota
//   _version: 1,                  ← začíná na 1
//   _createdAt: 1706745600000,    ← Unix ms při vložení
//   _updatedAt: 1706745600000,    ← stejné jako _createdAt při insertu
// }
```

### Co se děje při insertu

```text
  insert(data)
      │
      ├── 1. Generování hodnot pro pole s `generated` (uuid, timestamp, …)
      ├── 2. Aplikování výchozích hodnot pro chybějící pole
      ├── 3. Připojení metadat: _version = 1, _createdAt = now, _updatedAt = now
      ├── 4. Validace kompletního záznamu oproti schématu
      │      ├── Kontroly typů
      │      ├── required, enum, min/max, minLength/maxLength, pattern, format
      │      └── Selhání → vyhodí ValidationError (záznam se NEULOŽÍ)
      ├── 5. Kontrola unikátních omezení
      │      └── Selhání → vyhodí UniqueConstraintError (záznam se NEULOŽÍ)
      ├── 6. Přidání do TTL sledování (pokud má bucket TTL → nastaví _expiresAt)
      ├── 7. Aktualizace indexů
      ├── 8. Uložení záznamu
      └── 9. Publikování události 'inserted'
```

### Insert vrací kompletní záznam

Vrácený objekt obsahuje všechny vygenerované hodnoty, aplikované výchozí hodnoty a metadata. Toto je záznam přesně tak, jak je uložen — není potřeba druhé čtení:

```typescript
const task = await tasks.insert({ title: 'Nasadit funkci' });

// Vygenerované UUID je okamžitě k dispozici
console.log(task.id);         // 'a1b2c3d4-…'
// Výchozí hodnoty jsou aplikovány
console.log(task.status);     // 'todo'
console.log(task.priority);   // 3
// Metadata jsou připojena
console.log(task._version);   // 1
```

### Validace insertu

Pokud data porušují schéma, insert selže a záznam se neuloží:

```typescript
// Chybějící povinné pole
try {
  await tasks.insert({});
} catch (err) {
  console.log(err.name); // 'ValidationError'
  console.log(err.issues);
  // [{ field: 'title', message: 'Field is required', code: 'required' }]
}

// Neplatný typ
try {
  await tasks.insert({ title: 123 });
} catch (err) {
  console.log(err.issues);
  // [{ field: 'title', message: 'Expected type "string", got number', code: 'type' }]
}

// Porušení omezení
try {
  await tasks.insert({ title: 'x', priority: 10 });
} catch (err) {
  console.log(err.issues);
  // [{ field: 'priority', message: 'Maximum value is 5', code: 'max' }]
}

// Více problémů najednou
try {
  await tasks.insert({ title: '', status: 'invalid', priority: 0 });
} catch (err) {
  console.log(err.issues.length); // 3
  // title: minLength, status: enum, priority: min
}
```

Validátor sesbírá všechny problémy před vyhozením výjimky — nezastaví se u prvního selhání.

## Get

`get(key)` získá jeden záznam podle jeho primárního klíče:

```typescript
const task = await tasks.insert({ title: 'Zkontrolovat PR' });

// Získání podle klíče
const found = await tasks.get(task.id);
console.log(found?.title); // 'Zkontrolovat PR'

// Neexistující klíč vrátí undefined
const missing = await tasks.get('neexistuje');
console.log(missing); // undefined
```

`get()` vrací kompletní záznam včetně metadat, nebo `undefined`, pokud záznam s daným klíčem neexistuje. Nikdy nevyhazuje výjimku pro chybějící klíč.

## Update

`update(key, changes)` modifikuje existující záznam:

```typescript
const task = await tasks.insert({ title: 'Nasadit aplikaci' });
console.log(task._version);   // 1
console.log(task.status);     // 'todo'

const updated = await tasks.update(task.id, {
  status: 'in_progress',
  priority: 5,
});

console.log(updated.status);     // 'in_progress'
console.log(updated.priority);   // 5
console.log(updated.title);      // 'Nasadit aplikaci' (nezměněno)
console.log(updated._version);   // 2 (zvýšena)
console.log(updated._updatedAt > task._updatedAt); // true
```

### Co se děje při updatu

```text
  update(key, changes)
      │
      ├── 1. Vyhledání existujícího záznamu podle klíče
      │      └── Nenalezen → vyhodí Error
      ├── 2. Odstranění chráněných polí ze změn:
      │      ├── Metadata: _version, _createdAt, _updatedAt
      │      ├── Pole primárního klíče
      │      └── Generovaná pole
      ├── 3. Sloučení existujícího záznamu se sanitizovanými změnami
      ├── 4. Zvýšení _version (+1) a nastavení _updatedAt na now
      ├── 5. Validace sloučeného záznamu oproti schématu
      │      └── Selhání → vyhodí ValidationError (záznam se NEAKTUALIZUJE)
      ├── 6. Kontrola unikátních omezení
      ├── 7. Aktualizace indexů
      ├── 8. Nahrazení uloženého záznamu
      └── 9. Publikování události 'updated' (s oldRecord i newRecord)
```

### Částečné aktualizace

Stačí odeslat pouze pole, která chcete změnit. Neuvedená pole si zachovají své stávající hodnoty:

```typescript
const task = await tasks.insert({ title: 'Opravit bug', priority: 4 });

// Aktualizace pouze statusu — title, priority, tags zůstávají stejné
const updated = await tasks.update(task.id, { status: 'done' });

console.log(updated.title);    // 'Opravit bug'
console.log(updated.priority); // 4
console.log(updated.status);   // 'done'
```

### Chráněná pole

Některá pole nelze měnit přes `update()`. Store je tiše odstraní z objektu změn:

| Chráněné pole | Důvod |
|--------------|-------|
| Primární klíč | Neměnný po vložení |
| Generovaná pole | Spravovány Store (uuid, autoincrement, timestamp) |
| `_version` | Spravováno Store (automaticky zvyšováno) |
| `_createdAt` | Neměnné — záznamy se vytváří jednou |
| `_updatedAt` | Spravováno Store (nastaveno na `Date.now()` při každém updatu) |

```typescript
const task = await tasks.insert({ title: 'Test' });

// Pokus o přepsání chráněných polí — tiše ignorováno
const updated = await tasks.update(task.id, {
  id: 'custom-id',     // Odstraněno — klíč je neměnný
  _version: 999,       // Odstraněno — spravováno Store
  _createdAt: 0,       // Odstraněno — neměnné
  title: 'Aktualizováno', // Aplikováno
});

console.log(updated.id);         // Původní UUID, ne 'custom-id'
console.log(updated._version);   // 2, ne 999
console.log(updated._createdAt); // Původní timestamp, ne 0
console.log(updated.title);      // 'Aktualizováno'
```

### Validace updatu

Sloučený záznam (existující + změny) se validuje oproti schématu. To znamená, že omezení se kontrolují na finálním stavu, ne jen na změnách:

```typescript
const task = await tasks.insert({ title: 'Platný úkol', priority: 3 });

// Toto selže, protože sloučený záznam má neplatný status
try {
  await tasks.update(task.id, { status: 'cancelled' });
} catch (err) {
  console.log(err.issues);
  // [{ field: 'status', message: 'Value must be one of: todo, in_progress, done', code: 'enum' }]
}

// Záznam je po neúspěšném updatu nezměněn
const unchanged = await tasks.get(task.id);
console.log(unchanged?.status); // 'todo' (stále původní hodnota)
```

### Update neexistujícího záznamu

Aktualizace klíče, který neexistuje, vyhodí chybu:

```typescript
try {
  await tasks.update('neexistujici-id', { title: 'Ne' });
} catch (err) {
  console.log(err.message); // Chyba o nenalezeném záznamu
}
```

## Delete

`delete(key)` odebere záznam podle jeho primárního klíče:

```typescript
const task = await tasks.insert({ title: 'Dočasný úkol' });
console.log(await tasks.get(task.id)); // { id: '…', title: 'Dočasný úkol', … }

await tasks.delete(task.id);
console.log(await tasks.get(task.id)); // undefined
```

Smazání neexistujícího klíče je no-op — nevyhazuje výjimku:

```typescript
// Bezpečné volání i když záznam neexistuje
await tasks.delete('uz-smazany');
// Žádná chyba
```

Po smazání Store publikuje událost `deleted` obsahující kompletní smazaný záznam.

## Clear

`clear()` odebere všechny záznamy z bucketu:

```typescript
await tasks.insert({ title: 'Úkol 1' });
await tasks.insert({ title: 'Úkol 2' });
await tasks.insert({ title: 'Úkol 3' });

console.log(await tasks.count()); // 3

await tasks.clear();

console.log(await tasks.count()); // 0
```

`clear()` odebere všechna data, ale definice bucketu, schéma a indexy zůstávají nedotčeny. Nové záznamy můžete vkládat ihned po vyčištění.

## All

`all()` získá každý záznam v bucketu:

```typescript
await tasks.insert({ title: 'Úkol A' });
await tasks.insert({ title: 'Úkol B' });
await tasks.insert({ title: 'Úkol C' });

const all = await tasks.all();
console.log(all.length); // 3
console.log(all.map((t) => t.title)); // ['Úkol A', 'Úkol B', 'Úkol C']
```

Každý záznam v poli obsahuje všechna pole a metadata. Pro velké buckety zvažte použití `paginate()` (probíráno v kapitole Dotazování).

## Metadata záznamů

Každý záznam ve Store nese čtyři metadata pole, spravovaná výhradně Store:

```text
  ┌───────────────────────────────────────────────────────────────┐
  │                        ZÁZNAM                                   │
  │                                                                │
  │   ┌──────────────────────────────────────────────────────┐    │
  │   │  Vaše data: id, title, status, priority, tags, …     │    │
  │   └──────────────────────────────────────────────────────┘    │
  │                                                                │
  │   ┌──────────────────────────────────────────────────────┐    │
  │   │  Metadata (spravováno Store)                          │    │
  │   │                                                       │    │
  │   │  _version    : 1 → 2 → 3 → …  (při každém updatu)   │    │
  │   │  _createdAt  : 1706745600000   (nastaveno jednou)     │    │
  │   │  _updatedAt  : 1706745600000   (reset při zápisu)     │    │
  │   │  _expiresAt? : 1706832000000   (pouze TTL buckety)    │    │
  │   └──────────────────────────────────────────────────────┘    │
  └───────────────────────────────────────────────────────────────┘
```

### `_version`

Celočíselný čítač, který začíná na `1` při insertu a zvyšuje se o `1` při každém updatu:

```typescript
const task = await tasks.insert({ title: 'Verzovaný úkol' });
console.log(task._version); // 1

const v2 = await tasks.update(task.id, { status: 'in_progress' });
console.log(v2._version); // 2

const v3 = await tasks.update(task.id, { status: 'done' });
console.log(v3._version); // 3
```

Pole version je základem optimistického zamykání v transakcích. Když transakce přečte záznam a později do něj zapíše, Store zkontroluje, že se `_version` od čtení nezměnila. Pokud ano, transakce selže s `TransactionConflictError`.

### `_createdAt`

Unix timestamp v milisekundách, nastavený jednou při vložení záznamu. Nikdy se nemění:

```typescript
const task = await tasks.insert({ title: 'Vytvořeno jednou' });
console.log(task._createdAt); // např. 1706745600000

const updated = await tasks.update(task.id, { title: 'Aktualizovaný titulek' });
console.log(updated._createdAt === task._createdAt); // true — nikdy se nemění
```

`_createdAt` se také používá pro pořadí evikce v `maxSize` bucketech — když je bucket plný, záznam s nejmenším `_createdAt` se odstraní jako první.

### `_updatedAt`

Unix timestamp v milisekundách, nastavený při insertu a aktualizovaný při každém následujícím zápisu:

```typescript
const task = await tasks.insert({ title: 'Sledování změn' });
console.log(task._updatedAt === task._createdAt); // true — stejné při insertu

// Krátké čekání pro odlišný timestamp
const updated = await tasks.update(task.id, { priority: 1 });
console.log(updated._updatedAt >= task._updatedAt); // true — aktualizováno
```

### `_expiresAt`

Přítomno pouze u záznamů v bucketech s TTL. Nastaveno automaticky na základě `_createdAt` + doba TTL bucketu:

```typescript
const store = await Store.start({ name: 'ttl-meta' });

await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token:  { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '1h', // 1 hodina
});

const sessions = store.bucket('sessions');
const session = await sessions.insert({ userId: 'alice' });

console.log(session._expiresAt);
// _createdAt + 3600000 (1 hodina v ms)
console.log(session._expiresAt! - session._createdAt); // 3600000

await store.stop();
```

TTL manager periodicky kontroluje `_expiresAt` oproti aktuálnímu času a odstraňuje expirované záznamy.

## Životní cyklus záznamu

Kompletní životní cyklus záznamu přes insert, více aktualizací a smazání:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'lifecycle-demo' });

  await store.defineBucket('tasks', {
    key: 'id',
    schema: {
      id:     { type: 'string', generated: 'uuid' },
      title:  { type: 'string', required: true },
      status: { type: 'string', enum: ['todo', 'in_progress', 'done'], default: 'todo' },
    },
  });

  const tasks = store.bucket('tasks');

  // 1. Insert — záznam se narodil
  const task = await tasks.insert({ title: 'Vydat v1.0' });
  console.log(`Vytvořen: v${task._version}, status=${task.status}`);
  // Vytvořen: v1, status=todo

  // 2. První update — verze se zvýší
  const v2 = await tasks.update(task.id, { status: 'in_progress' });
  console.log(`Aktualizován: v${v2._version}, status=${v2.status}`);
  // Aktualizován: v2, status=in_progress

  // 3. Druhý update — verze se zvýší znovu
  const v3 = await tasks.update(task.id, { status: 'done' });
  console.log(`Aktualizován: v${v3._version}, status=${v3.status}`);
  // Aktualizován: v3, status=done

  // 4. Čtení — vrátí nejnovější stav
  const current = await tasks.get(task.id);
  console.log(`Přečteno: v${current?._version}, status=${current?.status}`);
  // Přečteno: v3, status=done

  // 5. Smazání — záznam je pryč
  await tasks.delete(task.id);
  const deleted = await tasks.get(task.id);
  console.log(`Po smazání: ${deleted}`);
  // Po smazání: undefined

  await store.stop();
}

main();
```

## Kompletní příklad

Praktický příklad: správa katalogu produktů s validací, aktualizacemi a inspekcí metadat.

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'product-catalog' });

  await store.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:         { type: 'string', required: true, pattern: '^[A-Z]{2,4}-\\d{3,6}$' },
      name:        { type: 'string', required: true, minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      price:       { type: 'number', required: true, min: 0.01 },
      currency:    { type: 'string', enum: ['USD', 'EUR', 'GBP'], default: 'USD' },
      inStock:     { type: 'boolean', default: true },
      tags:        { type: 'array', default: [] },
    },
    indexes: ['currency', 'inStock'],
  });

  const products = store.bucket('products');

  // Vložení produktů
  const widget = await products.insert({
    sku: 'WDG-001',
    name: 'Standardní Widget',
    price: 9.99,
    tags: ['widget', 'standard'],
  });

  const gadget = await products.insert({
    sku: 'GDG-042',
    name: 'Premium Gadget',
    description: 'Prémiový gadget s pokročilými funkcemi',
    price: 49.99,
    currency: 'EUR',
    tags: ['gadget', 'premium'],
  });

  // Čtení
  const found = await products.get('WDG-001');
  console.log(`${found?.name}: ${found?.currency} ${found?.price}`);
  // Standardní Widget: USD 9.99

  // Aktualizace ceny
  const updated = await products.update('WDG-001', { price: 12.99 });
  console.log(`Nová cena: ${updated.price}, verze: ${updated._version}`);
  // Nová cena: 12.99, verze: 2

  // Označení jako vyprodáno
  const outOfStock = await products.update('GDG-042', { inStock: false });
  console.log(`Skladem: ${outOfStock.inStock}`);
  // Skladem: false

  // Výpis všech
  const all = await products.all();
  console.log(`Produkty: ${all.length}`);
  // Produkty: 2

  // Validace zachytí špatná data
  try {
    await products.insert({ sku: 'bad', name: 'Ouha', price: -5 });
  } catch (err) {
    for (const issue of err.issues) {
      console.log(`  ${issue.field}: ${issue.message} (${issue.code})`);
    }
    // sku: Value must match pattern "^[A-Z]{2,4}-\d{3,6}$" (pattern)
    // price: Minimum value is 0.01 (min)
  }

  // Smazání a ověření
  await products.delete('WDG-001');
  console.log(`Po smazání: ${await products.get('WDG-001')}`);
  // Po smazání: undefined

  // Vyčištění všeho
  await products.clear();
  console.log(`Po vyčištění: ${(await products.all()).length} produktů`);
  // Po vyčištění: 0 produktů

  await store.stop();
}

main();
```

## Cvičení

Dána tato definice bucketu:

```typescript
await store.defineBucket('employees', {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    name:       { type: 'string', required: true, minLength: 1 },
    department: { type: 'string', enum: ['engineering', 'design', 'marketing', 'sales'] },
    salary:     { type: 'number', required: true, min: 30000, max: 500000 },
    active:     { type: 'boolean', default: true },
  },
  indexes: ['department'],
});

const employees = store.bucket('employees');
```

Předpovězte výsledek každé operace:

```typescript
// 1. Co vrátí toto?
const emp = await employees.insert({ name: 'Alice', department: 'engineering', salary: 120000 });
console.log(emp.id, emp.active, emp._version);

// 2. Co vrátí toto?
const updated = await employees.update(emp.id, { salary: 135000, id: 999 });
console.log(updated.id, updated.salary, updated._version);

// 3. Vyhodí to výjimku? Pokud ano, jakou chybu?
await employees.insert({ name: 'Bob', salary: 25000 });

// 4. Vyhodí to výjimku? Pokud ano, jakou chybu?
await employees.update(emp.id, { department: 'hr' });

// 5. Co vrátí toto?
await employees.delete(emp.id);
const result = await employees.get(emp.id);
console.log(result);
```

<details>
<summary>Řešení</summary>

**1.** `1 true 1`
- `id` je `1`, protože `autoincrement` začíná na 1.
- `active` je `true`, protože se aplikuje výchozí hodnota.
- `_version` je `1`, protože je to nový záznam.

**2.** `1 135000 2`
- `id` je stále `1` — `id: 999` ve změnách je odstraněno, protože primární klíč je neměnný.
- `salary` je `135000` — aktualizace se aplikuje.
- `_version` je `2` — zvýšena při updatu.

**3.** Ano, `ValidationError` s `{ field: 'salary', code: 'min', message: 'Minimum value is 30000' }`.
Plat `25000` je pod minimem `30000`.

**4.** Ano, `ValidationError` s `{ field: 'department', code: 'enum', message: 'Value must be one of: engineering, design, marketing, sales' }`.
`'hr'` není v seznamu enum.

**5.** `undefined`
Záznam byl smazán, takže `get()` vrátí `undefined`.

</details>

## Shrnutí

- **`insert(data)`** vytváří záznam — generuje hodnoty, aplikuje výchozí hodnoty, validuje, ukládá a publikuje událost `inserted`
- **`get(key)`** získá záznam podle primárního klíče — vrátí `undefined`, pokud není nalezen
- **`update(key, changes)`** částečně aktualizuje záznam — odstraní chráněná pole, validuje sloučený výsledek, zvýší `_version`, publikuje událost `updated`
- **`delete(key)`** odebere záznam — tichá operace, pokud klíč neexistuje, publikuje událost `deleted`
- **`clear()`** odebere všechny záznamy — definice bucketu a schéma zůstávají nedotčeny
- **`all()`** vrátí každý záznam v bucketu včetně metadat
- Každý záznam nese automatická metadata: `_version` (optimistické zamykání), `_createdAt` (neměnný timestamp narození), `_updatedAt` (poslední modifikace) a volitelně `_expiresAt` (TTL)
- Validace sesbírá všechny problémy před vyhozením výjimky — záznam se při selhání nikdy neuloží
- Chráněná pole (klíč, generovaná, metadata) se tiše odstraní z payloadu updatu

---

Další: [Omezení polí](../03-schema-validace/01-omezeni-poli.md)
