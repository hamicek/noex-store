# Buckety a Schémata

Store bez bucketů je prázdný kontejner. Buckety jsou místo, kde žijí data — každý je pojmenovaná kolekce se schématem, zajištěná vlastním actorem. V této kapitole se naučíte definovat buckety, deklarovat schémata s typy polí a omezeními a pochopíte, jak Store organizuje bucket actory ve svém stromu supervize.

## Co se naučíte

- Jak definovat bucket pomocí `defineBucket()` a co dělá každá konfigurační volba
- Jak deklarovat typy polí: `string`, `number`, `boolean`, `object`, `array`, `date`
- Jak fungují omezení `required`, `enum`, `default`, `generated`, `unique`, `min/max`, `minLength/maxLength`, `pattern` a `format`
- Jak klíčové pole identifikuje záznamy v bucketu
- Jak Store organizuje bucket actory pod Supervisorem

## Definice Bucket

Bucket se vytváří pomocí `store.defineBucket(name, definition)`:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'app' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 1 },
    email: { type: 'string', format: 'email', unique: true },
    role:  { type: 'string', enum: ['admin', 'user', 'guest'], default: 'user' },
  },
  indexes: ['email', 'role'],
  ttl: '90d',
  maxSize: 50_000,
});
```

`defineBucket()` je asynchronní, protože spouští GenServer actor pro bucket a (pokud je zapnutá persistence) načítá dříve uložená data. Po dokončení promise je bucket připraven na CRUD operace.

### Co se děje uvnitř

Když zavoláte `defineBucket('users', definition)`, Store:

```text
  defineBucket('users', definition)
        │
        ├── 1. Validace definice (klíčové pole existuje ve schématu, indexová pole existují)
        ├── 2. Načtení persistovaných dat (pokud je persistence zapnutá a bucket je persistent)
        ├── 3. Spuštění BucketServer actoru (GenServer se schématem, indexy, daty)
        ├── 4. Registrace actoru pod Supervisorem (one_for_one restart)
        ├── 5. Registrace u vrstvy Persistence (pokud je aplikovatelné)
        └── 6. Registrace u TtlManageru (pokud je nastaveno ttl)
```

### Reference definice Bucket

| Vlastnost | Typ | Povinná | Výchozí | Účel |
|-----------|-----|---------|---------|------|
| `key` | `string` | Ano | — | Název pole primárního klíče. Musí existovat ve `schema`. |
| `schema` | `SchemaDefinition` | Ano | — | Definice polí s typy a omezeními. |
| `indexes` | `string[]` | Ne | `[]` | Pole k indexování pro rychlé vyhledávání. Každé musí existovat ve `schema`. |
| `etsType` | `EtsTableType` | Ne | `'set'` | Typ úložiště: `'set'`, `'ordered_set'`, `'bag'`, `'duplicate_bag'`. |
| `persistent` | `boolean` | Ne | `true` (pokud má Store persistenci) | Nastavte na `false` pro vyřazení tohoto bucketu z persistence. |
| `ttl` | `number \| string` | Ne | `undefined` | Doba životnosti na záznam. Číslo = ms, řetězec = čitelný formát. |
| `maxSize` | `number` | Ne | `undefined` | Maximální počet záznamů. Nejstarší (podle `_createdAt`) se odstraní při přetečení. |

## Klíčové pole

Každý bucket musí deklarovat `key` — pole, které unikátně identifikuje každý záznam. Je podobné primárnímu klíči v databázi:

```typescript
await store.defineBucket('products', {
  key: 'sku',  // Primární klíč je pole 'sku'
  schema: {
    sku:   { type: 'string', required: true },
    name:  { type: 'string', required: true },
    price: { type: 'number', min: 0 },
  },
});

const products = store.bucket('products');

// Insert — hodnota klíčového pole identifikuje tento záznam
await products.insert({ sku: 'WIDGET-01', name: 'Widget', price: 9.99 });

