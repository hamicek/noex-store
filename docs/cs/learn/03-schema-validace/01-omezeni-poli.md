# Omezení polí

Dosud jste ve svých schématech definovali typy polí, možná označili některá pole jako `required`, a šli dál. To funguje pro jednoduché případy. Ale reálná data mají pravidla: věk nemůže být záporný, role musí být jedna ze tří hodnot, email musí vypadat jako email. Bez omezení žije hranice mezi platnými a neplatnými daty v rozptýlených `if` příkazech, které někdo nakonec zapomene napsat.

noex-store přesouvá validaci do schématu. Omezení deklarujete jednou a každý insert i update jimi projde — bez výjimek, bez zapomenutých cest kódu.

## Co se naučíte

- Jak `required` zabraňuje chybějícím datům a co se počítá jako "chybějící"
- Jak `enum` omezuje pole na explicitní množinu povolených hodnot
- Jak `min`, `max`, `minLength`, `maxLength` vynucují numerické a řetězcové hranice
- Jak `pattern` aplikuje regulární výraz na řetězcová pole
- Jak `format` validuje běžné tvary řetězců jako email, URL a ISO datum
- Jak `ValidationError` nahlásí více problémů najednou se strukturovanými kódy chyb

## Omezení `required`

Ve výchozím stavu jsou pole ve schématu volitelná. Pokud hodnotu neposkytnete, pole je `undefined` v uloženém záznamu. Označte pole jako `required: true` pro odmítnutí insertů a updateů, kde pole chybí nebo je `null`:

```typescript
const store = await Store.start({ name: 'constraints' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    bio:  { type: 'string' }, // volitelné — undefined je v pořádku
  },
});

const users = store.bucket('users');

// Funguje — name je poskytnut, bio je volitelné
await users.insert({ name: 'Alice' });

// Selže — name chybí
try {
  await users.insert({});
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "users": name: Field is required
}
```

Co se počítá jako "chybějící" pro `required`:
- `undefined` — pole není v objektu vstupu
- `null` — pole je explicitně nastaveno na `null`

Prázdný řetězec `""` **není** chybějící — je to přítomná hodnota. Pokud potřebujete odmítat prázdné řetězce, kombinujte `required` s `minLength`:

```typescript
name: { type: 'string', required: true, minLength: 1 }
```

## Omezení `enum`

`enum` omezuje pole na pevnou množinu hodnot. Jakákoliv hodnota mimo pole je odmítnuta:

```typescript
await store.defineBucket('tickets', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    status:   { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open' },
  },
});

const tickets = store.bucket('tickets');

// Funguje — 'high' je v enum
await tickets.insert({ priority: 'high' });

// Selže — 'urgent' není v enum
try {
  await tickets.insert({ priority: 'urgent' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "tickets": priority: Value must be one of: low, medium, high, critical
}
```

`enum` funguje s jakýmkoliv typem pole, nejen s řetězci:

```typescript
severity: { type: 'number', enum: [1, 2, 3, 4, 5] }
```

## Numerická omezení: `min` a `max`

`min` a `max` definují inkluzivní hranice pro číselná pole:

```typescript
await store.defineBucket('products', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true },
    price:    { type: 'number', required: true, min: 0 },
    quantity: { type: 'number', required: true, min: 0, max: 10_000 },
    rating:   { type: 'number', min: 1, max: 5 },
  },
});

const products = store.bucket('products');

// Funguje — všechny hodnoty v rozsahu
await products.insert({ name: 'Widget', price: 9.99, quantity: 100, rating: 4 });

// Selže — záporná cena
try {
  await products.insert({ name: 'Free Widget', price: -1, quantity: 0 });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "products": price: Minimum value is 0
}
```

Obě hranice jsou inkluzivní: `min: 0` přijímá `0` a `max: 100` přijímá `100`.

## Omezení délky řetězce: `minLength` a `maxLength`

`minLength` a `maxLength` omezují `.length` řetězcových hodnot:

