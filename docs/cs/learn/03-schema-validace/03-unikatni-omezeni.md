# Unikátní omezení

Validovali jste typy, rozsahy a formáty. Ale existuje třída omezení, kterou žádná kontrola jednotlivého pole nedokáže vynucovat: **unikátnost napříč všemi záznamy**. Když přidáte uživatele s `email: 'alice@example.com'`, potřebujete záruku, že žádný jiný uživatel tento email nemá. S prostou `Map` byste museli nejprve dotazovat a pak vložit — vzor kontrola-pak-akce, který je ze své podstaty náchylný na race condition. Mezi kontrolou a vložením se může vklouznout jiný zápis.

noex-store vynucuje unikátní omezení atomicky. Deklarujte `unique: true` na poli a Store garantuje, že žádné dva záznamy ve stejném bucketu nesdílí stejnou hodnotu daného pole.

## Co se naučíte

- Jak deklarovat unikátní omezení na polích schématu
- Jak Store vytváří a udržuje automatické indexy pro unikátní pole
- Jak `UniqueConstraintError` hlásí porušení s názvem bucketu, polem a hodnotou
- Jak se unikátní omezení chovají při insertu vs updatu
- Jak `null` a `undefined` hodnoty interagují s unikátností
- Dvoufázový commit přístup zabraňující částečné korupci indexů

## Deklarace unikátního omezení

Přidejte `unique: true` k libovolnému poli ve schématu:

```typescript
const store = await Store.start({ name: 'unique-demo' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    username: { type: 'string', required: true, unique: true },
    email:    { type: 'string', required: true, format: 'email', unique: true },
    name:     { type: 'string', required: true },
  },
});

const users = store.bucket('users');

await users.insert({ username: 'alice', email: 'alice@example.com', name: 'Alice' });

// Selže — username 'alice' je již obsazeno
try {
  await users.insert({ username: 'alice', email: 'bob@example.com', name: 'Bob' });
} catch (err) {
  console.log(err.message);
  // Unique constraint violation in bucket "users": field "username" already has value "alice"
}
```

Na stejném bucketu můžete mít více unikátních polí. Každé je vynucováno nezávisle — záznam musí být unikátní na **každém** poli, ne na kombinaci.

## Automatická tvorba indexů

Když deklarujete `unique: true` na poli, Store automaticky vytvoří **unikátní index** pro dané pole. Nemusíte ho přidávat do pole `indexes` zvlášť:

```typescript
// Tyto dvě definice jsou pro unikátnost ekvivalentní:

// Možnost A: unique ve schématu (index vytvořen automaticky)
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    email: { type: 'string', required: true, unique: true },
  },
});

// Možnost B: unique ve schématu + explicitně v indexes (stejný výsledek)
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    email: { type: 'string', required: true, unique: true },
  },
  indexes: ['email'],
});
```

Obě produkují stejný unikátní index. Rozdíl je důležitý pro ne-unikátní pole: pokud má pole `unique: true`, vždy dostane unikátní index; pokud je pole v poli `indexes`, ale nemá `unique: true`, dostane ne-unikátní index (povolující duplikáty).

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │                     TYPY INDEXŮ                                    │
  │                                                                    │
  │  unique: true              Ne-unikátní (pouze v poli indexes)      │
  │  ┌──────────────────┐     ┌──────────────────────────────────┐    │
  │  │  hodnota → klíč   │     │  hodnota → Set<klíč>             │    │
  │  │  (mapování 1 : 1) │     │  (mapování 1 : N)                │    │
  │  │                    │     │                                   │    │
  │  │  'alice@a.com'→k1 │     │  'admin' → { k1, k3 }           │    │
  │  │  'bob@b.com'  →k2 │     │  'user'  → { k2, k4, k5 }      │    │
  │  │  'carol@c.com'→k3 │     │  'guest' → { k6 }               │    │
  │  └──────────────────┘     └──────────────────────────────────┘    │
  │                                                                    │
  │  Vynucuje unikátnost       Povoluje duplikáty                      │
  │  O(1) vyhledání hodnotou   O(1) vyhledání hodnotou                 │
  └──────────────────────────────────────────────────────────────────┘
```

## `UniqueConstraintError`

Když je unikátní omezení porušeno, Store vyhodí `UniqueConstraintError` se třemi vlastnostmi:

```typescript
import { UniqueConstraintError } from '@hamicek/noex-store';