// Získání podle klíče
const widget = await products.get('WIDGET-01');

// Aktualizace podle klíče
await products.update('WIDGET-01', { price: 12.99 });

// Smazání podle klíče
await products.delete('WIDGET-01');
```

Klíčové pole se validuje jako součást schématu, ale nelze ho měnit přes `update()` — po vložení je neměnné.

### Automaticky generované klíče

U většiny bucketů budete chtít, aby se klíč generoval automaticky místo ručního zadávání:

```typescript
// UUID klíč — globálně unikátní, náhodný
await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    amount: { type: 'number', required: true },
  },
});

// Autoincrement klíč — sekvenční čísla
await store.defineBucket('logs', {
  key: 'id',
  schema: {
    id:      { type: 'number', generated: 'autoincrement' },
    message: { type: 'string', required: true },
  },
});

const orders = store.bucket('orders');
const logs = store.bucket('logs');

const order = await orders.insert({ amount: 99.50 });
console.log(order.id); // 'a1b2c3d4-e5f6-…' (UUID)

const log1 = await logs.insert({ message: 'První' });
const log2 = await logs.insert({ message: 'Druhý' });
console.log(log1.id); // 1
console.log(log2.id); // 2
```

Pokud má pole `generated`, při vkládání ho nezadáváte — Store ho vyplní automaticky. Pokud přesto hodnotu poskytnete, použije se vygenerovaná hodnota (poskytnutá se ignoruje).

## Definice schématu

Schéma je `Record<string, FieldDefinition>` — objekt, kde každý klíč je název pole a každá hodnota popisuje typ pole a jeho omezení:

```typescript
const schema = {
  id:        { type: 'string', generated: 'uuid' },
  name:      { type: 'string', required: true, minLength: 1, maxLength: 100 },
  email:     { type: 'string', format: 'email', unique: true },
  age:       { type: 'number', min: 0, max: 150 },
  role:      { type: 'string', enum: ['admin', 'user', 'guest'], default: 'user' },
  bio:       { type: 'string', pattern: '^[A-Za-z]' },
  tags:      { type: 'array', default: [] },
  settings:  { type: 'object', default: {} },
  active:    { type: 'boolean', default: true },
  birthDate: { type: 'date' },
};
```

Každé pole ve schématu se validuje při každém `insert` a `update`. Pole nedeklarovaná ve schématu se tiše propustí — schéma validuje pouze to, co deklaruje.

### Typy polí

noex-store podporuje šest typů polí:

| Typ | JavaScript hodnota | Příklad | Poznámky |
|-----|-------------------|---------|----------|
| `string` | `string` | `'hello'`, `''` | |
| `number` | `number` | `42`, `3.14` | `NaN` je odmítnut |
| `boolean` | `boolean` | `true`, `false` | |
| `object` | `Record<string, unknown>` | `{ theme: 'dark' }` | Ne `null`, ne pole |
| `array` | `unknown[]` | `['a', 'b']` | |
| `date` | `Date`, `number`, `string` | `'2025-01-15'` | Přijímá Date objekty, timestampy nebo ISO řetězce |

Validace typu probíhá před validací omezení. Pokud typ neodpovídá, Store nahlásí chybu typu a přeskočí kontrolu omezení daného pole.

### Omezení

Omezení přidávají pravidla nad rámec základní kontroly typu:

#### `required`

Pole musí být přítomno a nesmí být null/undefined:

```typescript
name: { type: 'string', required: true }

// OK: { name: 'Alice' }
// Chyba: { name: undefined }
// Chyba: { name: null }
// Chyba: {} (name chybí)
```

#### `enum`

Hodnota musí být jedna z uvedených možností:

```typescript
role: { type: 'string', enum: ['admin', 'user', 'guest'] }