```typescript
await store.defineBucket('articles', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    title: { type: 'string', required: true, minLength: 3, maxLength: 200 },
    slug:  { type: 'string', required: true, minLength: 1, maxLength: 100 },
    body:  { type: 'string', required: true, minLength: 10 },
  },
});

const articles = store.bucket('articles');

// Selže — title je příliš krátký
try {
  await articles.insert({ title: 'Hi', slug: 'hi', body: 'This is the body text.' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "articles": title: Minimum length is 3
}
```

Běžný vzor: použijte `required: true` pro zabránění chybějícím hodnotám a `minLength: 1` pro zabránění prázdným řetězcům.

## Omezení `pattern`

`pattern` aplikuje JavaScriptový regulární výraz na řetězcová pole. Hodnota musí odpovídat vzoru, aby prošla validací:

```typescript
await store.defineBucket('airports', {
  key: 'code',
  schema: {
    code:    { type: 'string', required: true, pattern: '^[A-Z]{3}$' },
    name:    { type: 'string', required: true },
    country: { type: 'string', required: true, pattern: '^[A-Z]{2}$' },
  },
});

const airports = store.bucket('airports');

// Funguje — 'PRG' odpovídá ^[A-Z]{3}$
await airports.insert({ code: 'PRG', name: 'Vaclav Havel Airport Prague', country: 'CZ' });

// Selže — 'prg' neodpovídá (malá písmena)
try {
  await airports.insert({ code: 'prg', name: 'Test', country: 'CZ' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "airports": code: Value must match pattern "^[A-Z]{3}$"
}
```

Řetězec vzoru je kompilován pomocí `new RegExp(pattern)` při validaci. Použijte kotvy `^` a `$` pro shodu s celým řetězcem. Bez kotev projde i částečná shoda:

```typescript
// Bez kotev: 'abc123' projde, protože '123' odpovídá \d+
code: { type: 'string', pattern: '\\d+' }

// S kotvami: 'abc123' selže, protože celý řetězec nejsou čísla
code: { type: 'string', pattern: '^\\d+$' }
```

## Omezení `format`

`format` validuje běžné tvary řetězců bez nutnosti psát regex. Podporovány jsou tři formáty:

| Formát | Přijímá | Odmítá |
|--------|---------|--------|
| `'email'` | `user@example.com` | `not-an-email` |
| `'url'` | `https://example.com` | `not-a-url` |
| `'iso-date'` | `2024-01-15` | `2024-13-99` |

```typescript
await store.defineBucket('contacts', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    email:   { type: 'string', required: true, format: 'email' },
    website: { type: 'string', format: 'url' },
    birthday:{ type: 'string', format: 'iso-date' },
  },
});

const contacts = store.bucket('contacts');

// Funguje
await contacts.insert({
  email: 'alice@example.com',
  website: 'https://alice.dev',
  birthday: '1990-05-20',
});

// Selže — neplatný email
try {
  await contacts.insert({ email: 'alice' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "contacts": email: Invalid email format
}

// Selže — neplatný iso-date
try {
  await contacts.insert({ email: 'bob@example.com', birthday: '2024-13-99' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "contacts": birthday: Invalid iso-date format
}
```

Použijte `format` pro standardní tvary. Použijte `pattern`, když potřebujete vlastní regex.

## Kombinování omezení

Omezení se volně skládají. Validátor kontroluje všechna omezení pro každé pole a sesbírá všechna selhání:

```typescript
await store.defineBucket('employees', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true, minLength: 2, maxLength: 100 },
    email:    { type: 'string', required: true, format: 'email' },
    role:     { type: 'string', required: true, enum: ['engineer', 'designer', 'manager'] },
    level:    { type: 'number', required: true, min: 1, max: 10 },
    badge:    { type: 'string', required: true, pattern: '^EMP-\\d{4}$' },
  },
});
```

