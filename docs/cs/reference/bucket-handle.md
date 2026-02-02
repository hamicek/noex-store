# BucketHandle API reference

> Fluent, bezstavový proxy pro CRUD operace, filtrování, kurzorovou paginaci a agregace nad jedním bucketem.

## Přehled

`BucketHandle` je primární rozhraní pro čtení a zápis dat v bucketu. Získáte jej voláním `store.bucket(name)` -- drží pouze název bucketu a interní referenci na aktéra, takže vytváření handleů je prakticky zadarmo.

Každá metoda deleguje na podkladového aktéra `BucketServer` prostřednictvím `GenServer.call`, což znamená, že všechny operace jsou serializovány na úrovni bucketu a lze je bezpečně volat souběžně z různých částí vaší aplikace.

## API

### `handle.name: string`

Vlastnost pouze pro čtení. Vrací název bucketu, na který tento handle ukazuje.

**Příklad:**

```typescript
const users = store.bucket('users');
console.log(users.name); // "users"
```

---

### CRUD metody

#### `handle.insert(data): Promise<StoreRecord>`

Vloží nový záznam do bucketu. Data jsou validována oproti schématu bucketu, aplikují se výchozí hodnoty, vygenerují se automatická pole a metadata záznamu (`_version`, `_createdAt`, `_updatedAt`) se nastaví automaticky.

Pokud má bucket nakonfigurované TTL a záznam ještě nemá `_expiresAt`, nastaví se na `_createdAt + ttlMs`. Pokud má bucket nastavenou `maxSize` a je na plné kapacitě, nejstarší záznam (podle `_createdAt`) je před vložením odstraněn.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `data` | `Record<string, unknown>` | — | Hodnoty polí pro nový záznam. Generovaná a výchozí pole mohou být vynechána |

**Vrací:** `Promise<StoreRecord>` -- plně naplněný záznam včetně generovaných polí a metadat

**Vyhazuje:**

- `ValidationError` -- data porušují omezení schématu (povinná pole, enum, min/max, formát atd.)
- `UniqueConstraintError` -- hodnota unikátně indexovaného pole již v bucketu existuje

**Příklad:**

```typescript
const users = store.bucket('users');

const record = await users.insert({ name: 'Alice', email: 'alice@example.com' });
// record.id       → "a1b2c3d4-..." (generované UUID)
// record.role     → "member"        (výchozí ze schématu)
// record._version → 1
```

---

#### `handle.get(key): Promise<StoreRecord | undefined>`

Načte jeden záznam podle jeho primárního klíče. Vrací `undefined`, pokud záznam s daným klíčem neexistuje. Jedná se o vyhledávání v O(1).

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `key` | `unknown` | — | Hodnota primárního klíče |

**Vrací:** `Promise<StoreRecord | undefined>`

**Příklad:**

```typescript
const user = await users.get('a1b2c3d4-...');
if (user) {
  console.log(user.name);
}
```

---

#### `handle.update(key, changes): Promise<StoreRecord>`

Provede částečnou aktualizaci existujícího záznamu. Změní se pouze zadaná pole -- ostatní si zachovají své aktuální hodnoty. `_version` se zvýší o 1 a `_updatedAt` se nastaví na aktuální časové razítko. Změny jsou validovány oproti schématu.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `key` | `unknown` | — | Primární klíč záznamu k aktualizaci |
| `changes` | `Record<string, unknown>` | — | Pole ke změně |

**Vrací:** `Promise<StoreRecord>` -- aktualizovaný záznam

**Vyhazuje:**

- `Error` -- záznam s daným klíčem neexistuje
- `ValidationError` -- změny porušují omezení schématu
- `UniqueConstraintError` -- hodnota unikátně indexovaného pole již existuje

**Příklad:**

```typescript
const updated = await users.update('a1b2c3d4-...', { name: 'Bob', role: 'admin' });
// updated._version → 2
```

---

#### `handle.delete(key): Promise<void>`

Odstraní záznam podle jeho primárního klíče. Pokud záznam s daným klíčem neexistuje, volání se tiše ignoruje.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `key` | `unknown` | — | Primární klíč záznamu k odstranění |

**Vrací:** `Promise<void>`

**Příklad:**

```typescript
await users.delete('a1b2c3d4-...');
```

---

#### `handle.clear(): Promise<void>`

Odstraní všechny záznamy z bucketu a vymaže všechny indexy.

**Vrací:** `Promise<void>`

**Příklad:**

```typescript
await users.clear();
const count = await users.count(); // 0
```

---

#### `handle.all(): Promise<StoreRecord[]>`

Vrátí všechny záznamy v bucketu jako pole. Pořadí není zaručeno, pokud bucket nepoužívá `etsType: 'ordered_set'`.

**Vrací:** `Promise<StoreRecord[]>`

**Příklad:**