// OK: { role: 'admin' }
// Chyba: { role: 'superadmin' }
```

Funguje s jakýmkoli typem, nejen s řetězci:

```typescript
priority: { type: 'number', enum: [1, 2, 3] }
```

#### `default`

Aplikuje se, když pole chybí (`undefined`) při vkládání. Může být statická hodnota nebo funkce:

```typescript
role:      { type: 'string', default: 'user' },
tags:      { type: 'array', default: [] },
createdBy: { type: 'string', default: () => getCurrentUser() },
```

Statické výchozí hodnoty se použijí tak, jak jsou. Funkční výchozí hodnoty se volají při každém insertu — užitečné pro hodnoty, které se mají lišit pro každý záznam (jako mutable objekty nebo vypočítané hodnoty).

#### `generated`

Automatické generování hodnoty pole při insertu. Čtyři strategie:

| Strategie | Typ | Příklad hodnoty |
|-----------|-----|-----------------|
| `'uuid'` | `string` | `'a1b2c3d4-e5f6-7890-abcd-ef1234567890'` |
| `'cuid'` | `string` | `'clx1abc2d0001...'` |
| `'autoincrement'` | `number` | `1`, `2`, `3`, … |
| `'timestamp'` | `string` | `'2025-01-15T12:00:00.000Z'` (ISO-8601) |

```typescript
id:        { type: 'string', generated: 'uuid' },
createdAt: { type: 'string', generated: 'timestamp' },
seq:       { type: 'number', generated: 'autoincrement' },
```

Generovaná pole:
- Vyplní se automaticky při insertu (pokud je hodnota `undefined`)
- Odstraní se z payloadu updatu — po vytvoření je nelze přepsat

#### `unique`

Vynucuje unikátnost napříč všemi záznamy v bucketu:

```typescript
email: { type: 'string', format: 'email', unique: true }
```

Pokud se pokusíte vložit nebo aktualizovat záznam s duplicitní hodnotou, Store vyhodí `UniqueConstraintError`:

```typescript
await users.insert({ name: 'Alice', email: 'alice@example.com' });