Toto schéma vynucuje:
- `name`: přítomný, 2-100 znaků
- `email`: přítomný, platný formát emailu
- `role`: přítomný, jedna ze tří povolených hodnot
- `level`: přítomný, celé číslo mezi 1 a 10
- `badge`: přítomný, formát `EMP-` následovaný přesně 4 číslicemi

## Jak validace funguje

```text
  insert / update
       │
       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Pro každé pole ve schématu:                                  │
  │                                                               │
  │  1. required?    ── chybí hodnota (undefined / null)?         │
  │     └─ ano → přidej problém { code: 'required' }, přeskoč   │
  │                                                               │
  │  2. absent?      ── hodnota je undefined / null ale ne required│
  │     └─ ano → přeskoč všechny zbývající kontroly tohoto pole  │
  │                                                               │
  │  3. typ shodný?  ── odpovídá typeof deklarovanému typu?       │
  │     └─ ne  → přidej problém { code: 'type' }, přeskoč       │
  │                                                               │
  │  4. omezení      ── kontroluj enum, min, max, minLength,      │
  │                     maxLength, pattern, format                 │
  │     └─ každé selhání → přidej problém s konkrétním kódem     │
  │                                                               │
  │  Po všech polích: issues.length > 0 → vyhoď ValidationError  │
  └─────────────────────────────────────────────────────────────┘
```

Dvě klíčové vlastnosti:

1. **Všechny problémy jsou sesbírány.** Validátor se nezastaví u prvního selhání. Pokud jsou tři pole neplatná, dostanete tři problémy v jedné chybě.
2. **Typ se kontroluje před omezeními.** Pokud má pole špatný typ (např. číslo místo řetězce), kontroly omezení jako `minLength` se pro dané pole přeskočí — neměly by smysl.

## `ValidationError` v detailu

`ValidationError` je strukturovaná chyba se strojově čitelným polem `issues`:

```typescript
import { ValidationError } from '@hamicek/noex-store';

try {
  await employees.insert({ name: 'A', level: -1 });
} catch (err) {
  if (err instanceof ValidationError) {
    console.log(err.name);    // 'ValidationError'
    console.log(err.message); // 'Validation failed for bucket "employees": name: Minimum length is 2; ...'

    for (const issue of err.issues) {
      console.log(`  ${issue.field}: [${issue.code}] ${issue.message}`);
    }
    // Výstup:
    //   email: [required] Field is required
    //   role: [required] Field is required
    //   badge: [required] Field is required
    //   name: [minLength] Minimum length is 2
    //   level: [min] Minimum value is 1
  }
}
```

### Tvar `ValidationIssue`

| Pole | Typ | Popis |
|------|-----|-------|
| `field` | `string` | Název pole ve schématu, které selhalo |
| `message` | `string` | Lidsky čitelný popis selhání |
| `code` | `string` | Strojově čitelný kód chyby pro programatické zpracování |

### Přehled kódů chyb

| Kód | Spouštěč | Příklad |
|-----|----------|---------|
| `'required'` | Chybějící nebo `null` hodnota u povinného pole | `name` je `undefined` |
| `'type'` | Hodnota neodpovídá deklarovanému typu | Očekáván `string`, přijat `number` |
| `'enum'` | Hodnota není v povolené množině | `'premium'` není v `['basic', 'vip']` |
| `'minLength'` | Řetězec kratší než minimum | `'A'` s `minLength: 2` |
| `'maxLength'` | Řetězec delší než maximum | `'ABCDE'` s `maxLength: 3` |
| `'min'` | Číslo pod minimem | `-1` s `min: 0` |
| `'max'` | Číslo nad maximem | `101` s `max: 100` |
| `'pattern'` | Řetězec neodpovídá regexu | `'ab1'` s `pattern: '^[A-Z]{3}$'` |
| `'format'` | Neplatný email, URL nebo ISO datum | `'not-an-email'` s `format: 'email'` |

## Validace při updatu

Omezení se uplatňují i při updatech. Store sloučí payload updatu s existujícím záznamem a validuje výsledek:

```typescript
const employees = store.bucket('employees');

const alice = await employees.insert({
  name: 'Alice Smith',
  email: 'alice@example.com',
  role: 'engineer',
  level: 5,
  badge: 'EMP-0042',
});

// Funguje — level zůstává v rozsahu
await employees.update(alice.id, { level: 8 });

// Selže — level mimo rozsah
try {
  await employees.update(alice.id, { level: 99 });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "employees": level: Maximum value is 10
}

// Selže — nelze změnit role na neplatnou enum hodnotu
try {
  await employees.update(alice.id, { role: 'intern' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "employees": role: Value must be one of: engineer, designer, manager
}
```

## Podporované typy polí

Každé pole musí deklarovat `type`. Zde je všech šest podporovaných typů a jaké hodnoty přijímají:

| Typ | Přijímá | Odmítá |
|-----|---------|--------|
| `'string'` | Jakýkoliv `typeof === 'string'` | `123`, `true`, `null` |
| `'number'` | Jakýkoliv `typeof === 'number'` kromě `NaN` | `'42'`, `NaN`, `Infinity` je povoleno |
| `'boolean'` | `true` nebo `false` | `'yes'`, `0`, `1` |
| `'object'` | Prosté objekty (`{}`) | Pole, `null`, primitivní typy |
| `'array'` | Pole (`[]`) | Prosté objekty, řetězce |
| `'date'` | Instance `Date` (platné), čísla (timestampy), řetězce | `boolean`, neplatné `Date` |

Pozoruhodné okrajové případy:
- **`NaN` je odmítnut** pro `'number'` — technicky je to číslo v JavaScriptu, ale sémanticky bezvýznamné jako uložená data
- **`null` není objekt** — `{ type: 'object' }` odmítá `null`, přestože `typeof null === 'object'` v JavaScriptu
- **Pole nejsou objekty** — `{ type: 'object' }` odmítá pole; místo toho použijte `{ type: 'array' }`
- **`'date'` je flexibilní** — přijímá objekty `Date`, numerické timestampy a řetězcová data

## Kompletní funkční příklad

Katalog produktů s komplexními omezeními:

```typescript
import { Store, ValidationError } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'field-constraints' });

  await store.defineBucket('products', {
    key: 'id',
    schema: {
      id:          { type: 'string', generated: 'uuid' },
      sku:         { type: 'string', required: true, pattern: '^[A-Z]{2}-\\d{4}$' },
      name:        { type: 'string', required: true, minLength: 2, maxLength: 120 },
      description: { type: 'string', maxLength: 1000 },
      price:       { type: 'number', required: true, min: 0 },
      category:    { type: 'string', required: true, enum: ['electronics', 'clothing', 'food', 'books'] },
      rating:      { type: 'number', min: 1, max: 5 },
      website:     { type: 'string', format: 'url' },
      active:      { type: 'boolean', default: true },
    },
  });

  const products = store.bucket('products');

  // Platný produkt — všechna omezení splněna
  const laptop = await products.insert({
    sku: 'EL-0001',
    name: 'Laptop Pro 15',
    description: 'Profesionální notebook.',
    price: 1299.99,
    category: 'electronics',
    rating: 5,
    website: 'https://example.com/laptop-pro',
  });
  console.log('Vložen:', laptop.sku, laptop.name);
  console.log('Active (výchozí):', laptop.active); // true

  // Neplatný produkt — více porušení omezení
  try {
    await products.insert({
      sku: 'bad-sku',          // porušení pattern
      name: 'X',              // porušení minLength
      price: -10,             // porušení min
      category: 'furniture',  // porušení enum
      rating: 6,              // porušení max
      website: 'not-a-url',   // porušení format
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log(`\n${err.issues.length} validačních problémů:`);
      for (const issue of err.issues) {
        console.log(`  [${issue.code}] ${issue.field}: ${issue.message}`);
      }
      // Výstup:
      //   6 validačních problémů:
      //   [pattern] sku: Value must match pattern "^[A-Z]{2}-\d{4}$"
      //   [minLength] name: Minimum length is 2
      //   [min] price: Minimum value is 0
      //   [enum] category: Value must be one of: electronics, clothing, food, books
      //   [max] rating: Maximum value is 5
      //   [format] website: Invalid url format
    }
  }

  // Update s porušením omezení
  try {
    await products.update(laptop.id, { price: -1 });
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log(`\nUpdate odmítnut: ${err.issues[0]!.message}`);
      // Update odmítnut: Minimum value is 0
    }
  }

  await store.stop();
}

main();
```