try {
  await users.insert({ username: 'alice', email: 'alice-new@example.com', name: 'Alice 2' });
} catch (err) {
  if (err instanceof UniqueConstraintError) {
    console.log(err.name);    // 'UniqueConstraintError'
    console.log(err.bucket);  // 'users'
    console.log(err.field);   // 'username'
    console.log(err.value);   // 'alice'
    console.log(err.message);
    // Unique constraint violation in bucket "users": field "username" already has value "alice"
  }
}
```

### Tvar chyby

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `string` | Vždy `'UniqueConstraintError'` |
| `bucket` | `string` | Bucket, ve kterém k porušení došlo |
| `field` | `string` | Pole, které má duplicitní hodnotu |
| `value` | `unknown` | Duplicitní hodnota, která byla odmítnuta |
| `message` | `string` | Lidsky čitelný popis |

To se liší od `ValidationError`, který se zabývá problémy na úrovni jednotlivých polí. `UniqueConstraintError` je omezení na úrovni dat — záznam je platný v izolaci, ale koliduje s existujícím záznamem.

## Unikátní omezení při insertu

Při insertu Store kontroluje všechny unikátní indexy před zápisem jakýchkoliv dat. Pokud má jakékoliv unikátní pole hodnotu, která v indexu již existuje, celý insert je odmítnut:

```typescript
const users = store.bucket('users');

await users.insert({ username: 'alice', email: 'alice@example.com', name: 'Alice' });
await users.insert({ username: 'bob', email: 'bob@example.com', name: 'Bob' });

// Selže — username i email jsou unikátní, ale username je kontrolováno jako první
try {
  await users.insert({ username: 'alice', email: 'carol@example.com', name: 'Carol' });
} catch (err) {
  console.log((err as UniqueConstraintError).field); // 'username'
}

// Selže — username je unikátní, email koliduje s Aliciným
try {
  await users.insert({ username: 'carol', email: 'alice@example.com', name: 'Carol' });
} catch (err) {
  console.log((err as UniqueConstraintError).field); // 'email'
}
```

## Unikátní omezení při updatu

Při updatu Store kontroluje, zda by nová hodnota kolidovala s jiným záznamem. Aktualizace záznamu na stejnou hodnotu, kterou již má, je povolena (sebe-reference):

```typescript
const users = store.bucket('users');

const alice = await users.insert({ username: 'alice', email: 'alice@example.com', name: 'Alice' });
const bob = await users.insert({ username: 'bob', email: 'bob@example.com', name: 'Bob' });

// Funguje — měníme jméno Alice, username zůstává stejný (sebe-reference povolena)
await users.update(alice.id, { username: 'alice', name: 'Alice Smith' });

// Funguje — měníme email Alice na novou, nepoužitou hodnotu
await users.update(alice.id, { email: 'alice.smith@example.com' });

// Selže — měníme email Alice na Bobův email
try {
  await users.update(alice.id, { email: 'bob@example.com' });
} catch (err) {
  console.log((err as UniqueConstraintError).field); // 'email'
  console.log((err as UniqueConstraintError).value); // 'bob@example.com'
}
```

## Hodnoty null a undefined

Hodnoty `null` a `undefined` **nejsou indexovány**. To znamená:

- Více záznamů může mít stejné pole jako `null` nebo `undefined` bez porušení unikátnosti
- Záznamy nelze vyhledávat podle `null` přes unikátní index

```typescript
await store.defineBucket('accounts', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    phone: { type: 'string', unique: true }, // volitelné, ale unikátní když je přítomno
  },
});

const accounts = store.bucket('accounts');

// Oba inserty uspějí — null phone není indexován, žádný konflikt
await accounts.insert({ name: 'Alice' });          // phone: undefined
await accounts.insert({ name: 'Bob' });            // phone: undefined
await accounts.insert({ name: 'Carol', phone: null }); // phone: null

// Ale jakmile je phone nastaven, musí být unikátní
await accounts.insert({ name: 'Dave', phone: '+420123456789' });

try {
  await accounts.insert({ name: 'Eve', phone: '+420123456789' });
} catch (err) {
  console.log((err as UniqueConstraintError).field); // 'phone'
}
```

Toto chování je konzistentní s SQL databázemi, kde hodnoty `NULL` nejsou v unikátních indexech považovány za vzájemně rovné.

## Dvoufázový commit

Store používá dvoufázový přístup k prevenci částečné korupce indexů. Při vkládání záznamu, který má více unikátních polí:

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │                     DVOUFÁZOVÝ INSERT                              │
  │                                                                    │
  │  Fáze 1 — VALIDACE                                                │
  │  ┌──────────────────────────────────────────────────────────┐     │
  │  │  Pro každý unikátní index:                                │     │
  │  │    Zkontroluj, zda hodnota existuje → UniqueConstraintError│    │
  │  │                                                            │     │
  │  │  Pokud JAKÁKOLIV kontrola selže → vyhoď, indexy nezměněny │     │
  │  └──────────────────────────────────────────────────────────┘     │
  │                                                                    │
  │  Fáze 2 — ZÁPIS (pouze pokud Fáze 1 prošla)                      │
  │  ┌──────────────────────────────────────────────────────────┐     │
  │  │  Pro každý index (unikátní i ne-unikátní):                │     │
  │  │    Přidej mapování hodnota → primárníKlíč                 │     │
  │  └──────────────────────────────────────────────────────────┘     │
  │                                                                    │
  │  Výsledek: Buď jsou VŠECHNY indexy aktualizovány, nebo ŽÁDNÝ     │
  └──────────────────────────────────────────────────────────────────┘
```