```typescript
const allUsers = await users.all();
console.log(`Total: ${allUsers.length}`);
```

---

### Dotazovací metody

#### `handle.where(filter): Promise<StoreRecord[]>`

Vrátí všechny záznamy odpovídající filtru. Filtr používá striktní rovnost (`===`) s logikou AND -- záznam musí odpovídat každému poli v objektu filtru.

Pokud má některé pole filtru sekundární index, dotaz použije index pro O(1) vyhledávání místo plného průchodu tabulkou. Zbývající (neindexovaná) pole se kontrolují oproti zúžené množině kandidátů.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `filter` | `Record<string, unknown>` | — | Páry klíč-hodnota k porovnání. Všechny musí být splněny (AND) |

**Vrací:** `Promise<StoreRecord[]>` -- odpovídající záznamy, nebo prázdné pole, pokud nic neodpovídá

**Příklad:**

```typescript
const admins = await users.where({ role: 'admin' });
const specific = await users.where({ role: 'admin', name: 'Alice' });
```

---

#### `handle.findOne(filter): Promise<StoreRecord | undefined>`

Vrátí první záznam odpovídající filtru, nebo `undefined`, pokud žádný záznam neodpovídá. Používá stejné indexem urychlené vyhledávání jako `where()`.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `filter` | `Record<string, unknown>` | — | Páry klíč-hodnota k porovnání |

**Vrací:** `Promise<StoreRecord | undefined>`

**Příklad:**

```typescript
const alice = await users.findOne({ email: 'alice@example.com' });
```

---

#### `handle.count(filter?): Promise<number>`

Vrátí počet záznamů v bucketu. Při volání bez filtru vrací celkový počet v O(1). S filtrem počítá pouze odpovídající záznamy.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr. Vynechte pro celkový počet |

**Vrací:** `Promise<number>`

**Příklad:**

```typescript
const total = await users.count();
const adminCount = await users.count({ role: 'admin' });
```

---

#### `handle.first(n): Promise<StoreRecord[]>`

Vrátí prvních `n` záznamů. U `ordered_set` bucketů jsou záznamy řazeny podle primárního klíče. U běžných `set` bucketů odpovídá pořadí pořadí vkládání. Pokud `n` přesahuje počet záznamů, vrátí se všechny záznamy.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `n` | `number` | — | Maximální počet vrácených záznamů |

**Vrací:** `Promise<StoreRecord[]>`

**Příklad:**

```typescript
const top5 = await products.first(5);
```

---

#### `handle.last(n): Promise<StoreRecord[]>`

Vrátí posledních `n` záznamů. U `ordered_set` bucketů jsou záznamy řazeny podle primárního klíče. Pokud `n` přesahuje počet záznamů, vrátí se všechny záznamy.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `n` | `number` | — | Maximální počet vrácených záznamů |

**Vrací:** `Promise<StoreRecord[]>`

**Příklad:**

```typescript
const latest3 = await orders.last(3);
```

---

### Paginace

#### `handle.paginate(options): Promise<PaginatedResult>`