try {
  await users.insert({ name: 'Bob', email: 'alice@example.com' });
} catch (err) {
  // UniqueConstraintError: field "email" already has value "alice@example.com"
  console.log(err.name);  // 'UniqueConstraintError'
  console.log(err.field); // 'email'
  console.log(err.value); // 'alice@example.com'
}
```

Unikátní omezení jsou zajištěna automatickým indexem — deklarace `unique: true` také vytvoří index na daném poli.

#### `min` / `max`

Validace číselného rozsahu (inkluzivní):

```typescript
age:   { type: 'number', min: 0, max: 150 },
price: { type: 'number', min: 0.01 },
```

#### `minLength` / `maxLength`

Validace délky řetězce:

```typescript
name:     { type: 'string', minLength: 1, maxLength: 100 },
password: { type: 'string', minLength: 8 },
```

#### `pattern`

Regex vzor pro řetězce:

```typescript
slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
code: { type: 'string', pattern: '^[A-Z]{3}-\\d{4}$' },
```

Řetězec vzoru se interně zkompiluje do `RegExp`. Měl by odpovídat celé hodnotě (doporučeny kotvy).

#### `format`

Vestavěné validátory formátu pro běžné vzory řetězců:

| Formát | Validuje |
|--------|----------|
| `'email'` | Formát e-mailové adresy |
| `'url'` | Formát URL |
| `'iso-date'` | Formát data ISO-8601 |

```typescript
email:    { type: 'string', format: 'email' },
website:  { type: 'string', format: 'url' },
birthday: { type: 'string', format: 'iso-date' },
```

### ValidationError

Pokud zápis poruší jakékoli omezení, Store vyhodí `ValidationError` se strukturovanými detaily problémů:

```typescript
try {
  await users.insert({ name: '', email: 'not-an-email', age: -5 });
} catch (err) {
  console.log(err.name);    // 'ValidationError'
  console.log(err.issues);
  // [
  //   { field: 'name',  message: 'Minimum length is 1',   code: 'minLength' },
  //   { field: 'email', message: 'Invalid email format',  code: 'format' },
  //   { field: 'age',   message: 'Minimum value is 0',    code: 'min' },
  // ]
}
```

Každý problém obsahuje:

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `field` | `string` | Název pole, které neprošlo validací |
| `message` | `string` | Čitelný popis selhání |
| `code` | `string` | Strojově čitelný kód: `required`, `type`, `enum`, `minLength`, `maxLength`, `pattern`, `format`, `min`, `max` |

Záznam se nikdy neuloží, když validace selže. Všechny problémy se sesbírají a nahlásí společně — validátor se nezastaví u první chyby.

## Indexy

Deklarujte indexy pro pole, podle kterých často filtrujete:

```typescript
await store.defineBucket('products', {
  key: 'sku',
  schema: {
    sku:      { type: 'string', required: true },
    category: { type: 'string', required: true },
    brand:    { type: 'string', required: true },
    price:    { type: 'number', min: 0 },
  },
  indexes: ['category', 'brand'],
});
```

S deklarovanými indexy `where({ category: 'electronics' })` používá O(1) hash vyhledávání místo procházení všech záznamů. Bez indexu Store přejde na úplný průchod.

Každé pole v `indexes` musí existovat ve schématu — Store to validuje při volání `defineBucket()`.

Unikátní omezení (`unique: true`) také automaticky vytváří index. Pole nemusíte přidávat do `indexes` zvlášť.

## Strom supervize

Každý bucket běží jako nezávislý GenServer actor. Supervisor Store spravuje všechny bucket actory se strategií restartu `one_for_one`:

```text
                         ┌──────────────────────┐
                         │        Store         │
                         │   (orchestrator)     │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │      Supervisor      │
                         │   one_for_one        │
                         └──┬───────┬───────┬───┘
                            │       │       │
                    ┌───────▼──┐ ┌──▼─────┐ ┌▼────────┐
                    │  Bucket  │ │ Bucket │ │  Bucket │
                    │  Server  │ │ Server │ │  Server │
                    │  users   │ │ orders │ │ sessions│
                    └──────────┘ └────────┘ └─────────┘

  Každý BucketServer zapouzdřuje:
  ┌───────────────────────────────┐
  │  BucketServer (GenServer)     │
  │                               │
  │  ┌─────────────────────────┐  │
  │  │  Data (Map<key, record>)│  │
  │  ├─────────────────────────┤  │
  │  │  SchemaValidator        │  │
  │  ├─────────────────────────┤  │
  │  │  IndexManager           │  │
  │  ├─────────────────────────┤  │
  │  │  Event Publishing       │  │
  │  └─────────────────────────┘  │
  └───────────────────────────────┘
```

### Proč actory?

- **Izolace**: Každý bucket je nezávislý proces. Chyba v jednom bucketu neshodí ostatní.
- **Serializace**: Všechny operace na bucketu jsou serializovány přes mailbox jeho GenServeru. Žádné zámky, žádné race conditions.
- **Restart**: Pokud bucket actor spadne, Supervisor ho automaticky restartuje. Ostatní buckety pokračují bez přerušení.

### BucketHandle — bezstavový proxy

S BucketServer actorem nikdy nepracujete přímo. Místo toho používáte `BucketHandle` — lehký proxy, který posílá zprávy actoru:

```typescript
// Získání handle (levné — nedrží žádná data, jen referenci)
const users = store.bucket('users');