## Cvičení

Napište definici bucketu pro kolekci `users`, která vynucuje tato pravidla:

1. `id` — automaticky generované UUID
2. `username` — povinný, 3-20 znaků, pouze malá písmena a číslice (`^[a-z0-9]+$`)
3. `email` — povinný, platný formát emailu
4. `age` — volitelný, ale pokud je zadán, musí být mezi 13 a 150
5. `role` — povinný, jeden z `'admin'`, `'editor'`, `'viewer'`
6. `profileUrl` — volitelný, ale pokud je zadán, musí být platná URL

Pak napište kód, který:
- Vloží platného uživatele
- Pokusí se o tři neplatné inserty (jeden porušující `pattern`, jeden porušující `min`, jeden porušující `enum`)
- Zachytí každou `ValidationError` a zaloguje `code` prvního problému

<details>
<summary>Řešení</summary>

```typescript
import { Store, ValidationError } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'exercise' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:         { type: 'string', generated: 'uuid' },
      username:   { type: 'string', required: true, minLength: 3, maxLength: 20, pattern: '^[a-z0-9]+$' },
      email:      { type: 'string', required: true, format: 'email' },
      age:        { type: 'number', min: 13, max: 150 },
      role:       { type: 'string', required: true, enum: ['admin', 'editor', 'viewer'] },
      profileUrl: { type: 'string', format: 'url' },
    },
  });

  const users = store.bucket('users');

  // Platný insert
  const alice = await users.insert({
    username: 'alice42',
    email: 'alice@example.com',
    age: 30,
    role: 'admin',
    profileUrl: 'https://alice.dev',
  });
  console.log('Vytvořen uživatel:', alice.username); // alice42

  // Neplatný: porušení pattern — velká písmena v username
  try {
    await users.insert({ username: 'Alice', email: 'a@b.com', role: 'viewer' });
  } catch (err) {
    console.log('Chyba 1:', (err as ValidationError).issues[0]!.code); // pattern
  }

  // Neplatný: porušení min — věk pod 13
  try {
    await users.insert({ username: 'bob', email: 'bob@b.com', role: 'editor', age: 5 });
  } catch (err) {
    console.log('Chyba 2:', (err as ValidationError).issues[0]!.code); // min
  }

  // Neplatný: porušení enum — role 'superuser' není povolena
  try {
    await users.insert({ username: 'charlie', email: 'c@c.com', role: 'superuser' });
  } catch (err) {
    console.log('Chyba 3:', (err as ValidationError).issues[0]!.code); // enum
  }

  await store.stop();
}

main();
```

</details>

## Shrnutí

- `required: true` odmítá `undefined` a `null` — prázdný řetězec je stále přítomná hodnota
- `enum` omezuje pole na pevný seznam povolených hodnot, funguje s jakýmkoliv typem
- `min` / `max` definují inkluzivní numerické hranice
- `minLength` / `maxLength` omezují délku řetězce
- `pattern` aplikuje regex na řetězcová pole — použijte kotvy `^` a `$` pro shodu s celým řetězcem
- `format` validuje `'email'`, `'url'` nebo `'iso-date'` bez vlastního regexu
- Omezení se volně skládají — deklarujte kolik potřebujete na jednom poli
- `ValidationError` sesbírá **všechny** problémy v jednom vyhození, s `field`, `message` a `code` pro každý problém
- Validace běží při insertu i updatu — updaty validují sloučený záznam

---

Další: [Automatické generování](./02-automaticke-generovani.md)