Kurzorová paginace. Vrátí stránku záznamů počínaje za daným kurzorem (primárním klíčem). U `ordered_set` bucketů jsou záznamy řazeny podle primárního klíče. Použijte vrácený `nextCursor` jako hodnotu `after` pro další stránku.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `options` | [`PaginateOptions`](#paginateoptions) | — | Kurzor paginace a velikost stránky |

**Vrací:** `Promise<`[`PaginatedResult`](#paginatedresult)`>`

**Příklad:**

```typescript
// První stránka
const page1 = await products.paginate({ limit: 10 });

// Další stránka
if (page1.hasMore) {
  const page2 = await products.paginate({ after: page1.nextCursor, limit: 10 });
}

// Procházení všech stránek
let cursor: unknown;
let hasMore = true;

while (hasMore) {
  const page = await products.paginate({ after: cursor, limit: 20 });
  for (const record of page.records) {
    // zpracování záznamu
  }
  cursor = page.nextCursor;
  hasMore = page.hasMore;
}
```

---

### Agregační metody

Všechny agregační metody pracují pouze s číselnými poli. Nečíselné hodnoty v cílovém poli jsou tiše přeskočeny. Každá metoda přijímá volitelný filtr pro zúžení záznamů před agregací.

#### `handle.sum(field, filter?): Promise<number>`

Vrátí součet číselného pole přes všechny (nebo filtrované) záznamy. Pro prázdnou výsledkovou sadu vrací `0`.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `field` | `string` | — | Název číselného pole k součtu |
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr pro zúžení záznamů |

**Vrací:** `Promise<number>`

**Příklad:**

```typescript
const totalRevenue = await orders.sum('amount');
const vipRevenue = await orders.sum('amount', { tier: 'vip' });
```

---

#### `handle.avg(field, filter?): Promise<number>`

Vrátí aritmetický průměr číselného pole. Pro prázdnou výsledkovou sadu nebo pokud žádné hodnoty nejsou číselné, vrací `0`.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `field` | `string` | — | Název číselného pole |
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr |

**Vrací:** `Promise<number>`

**Příklad:**

```typescript
const avgScore = await students.avg('score');
```

---

#### `handle.min(field, filter?): Promise<number | undefined>`

Vrátí minimální hodnotu číselného pole. Pro prázdnou výsledkovou sadu nebo pokud žádné hodnoty nejsou číselné, vrací `undefined`.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `field` | `string` | — | Název číselného pole |
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr |

**Vrací:** `Promise<number | undefined>`

**Příklad:**

```typescript
const cheapest = await products.min('price');
```

---

#### `handle.max(field, filter?): Promise<number | undefined>`

Vrátí maximální hodnotu číselného pole. Pro prázdnou výsledkovou sadu nebo pokud žádné hodnoty nejsou číselné, vrací `undefined`.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `field` | `string` | — | Název číselného pole |
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr |

**Vrací:** `Promise<number | undefined>`

**Příklad:**

```typescript
const highest = await scores.max('points');
const highestVip = await scores.max('points', { tier: 'vip' });
```

---

## Typy

### `StoreRecord`

Každý záznam uložený v bucketu je `StoreRecord` -- uživatelsky definovaná pole sloučená s `RecordMeta`.

```typescript
type StoreRecord<T = Record<string, unknown>> = T & RecordMeta;
```

### `RecordMeta`

Systémová metadata automaticky spravovaná storem. Přítomna na každém záznamu.

```typescript
interface RecordMeta {
  readonly _version: number;     // Začíná na 1, zvýší se o 1 při každém update
  readonly _createdAt: number;   // Unix ms timestamp, nastaven při insert
  readonly _updatedAt: number;   // Unix ms timestamp, nastaven při insert a každém update
  readonly _expiresAt?: number;  // Unix ms timestamp, nastaven pro buckety s TTL
}
```

---

### `PaginateOptions`

Volby pro kurzorovou paginaci.

```typescript
interface PaginateOptions {
  readonly after?: unknown;  // Začít za tímto primárním klíčem (kurzor). Vynechte pro první stránku
  readonly limit: number;    // Maximální počet vrácených záznamů
}
```

| Vlastnost | Typ | Výchozí | Popis |
|-----------|-----|---------|-------|
| `after` | `unknown` | `undefined` | Kurzor primárního klíče. Vynechte pro začátek od začátku |
| `limit` | `number` | — | Maximální počet záznamů na stránku |

---

### `PaginatedResult`

Výsledek volání `paginate()`.

```typescript
interface PaginatedResult {
  readonly records: StoreRecord[];       // Záznamy na této stránce
  readonly hasMore: boolean;             // Zda existují další záznamy za touto stránkou
  readonly nextCursor: unknown | undefined;  // Primární klíč posledního záznamu. Předejte jako `after` pro další stránku
}
```

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `records` | `StoreRecord[]` | Záznamy na aktuální stránce |
| `hasMore` | `boolean` | `true`, pokud za touto stránkou existují další záznamy |
| `nextCursor` | `unknown \| undefined` | Primární klíč posledního vráceného záznamu. `undefined`, pokud nebyly vráceny žádné záznamy |

## Viz také

- [Store API](./store.md) -- `store.bucket()`, `store.defineBucket()` a životní cyklus storu
- [Schéma a typy](./schema.md) -- `BucketDefinition`, typy polí, omezení a validace
- [Reaktivní dotazy](./reactive-queries.md) -- `QueryBucket` poskytuje podmnožinu stejného API pouze pro čtení uvnitř dotazů
- [Transakce](./transactions.md) -- `TransactionBucketHandle` obaluje stejné operace s transakčním bufferováním
- [Události](./events.md) -- události emitované operacemi `insert`, `update` a `delete`
- [TTL a životní cyklus](./ttl-lifecycle.md) -- expirace TTL a chování evikce `maxSize`
- [Chyby](./errors.md) -- `ValidationError`, `UniqueConstraintError` a další třídy chyb
- **Výuka:** [CRUD operace](../learn/02-zaciname/03-crud-operace.md) -- podrobný tutoriál pro insert, get, update, delete
- **Výuka:** [Filtrování a vyhledávání](../learn/04-dotazovani/01-filtrovani-a-vyhledavani.md) -- where, findOne, count s příklady
- **Výuka:** [Sekundární indexy](../learn/04-dotazovani/02-sekundarni-indexy.md) -- jak indexy urychlují dotazy
- **Výuka:** [Paginace a agregace](../learn/04-dotazovani/03-paginace-a-agregace.md) -- kurzorová paginace a sum/avg/min/max
- **Zdrojový kód:** [`src/core/bucket-handle.ts`](../../../src/core/bucket-handle.ts)