// Každé volání prochází přes GenServer.call do BucketServeru
await users.insert({ name: 'Alice' });    // → GenServer.call(ref, { type: 'insert', … })
await users.get('some-id');               // → GenServer.call(ref, { type: 'get', … })
await users.where({ role: 'admin' });     // → GenServer.call(ref, { type: 'where', … })
```

Můžete vytvořit libovolný počet handle — všechny ukazují na stejný actor. Neexistuje žádný connection pooling ani životní cyklus handle, který byste museli spravovat.

## Odstranění Bucket

Pro odebrání bucketu a všech jeho dat:

```typescript
await store.dropBucket('users');
```

Toto ukončí actor bucketu, odregistruje ho z persistence a správy TTL a odebere definici. Po odebrání `store.bucket('users')` vyhodí `BucketNotDefinedError`.

## Kompletní příklad

Store se třemi buckety demonstrující různé vzory schémat:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'bucket-demo' });

  // Bucket s UUID klíčem, validací formátu, unikátním omezením
  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:       { type: 'string', generated: 'uuid' },
      username: { type: 'string', required: true, minLength: 3, maxLength: 30, unique: true },
      email:    { type: 'string', format: 'email', unique: true },
      role:     { type: 'string', enum: ['admin', 'editor', 'viewer'], default: 'viewer' },
    },
    indexes: ['role'],
  });

  // Bucket s autoincrement klíčem, omezením pattern, TTL
  await store.defineBucket('notifications', {
    key: 'id',
    schema: {
      id:      { type: 'number', generated: 'autoincrement' },
      userId:  { type: 'string', required: true },
      title:   { type: 'string', required: true, maxLength: 200 },
      channel: { type: 'string', enum: ['email', 'sms', 'push'], required: true },
      read:    { type: 'boolean', default: false },
    },
    indexes: ['userId', 'channel'],
    ttl: '30d',
    maxSize: 100_000,
  });

  // Bucket s ručním string klíčem, výchozí hodnoty vnořených objektů
  await store.defineBucket('settings', {
    key: 'userId',
    schema: {
      userId:      { type: 'string', required: true },
      theme:       { type: 'string', enum: ['light', 'dark', 'system'], default: 'system' },
      preferences: { type: 'object', default: () => ({ notifications: true, language: 'en' }) },
    },
  });

  // Použití bucketů
  const users = store.bucket('users');
  const notifications = store.bucket('notifications');
  const settings = store.bucket('settings');

  const alice = await users.insert({ username: 'alice', email: 'alice@example.com', role: 'admin' });
  console.log(alice);
  // { id: 'a1b2…', username: 'alice', email: 'alice@example.com', role: 'admin',
  //   _version: 1, _createdAt: …, _updatedAt: … }

  const notif = await notifications.insert({ userId: alice.id, title: 'Vítejte!', channel: 'email' });
  console.log(notif);
  // { id: 1, userId: 'a1b2…', title: 'Vítejte!', channel: 'email', read: false,
  //   _version: 1, _createdAt: …, _updatedAt: …, _expiresAt: … }

  const prefs = await settings.insert({ userId: alice.id as string });
  console.log(prefs.theme);       // 'system' (výchozí)
  console.log(prefs.preferences); // { notifications: true, language: 'en' } (funkční výchozí)

  // Validace funguje
  try {
    await users.insert({ username: 'ab', email: 'bad', role: 'hacker' });
  } catch (err) {
    console.log(err.issues.map((i: any) => `${i.field}: ${i.code}`));
    // ['username: minLength', 'email: format', 'role: enum']
  }

  // Unikátní omezení funguje
  try {
    await users.insert({ username: 'alice', email: 'other@example.com' });
  } catch (err) {
    console.log(err.name); // 'UniqueConstraintError'
  }

  const stats = await store.getStats();
  console.log(`Buckety: ${stats.buckets.names.join(', ')}`);
  // Buckety: users, notifications, settings

  await store.stop();
}

main();
```

## Cvičení

Navrhněte definice bucketů (klíč, schéma, indexy) pro blogovou platformu. Potřebujete tři buckety: `authors`, `posts` a `comments`. Zvažte:

- Autoři mají unikátní uživatelské jméno (3-30 znaků), e-mail a bio (nepovinné, max 500 znaků)
- Příspěvky mají titulek (povinný, 1-200 znaků), tělo, status (`draft`, `published`, `archived`) a referenci na autora
- Komentáře patří k příspěvku a autorovi, mají tělo (povinné, 1-2000 znaků) a měly by automaticky expirovat po 365 dnech
- Systém potřebuje vyhledávat příspěvky podle autora a statusu a komentáře podle příspěvku

Napište tři volání `defineBucket()`.

<details>
<summary>Řešení</summary>

```typescript
// Autoři — UUID klíč, unikátní uživatelské jméno a e-mail
await store.defineBucket('authors', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    username: { type: 'string', required: true, minLength: 3, maxLength: 30, unique: true },
    email:    { type: 'string', format: 'email', required: true, unique: true },
    bio:      { type: 'string', maxLength: 500 },
  },
});

// Příspěvky — UUID klíč, enum status s výchozí hodnotou, indexované pro vyhledávání podle autora a statusu
await store.defineBucket('posts', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    title:    { type: 'string', required: true, minLength: 1, maxLength: 200 },
    body:     { type: 'string', required: true },
    status:   { type: 'string', enum: ['draft', 'published', 'archived'], default: 'draft' },
    authorId: { type: 'string', required: true, ref: 'authors' },
  },
  indexes: ['authorId', 'status'],
});

// Komentáře — UUID klíč, TTL pro automatickou expiraci, indexované pro vyhledávání podle příspěvku
await store.defineBucket('comments', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    postId:   { type: 'string', required: true, ref: 'posts' },
    authorId: { type: 'string', required: true, ref: 'authors' },
    body:     { type: 'string', required: true, minLength: 1, maxLength: 2000 },
  },
  indexes: ['postId'],
  ttl: '365d',
});
```

**Klíčová rozhodnutí:**
- Všechny tři buckety používají `generated: 'uuid'` pro klíč — globálně unikátní, bez potřeby koordinace.
- `unique: true` na `username` a `email` vynucuje unikátnost na datové vrstvě (což také automaticky vytváří indexy).
- `ref: 'authors'` a `ref: 'posts'` jsou metadata nápovědy — Store nevynucuje cizí klíče, ale dokumentují vztahy.
- `indexes: ['authorId', 'status']` na příspěvcích umožňuje rychlé vyhledávání jako `where({ authorId: '…' })` a `where({ status: 'published' })`.
- `indexes: ['postId']` na komentářích umožňuje rychlé vyhledávání jako `where({ postId: '…' })`.
- `ttl: '365d'` na komentářích znamená, že automaticky expirují po jednom roce — žádný čistící kód není potřeba.

</details>

## Shrnutí

- `defineBucket(name, definition)` vytváří kolekci se schématem, zajištěnou GenServer actorem
- Pole `key` identifikuje záznamy unikátně — po vložení je neměnné
- Klíče mohou být automaticky generovány pomocí `generated: 'uuid'`, `'cuid'`, `'autoincrement'` nebo `'timestamp'`
- Šest typů polí: `string`, `number`, `boolean`, `object`, `array`, `date`
- Omezení validují data při každém zápisu: `required`, `enum`, `default`, `generated`, `unique`, `min/max`, `minLength/maxLength`, `pattern`, `format`
- `ValidationError` sesbírá všechny problémy a nahlásí je společně — záznam se při selhání nikdy neuloží
- `unique: true` vynucuje unikátnost a vytváří automatický index
- Deklarujte `indexes` pro pole, podle kterých filtrujete, abyste získali O(1) vyhledávání místo úplného průchodu
- Každý bucket běží jako izolovaný actor pod Supervisorem se strategií restartu `one_for_one`
- `BucketHandle` je bezstavový proxy — vytváření handle je zdarma, všechna volání procházejí přes GenServer

---

Další: [CRUD operace](./03-crud-operace.md)