Bez tohoto přístupu by záznam se dvěma unikátními poli mohl selhat na druhé kontrole poté, co první index již byl aktualizován — zanechal by indexy v nekonzistentním stavu. Dvoufázový přístup nejprve vše zvaliduje a pak vše zapíše.

## Unikátní vs ne-unikátní indexy

Je důležité rozumět rozdílu mezi unikátním indexem a běžným indexem:

```typescript
await store.defineBucket('employees', {
  key: 'id',
  schema: {
    id:         { type: 'string', generated: 'uuid' },
    badgeNumber:{ type: 'string', required: true, unique: true },
    department: { type: 'string', required: true },
    email:      { type: 'string', required: true, format: 'email', unique: true },
  },
  indexes: ['department'], // ne-unikátní index pro rychlé vyhledávání
});
```

| Aspekt | Unikátní index (`unique: true`) | Ne-unikátní index (`indexes: [...]`) |
|--------|-------------------------------|-------------------------------------|
| **Duplikáty** | Odmítnuty s `UniqueConstraintError` | Povoleny — mnoho záznamů sdílí stejnou hodnotu |
| **Datová struktura** | `Map<hodnota, klíč>` (1:1) | `Map<hodnota, Set<klíč>>` (1:N) |
| **Výsledek vyhledání** | Nejvýše 1 záznam | 0 nebo více záznamů |
| **Vytvořen** | `unique: true` ve schématu | Název pole v poli `indexes` |
| **Primární použití** | Integrita dat (žádné duplikáty) | Výkon dotazů (rychlé vyhledávání) |

## Kompletní funkční příklad

Systém registrace uživatelů s unikátním username, emailem a volitelným telefonem:

```typescript
import { Store, UniqueConstraintError, ValidationError } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'unique-constraints' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:       { type: 'string', generated: 'uuid' },
      username: { type: 'string', required: true, minLength: 3, maxLength: 20, unique: true },
      email:    { type: 'string', required: true, format: 'email', unique: true },
      phone:    { type: 'string', unique: true }, // volitelné, ale unikátní když je přítomno
      role:     { type: 'string', enum: ['admin', 'user'], default: 'user' },
    },
    indexes: ['role'], // ne-unikátní index pro dotazování podle role
  });

  const users = store.bucket('users');

  // Registrace uživatelů
  const alice = await users.insert({
    username: 'alice',
    email: 'alice@example.com',
    phone: '+420111222333',
  });
  console.log('Registrován:', alice.username, '(' + alice.email + ')');

  const bob = await users.insert({
    username: 'bob',
    email: 'bob@example.com',
    // Žádný telefon — více uživatelů může být bez telefonu
  });
  console.log('Registrován:', bob.username, '(' + bob.email + ')');

  // Duplicitní username
  try {
    await users.insert({ username: 'alice', email: 'alice2@example.com' });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      console.log(`\nDuplikát ${err.field}: "${String(err.value)}" v ${err.bucket}`);
      // Duplikát username: "alice" v users
    }
  }

  // Duplicitní email
  try {
    await users.insert({ username: 'carol', email: 'alice@example.com' });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      console.log(`Duplikát ${err.field}: "${String(err.value)}" v ${err.bucket}`);
      // Duplikát email: "alice@example.com" v users
    }
  }

  // Duplicitní telefon
  try {
    await users.insert({ username: 'dave', email: 'dave@example.com', phone: '+420111222333' });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      console.log(`Duplikát ${err.field}: "${String(err.value)}" v ${err.bucket}`);
      // Duplikát phone: "+420111222333" v users
    }
  }

  // Update: změna emailu Alice na novou unikátní hodnotu
  const updated = await users.update(alice.id, { email: 'alice.new@example.com' });
  console.log('\nEmail Alice aktualizován na:', updated.email);

  // Update: pokus změnit email Alice na Bobův email
  try {
    await users.update(alice.id, { email: 'bob@example.com' });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      console.log(`Nelze aktualizovat: ${err.field} "${String(err.value)}" patří jinému uživateli`);
      // Nelze aktualizovat: email "bob@example.com" patří jinému uživateli
    }
  }

  // ValidationError vs UniqueConstraintError
  try {
    await users.insert({ username: 'ab', email: 'short@example.com' }); // username příliš krátký
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('\nValidace (ne unikátnost):', err.issues[0]!.code);
      // Validace (ne unikátnost): minLength
    }
  }

  await store.stop();
}

main();
```

