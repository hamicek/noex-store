# Schema a typy — API reference

> Definice bucketů, typy polí, omezení, generované hodnoty, metadata záznamů a validace schématu.

## Přehled

Každý bucket v noex-store je definován pomocí `BucketDefinition`, který deklaruje primární klíč, typované schéma, volitelné indexy, TTL a limity velikosti. Schéma řídí automatickou validaci při každém vložení i aktualizaci — data, která porušují jakékoli omezení, jsou odmítnuta ještě před uložením.

Tento dokument pokrývá celý typový systém: `BucketDefinition`, `FieldDefinition` se všemi šesti typy polí a všemi omezeními, čtyři strategie generování hodnot, systémová metadata `RecordMeta` a třídu `SchemaValidator`, která orchestruje validaci.

## API

### `BucketDefinition`

Konfigurační objekt předávaný do `store.defineBucket(name, definition)`.

```typescript
interface BucketDefinition {
  readonly key: string;
  readonly schema: SchemaDefinition;
  readonly indexes?: readonly string[];
  readonly etsType?: EtsTableType;
  readonly persistent?: boolean;
  readonly ttl?: number | string;
  readonly maxSize?: number;
}
```

| Vlastnost | Typ | Povinné | Výchozí | Popis |
|-----------|-----|---------|---------|-------|
| `key` | `string` | Ano | — | Název pole primárního klíče. Musí odkazovat na pole definované ve `schema` |
| `schema` | [`SchemaDefinition`](#schemadefinition) | Ano | — | Definice polí s typy a omezeními |
| `indexes` | `readonly string[]` | Ne | `[]` | Pole k indexování pro rychlé vyhledávání. Každé musí odkazovat na pole ve `schema` |
| `etsType` | [`EtsTableType`](#etstabletype) | Ne | `'set'` | Typ úložné struktury. Ovlivňuje řazení a sémantiku unikátnosti klíčů |
| `persistent` | `boolean` | Ne | `true` (pokud má store persistenci) | Nastavte na `false` pro vyloučení tohoto bucketu z persistence |
| `ttl` | `number \| string` | Ne | `undefined` | Doba života záznamu. Číslo = milisekundy, řetězec = lidsky čitelný formát (`"1s"`, `"30m"`, `"1h"`, `"7d"`, `"90d"`) |
| `maxSize` | `number` | Ne | `undefined` | Maximální počet záznamů. Nejstarší záznamy (podle `_createdAt`) jsou odstraněny při přetečení |

**Příklad:**

```typescript
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 1 },
    email: { type: 'string', format: 'email', unique: true },
    role:  { type: 'string', enum: ['admin', 'member'], default: 'member' },
  },
  indexes: ['email', 'role'],
  ttl: '90d',
  maxSize: 50_000,
});
```

---

### `SchemaDefinition`

Záznam mapující názvy polí na objekty `FieldDefinition`. Definuje tvar a validační pravidla pro všechny záznamy v bucketu.

```typescript
type SchemaDefinition = Readonly<Record<string, FieldDefinition>>;
```

Pole, která nejsou deklarována ve schématu, procházejí bez validace. Pouze deklarovaná pole jsou typově kontrolována a omezována.

---

### `FieldDefinition`

Popisuje typ, omezení a strategii generování jednoho pole.

```typescript
interface FieldDefinition {
  readonly type: FieldType;
  readonly required?: boolean;
  readonly default?: unknown | (() => unknown);
  readonly generated?: GeneratedType;
  readonly enum?: readonly unknown[];
  readonly format?: FormatType;
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly ref?: string;
  readonly unique?: boolean;
}
```

| Vlastnost | Typ | Výchozí | Popis |
|-----------|-----|---------|-------|
| `type` | [`FieldType`](#fieldtype) | — | **Povinné.** Datový typ tohoto pole |
| `required` | `boolean` | `false` | Odmítne hodnoty `undefined` a `null` |
| `default` | `unknown \| (() => unknown)` | `undefined` | Statická hodnota nebo tovární funkce aplikovaná při vkládání, když pole chybí |
| `generated` | [`GeneratedType`](#generatedtype) | `undefined` | Automaticky generuje hodnotu pole při vložení |
| `enum` | `readonly unknown[]` | `undefined` | Omezí pole na pevnou množinu povolených hodnot |
| `format` | [`FormatType`](#formattype) | `undefined` | Vestavěný validátor formátu řetězce |
| `min` | `number` | `undefined` | Minimální hodnota (včetně) pro pole typu `number` |
| `max` | `number` | `undefined` | Maximální hodnota (včetně) pro pole typu `number` |
| `minLength` | `number` | `undefined` | Minimální délka řetězce |
| `maxLength` | `number` | `undefined` | Maximální délka řetězce |
| `pattern` | `string` | `undefined` | Regulární výraz pro řetězcová pole. Kompilován pomocí `new RegExp(pattern)` |
| `ref` | `string` | `undefined` | Metadata odkazující na název jiného bucketu. Za běhu se nevynucuje |
| `unique` | `boolean` | `false` | Vynucuje unikátnost napříč všemi záznamy. Automaticky vytvoří unikátní index |

---

## Typy polí

### `FieldType`

```typescript
type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date';
```

Validace typu běží před validací omezení. Pokud kontrola typu selže, kontroly omezení (enum, min, max atd.) se pro dané pole přeskočí.

| Typ | Přijímá | Odmítá |
|-----|--------|--------|
| `'string'` | `typeof value === 'string'` | Čísla, booleany, objekty, `null` |
| `'number'` | `typeof value === 'number'` kromě `NaN` | Řetězce, `NaN` |
| `'boolean'` | `true` nebo `false` | `0`, `1`, `'yes'`, `'false'` |
| `'object'` | Prosté objekty (`typeof === 'object'`, ne `null`, ne pole) | `null`, pole, primitivní typy |
| `'array'` | `Array.isArray(value)` | Prosté objekty, řetězce |
| `'date'` | Instance `Date` (s platným časem), čísla (timestampy), řetězce | Booleany, neplatné objekty `Date` |

**Příklad:**

```typescript
schema: {
  name:     { type: 'string' },
  age:      { type: 'number' },
  active:   { type: 'boolean' },
  settings: { type: 'object' },
  tags:     { type: 'array' },
  birthday: { type: 'date' },
}
```

---

## Omezení

Všechna omezení se kontrolují jak při `insert`, tak při `update`. Při aktualizaci store sloučí payload aktualizace s existujícím záznamem a poté validuje sloučený výsledek. Všechna porušení omezení se shromáždí — validátor se nezastaví při prvním selhání.

### `required`

Odmítne `undefined` a `null`. Prázdný řetězec `""` se považuje za přítomnou hodnotu.

```typescript
name: { type: 'string', required: true }
```

### `enum`

Omezuje hodnotu na pevnou množinu. Funguje s jakýmkoli typem pole.

```typescript
role: { type: 'string', enum: ['admin', 'member', 'guest'] }
severity: { type: 'number', enum: [1, 2, 3, 4, 5] }
```

### `min` / `max`

Inkluzivní číselné hranice. Aplikují se pouze na hodnoty typu `number`.

```typescript
price: { type: 'number', min: 0 }
rating: { type: 'number', min: 1, max: 5 }
```

### `minLength` / `maxLength`

Hranice délky řetězce. Aplikují se pouze na hodnoty typu `string`.

```typescript
name: { type: 'string', minLength: 1, maxLength: 100 }
```

### `pattern`

Validace regulárním výrazem pro řetězce. Kompilován pomocí `new RegExp(pattern)`. Použijte kotvy `^` a `$` pro shodu s celým řetězcem — bez kotev projde i částečná shoda.

```typescript
code: { type: 'string', pattern: '^[A-Z]{3}-\\d{4}$' }
```

### `format`

Vestavěné validátory formátu pro běžné tvary řetězců:

| Formát | Validuje | Příklad |
|--------|---------|---------|
| `'email'` | E-mailová adresa | `user@example.com` |
| `'url'` | URL adresa | `https://example.com` |
| `'iso-date'` | Datum ve formátu ISO-8601 | `2024-01-15` |

```typescript
email: { type: 'string', format: 'email' }
website: { type: 'string', format: 'url' }
birthday: { type: 'string', format: 'iso-date' }
```

### `unique`

Vynucuje unikátnost hodnoty napříč záznamy v rámci bucketu. Automaticky vytvoří unikátní index pro dané pole. Hodnoty `null` a `undefined` se neindexují — více záznamů může mít `null` pro unikátní pole.

```typescript
email: { type: 'string', unique: true }
```

**Vyhodí:** `UniqueConstraintError` při vložení nebo aktualizaci, když je detekována duplicitní hodnota.

### `ref`

Metadata odkazující na název jiného bucketu. Toto se za běhu **nevynucuje** — store nevaliduje cizí klíče. Slouží jako dokumentace vztahů mezi buckety.

```typescript
authorId: { type: 'string', ref: 'authors' }
```

### `default`

Aplikuje se, když je pole `undefined` během vkládání. Podporuje statické hodnoty i tovární funkce. Funkcionální výchozí hodnoty (`default: () => []`) by se měly používat pro mutable typy, aby se zabránilo sdíleným referencím mezi záznamy.

```typescript
// Statická výchozí hodnota
role: { type: 'string', default: 'member' }

// Funkcionální výchozí hodnota — nová instance pro každý záznam
tags: { type: 'array', default: () => [] }
settings: { type: 'object', default: () => ({ theme: 'light' }) }
```

---

## Generované typy

### `GeneratedType`

```typescript
type GeneratedType = 'uuid' | 'cuid' | 'autoincrement' | 'timestamp';
```

Pole s `generated` jsou automaticky vyplněna při vložení, pokud je hodnota `undefined`. Pokud je poskytnuta explicitní hodnota, generování se přeskočí. Generovaná pole jsou **odstraněna z payloadu aktualizace** — po vytvoření je nelze přepsat.

**Pořadí priority:** explicitní hodnota > generované > výchozí

| Strategie | Typ pole | Hodnota | Popis |
|-----------|---------|---------|-------|
| `'uuid'` | `string` | `'550e8400-e29b-41d4-a716-446655440000'` | UUID v4 dle RFC 4122, 128 náhodných bitů |
| `'cuid'` | `string` | `'c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'` | Odolné vůči kolizím, prefix `c` + 32 hexadecimálních znaků |
| `'autoincrement'` | `number` | `1`, `2`, `3`, ... | Sekvenční čítač pro bucket, začíná od 1 |
| `'timestamp'` | `number` | `1706745600000` | Aktuální čas přes `Date.now()`, unixové milisekundy |

**Příklad:**

```typescript
schema: {
  id:        { type: 'string', generated: 'uuid' },
  seq:       { type: 'number', generated: 'autoincrement' },
  createdAt: { type: 'number', generated: 'timestamp' },
}
```

> **Poznámka:** Každý záznam automaticky dostává metadata `_createdAt` a `_updatedAt`. Použijte `generated: 'timestamp'`, pokud potřebujete další timestamp pole na úrovni aplikace.

---

## Metadata záznamu

### `RecordMeta`

Systémová metadata automaticky spravovaná storem. Přítomna na každém uloženém záznamu.

```typescript
interface RecordMeta {
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
  readonly _expiresAt?: number;
}
```

| Vlastnost | Typ | Nastaveno při | Popis |
|-----------|-----|---------------|-------|
| `_version` | `number` | Insert: `1`, Update: `+1` | Číslo verze záznamu. Začíná na 1, zvýší se o 1 při každém `update()`. Používá se pro optimistické zamykání v transakcích |
| `_createdAt` | `number` | Insert | Unixový ms timestamp nastavený při prvním vložení záznamu |
| `_updatedAt` | `number` | Insert, Update | Unixový ms timestamp nastavený při vložení a aktualizovaný při každém `update()` |
| `_expiresAt` | `number \| undefined` | Insert (TTL buckety) | Unixový ms timestamp expirace záznamu. Nastaven na `_createdAt + ttlMs` pro buckety s nakonfigurovaným `ttl`. Nepřítomen u bucketů bez TTL |

Metadata pole nelze přepsat přes `update()` — jsou odstraněna z payloadu aktualizace a spravována interně.

### `StoreRecord`

Každý záznam uložený v bucketu je `StoreRecord` — uživatelsky definovaná pole sloučená s `RecordMeta`.

```typescript
type StoreRecord<T = Record<string, unknown>> = T & RecordMeta;
```

---

## Formátové typy

### `FormatType`

```typescript
type FormatType = 'email' | 'url' | 'iso-date';
```

Používá se s omezením `format` na `FieldDefinition`. Interně deleguje na utilitní funkce `isValidEmail()`, `isValidUrl()` a `isValidIsoDate()`.

---

## ETS typy tabulek

### `EtsTableType`

```typescript
type EtsTableType = 'set' | 'ordered_set' | 'bag' | 'duplicate_bag';
```

Řídí interní úložnou strukturu bucketu.

| Typ | Unikátnost klíče | Řazení | Popis |
|-----|-----------------|--------|-------|
| `'set'` | Unikátní klíče | Neseřazené | Výchozí. Jeden záznam na klíč, vyhledávání na bázi hashe |
| `'ordered_set'` | Unikátní klíče | Seřazené podle klíče | Záznamy jsou seřazeny podle primárního klíče. Umožňuje smysluplné `first()`, `last()` a stránkování přes `paginate()` na bázi kurzoru |
| `'bag'` | Duplicitní klíče povoleny | Neseřazené | Více záznamů může sdílet stejnou hodnotu klíče |
| `'duplicate_bag'` | Duplicitní klíče i hodnoty povoleny | Neseřazené | Umožňuje plně duplicitní záznamy |

---

## Schema Validator

### `SchemaValidator`

Interní třída, která zajišťuje validaci, aplikaci výchozích hodnot a populaci generovaných polí. Exportována z veřejného API pro pokročilé případy použití.

#### `new SchemaValidator(bucketName, schema, keyField)`

Vytvoří instanci validátoru svázanou s konkrétním schématem bucketu.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `bucketName` | `string` | Název bucketu (používá se v chybových zprávách) |
| `schema` | `SchemaDefinition` | Definice polí, vůči kterým se validuje |
| `keyField` | `string` | Název pole primárního klíče |

---

#### `validator.prepareInsert(input, autoincrementCounter): StoreRecord`

Připraví nový záznam k vložení. Provede čtyři kroky v tomto pořadí:

1. **Generování** hodnot pro pole s `generated`, které chybí ve vstupu
2. **Aplikace výchozích hodnot** pro pole, která jsou stále `undefined`
3. **Připojení metadat** — nastaví `_version: 1`, `_createdAt` a `_updatedAt` na aktuální timestamp
4. **Validace** kompletního záznamu vůči všem omezením schématu

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `input` | `Record<string, unknown>` | Uživatelem poskytnuté hodnoty polí |
| `autoincrementCounter` | `number` | Aktuální hodnota autoinkrementu pro tento bucket |

**Vrací:** `StoreRecord` — plně vyplněný a zvalidovaný záznam

**Vyhodí:** `ValidationError` — pokud jakékoli pole poruší svá omezení

---

#### `validator.prepareUpdate(existing, changes): StoreRecord`

Připraví aktualizaci existujícího záznamu. Provede čtyři kroky v tomto pořadí:

1. **Odstranění chráněných polí** — odebere `_version`, `_createdAt`, `_updatedAt`, primární klíč a všechna generovaná pole ze změn
2. **Sloučení** existujícího záznamu se sanitizovanými změnami
3. **Aktualizace metadat** — zvýší `_version` o 1, nastaví `_updatedAt` na aktuální timestamp
4. **Validace** sloučeného záznamu vůči všem omezením schématu

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `existing` | `StoreRecord` | Aktuální uložený záznam |
| `changes` | `Record<string, unknown>` | Pole k aktualizaci |

**Vrací:** `StoreRecord` — sloučený, zvalidovaný záznam

**Vyhodí:** `ValidationError` — pokud sloučený záznam poruší jakákoli omezení

---

## Validační chyby

### `ValidationError`

Vyhodí se, když jedno nebo více polí selže při validaci. Rozšiřuje `Error`. Shromáždí všechny problémy do jednoho vyhodení — validátor se nezastaví při prvním selhání.

```typescript
class ValidationError extends Error {
  readonly name: 'ValidationError';
  readonly issues: readonly ValidationIssue[];

  constructor(bucketName: string, issues: readonly ValidationIssue[]);
}
```

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `'ValidationError'` | Vždy `'ValidationError'` |
| `message` | `string` | Lidsky čitelný souhrn: `'Validation failed for bucket "users": name: Field is required; email: Invalid email format'` |
| `issues` | `readonly ValidationIssue[]` | Strukturované pole všech validačních selhání |

**Příklad:**

```typescript
import { ValidationError } from '@hamicek/noex-store';

try {
  await users.insert({ name: '', email: 'not-an-email', age: -5 });
} catch (err) {
  if (err instanceof ValidationError) {
    for (const issue of err.issues) {
      console.log(`[${issue.code}] ${issue.field}: ${issue.message}`);
    }
  }
}
```

---

### `ValidationIssue`

Jedno validační selhání v rámci `ValidationError`.

```typescript
interface ValidationIssue {
  readonly field: string;
  readonly message: string;
  readonly code: string;
}
```

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `field` | `string` | Název pole ze schématu, které selhalo |
| `message` | `string` | Lidsky čitelný popis selhání |
| `code` | `string` | Strojově čitelný chybový kód pro programové zpracování |

### Chybové kódy

| Kód | Spouštěč | Příklad |
|-----|----------|---------|
| `'required'` | Chybějící nebo `null` hodnota u povinného pole | `name` je `undefined` |
| `'type'` | Hodnota neodpovídá deklarovanému typu | Očekáván `string`, zadán `number` |
| `'enum'` | Hodnota není v povolené množině | `'premium'` není v `['basic', 'vip']` |
| `'min'` | Číslo pod minimem | `-1` s `min: 0` |
| `'max'` | Číslo nad maximem | `101` s `max: 100` |
| `'minLength'` | Řetězec kratší než minimum | `'A'` s `minLength: 2` |
| `'maxLength'` | Řetězec delší než maximum | `'ABCDE'` s `maxLength: 3` |
| `'pattern'` | Řetězec neodpovídá regulárnímu výrazu | `'ab1'` s `pattern: '^[A-Z]{3}$'` |
| `'format'` | Neplatný e-mail, URL nebo ISO datum | `'not-an-email'` s `format: 'email'` |

---

## Průběh validace

Validátor zpracovává každé pole ve schématu v pořadí:

1. **Kontrola `required`** — pokud je pole povinné a hodnota je `undefined` nebo `null`, přidá problém s kódem `'required'` a přeskočí zbývající kontroly pro toto pole
2. **Kontrola nepřítomnosti** — pokud je hodnota `undefined` nebo `null`, ale pole není povinné, přeskočí všechny zbývající kontroly pro toto pole
3. **Kontrola typu** — pokud hodnota neodpovídá deklarovanému `type`, přidá problém s kódem `'type'` a přeskočí zbývající kontroly pro toto pole
4. **Kontroly omezení** — kontroluje `enum`, `min`, `max`, `minLength`, `maxLength`, `pattern` a `format`. Každé selhání přidá svůj vlastní problém

Po zpracování všech polí, pokud byly shromážděny jakékoli problémy, vyhodí `ValidationError` se všemi najednou.

---

## Viz také

- [Store API](./store.md) — `store.defineBucket()`, `Store.start()` a `StoreOptions`
- [BucketHandle API](./bucket-handle.md) — `insert()`, `update()` a další operace spouštějící validaci
- [Reaktivní dotazy](./reactive-queries.md) — dotazy pouze pro čtení přistupující k datům bucketu
- [Transakce](./transactions.md) — transakční kontext se stejnými validačními pravidly
- [Události](./events.md) — události emitované po úspěšném vložení, aktualizaci a smazání
- [TTL a životní cyklus](./ttl-lifecycle.md) — syntaxe doby TTL a metadata `_expiresAt`
- [Chyby](./errors.md) — `ValidationError`, `UniqueConstraintError` a další chybové třídy
- [Utility funkce](./utilities.md) — `generateUuid()`, `generateCuid()`, `isValidEmail()` a další funkce používané validátorem
- **Výuka:** [Buckety a schémata](../learn/02-zaciname/02-buckety-a-schemata.md) — úvod do definice bucketů krok za krokem
- **Výuka:** [Omezení polí](../learn/03-schema-validace/01-omezeni-poli.md) — tutoriál ke všem typům omezení s cvičeními
- **Výuka:** [Automatické generování](../learn/03-schema-validace/02-automaticke-generovani.md) — generované typy a výchozí hodnoty vysvětleny
- **Výuka:** [Unikátní omezení](../learn/03-schema-validace/03-unikatni-omezeni.md) — vynucování unikátnosti a `UniqueConstraintError`
- **Zdrojový kód:** [`src/types/schema.ts`](../../../src/types/schema.ts), [`src/types/record.ts`](../../../src/types/record.ts), [`src/core/schema-validator.ts`](../../../src/core/schema-validator.ts)