## Cvičení

Navrhněte bucket `products` pro e-commerce platformu s těmito požadavky:

1. `id` — automaticky generované UUID
2. `sku` — povinné, unikátní, musí odpovídat vzoru `^[A-Z]{2}-\d{4}$`
3. `name` — povinné, 3-200 znaků
4. `barcode` — volitelné, unikátní když je přítomno (EAN-13 vzor: `^\d{13}$`)
5. `category` — povinné, jedno z `['electronics', 'clothing', 'food', 'home']`
6. `price` — povinné, minimum 0

Pak napište kód, který demonstruje:
- Vložení dvou platných produktů
- Pokus o duplicitní `sku` a zachycení `UniqueConstraintError`
- Vložení dvou produktů bez `barcode` (oba uspějí)
- Pokus o duplicitní `barcode` a zachycení chyby
- Aktualizaci `sku` produktu na obsazenou hodnotu a zachycení chyby

<details>
<summary>Řešení</summary>

```typescript
import { Store, UniqueConstraintError } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'exercise' });

  await store.defineBucket('products', {
    key: 'id',
    schema: {
      id:       { type: 'string', generated: 'uuid' },
      sku:      { type: 'string', required: true, unique: true, pattern: '^[A-Z]{2}-\\d{4}$' },
      name:     { type: 'string', required: true, minLength: 3, maxLength: 200 },
      barcode:  { type: 'string', unique: true, pattern: '^\\d{13}$' },
      category: { type: 'string', required: true, enum: ['electronics', 'clothing', 'food', 'home'] },
      price:    { type: 'number', required: true, min: 0 },
    },
  });

  const products = store.bucket('products');

  // Dva platné produkty
  const laptop = await products.insert({
    sku: 'EL-0001',
    name: 'Laptop Pro',
    barcode: '5901234123457',
    category: 'electronics',
    price: 999,
  });
  console.log('Vytvořen:', laptop.sku);

  const shirt = await products.insert({
    sku: 'CL-0001',
    name: 'Cotton T-Shirt',
    barcode: '4006381333931',
    category: 'clothing',
    price: 29.99,
  });
  console.log('Vytvořen:', shirt.sku);

  // Duplicitní SKU
  try {
    await products.insert({ sku: 'EL-0001', name: 'Another Laptop', category: 'electronics', price: 500 });
  } catch (err) {
    console.log('Duplikát SKU:', (err as UniqueConstraintError).field); // 'sku'
  }

  // Dva produkty bez barcode — oba uspějí (null není indexován)
  await products.insert({ sku: 'FD-0001', name: 'Organic Apples', category: 'food', price: 3.50 });
  await products.insert({ sku: 'FD-0002', name: 'Fresh Bread', category: 'food', price: 2.00 });
  console.log('Dva produkty bez barcode: OK');

  // Duplicitní barcode
  try {
    await products.insert({
      sku: 'HM-0001',
      name: 'Table Lamp',
      barcode: '5901234123457', // stejný jako laptop
      category: 'home',
      price: 45,
    });
  } catch (err) {
    console.log('Duplikát barcode:', (err as UniqueConstraintError).field); // 'barcode'
  }

  // Update SKU na obsazenou hodnotu
  try {
    await products.update(shirt.id, { sku: 'EL-0001' }); // SKU laptopu
  } catch (err) {
    console.log('Konflikt updatu:', (err as UniqueConstraintError).field); // 'sku'
  }

  await store.stop();
}

main();
```

</details>

## Shrnutí

- `unique: true` na poli schématu garantuje, že žádné dva záznamy v bucketu nesdílí stejnou hodnotu
- Store automaticky vytváří unikátní index pro pole označená `unique: true` — není potřeba je přidávat do `indexes`
- `UniqueConstraintError` poskytuje vlastnosti `bucket`, `field` a `value` pro přesné zpracování chyb
- Při insertu jsou všechna unikátní omezení zvalidována před aktualizací jakýchkoliv indexů (dvoufázový commit)
- Při updatu je sebe-reference povolena — záznam může být "aktualizován" na stejnou hodnotu, kterou již má
- Hodnoty `null` a `undefined` nejsou indexovány — více záznamů může mít `null` pro unikátní pole
- `UniqueConstraintError` je oddělen od `ValidationError`: validace kontroluje pravidla jednotlivých polí, unikátnost kontroluje integritu napříč záznamy

---

Další: [Filtrování a vyhledávání](../04-dotazovani/01-filtrovani-a-vyhledavani.md)
