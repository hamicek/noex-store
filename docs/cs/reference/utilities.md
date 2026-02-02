# Reference API utilit

> Generátory ID, validátory formátů, parsování TTL a deep equality — samostatné pomocné funkce exportované balíčkem.

## Přehled

noex-store exportuje sadu pomocných funkcí, které podporují funkce schématu (generovaná pole, validace formátů, parsování TTL) a lze je používat i samostatně. Všechny veřejné utility jsou dostupné z hlavního vstupního bodu `@hamicek/noex-store`. Funkce `deepEqual` je používána interně systémem reaktivních dotazů a není součástí veřejného API.

## Import

```typescript
import {
  generateUuid,
  generateCuid,
  generateTimestamp,
  isValidEmail,
  isValidUrl,
  isValidIsoDate,
  parseTtl,
} from '@hamicek/noex-store';
```

---

## Generátory ID

### `generateUuid(): string`

Generuje náhodný UUID v4 řetězec pomocí Node.js `crypto.randomUUID()`.

**Vrací:** `string` — standardní UUID v4 (např. `"550e8400-e29b-41d4-a716-446655440000"`).

Toto je funkce používaná interně, když má pole nastaveno `generated: 'uuid'`.

**Příklad:**

```typescript
const id = generateUuid();
// '550e8400-e29b-41d4-a716-446655440000'
```

---

### `generateCuid(): string`

Generuje identifikátor ve stylu CUID: prefix `c` následovaný 32 hexadecimálními znaky (16 náhodných bajtů).

**Vrací:** `string` — CUID řetězec (např. `"c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6"`).

Toto je funkce používaná interně, když má pole nastaveno `generated: 'cuid'`.

**Příklad:**

```typescript
const id = generateCuid();
// 'c' + 32 hex znaků, např. 'c4f8a2e1b9c0d3f5a6b7c8d9e0f1a2b3'
```

---

### `generateTimestamp(): number`

Vrací aktuální Unix timestamp v milisekundách.

**Vrací:** `number` — `Date.now()`.

Toto je funkce používaná interně, když má pole nastaveno `generated: 'timestamp'`.

**Příklad:**

```typescript
const ts = generateTimestamp();
// 1700000000000
```

---

## Validátory formátů

Tyto funkce používá `SchemaValidator`, když má pole omezení `format`. Lze je také použít samostatně pro validaci mimo definice schématu.

### `isValidEmail(value): boolean`

Testuje, zda řetězec vypadá jako platná e-mailová adresa. Používá jednoduchý regex, který kontroluje přítomnost znaků bez mezer kolem `@` a tečky v doménové části.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `value` | `string` | Řetězec k validaci |

**Vrací:** `boolean` — `true`, pokud hodnota odpovídá vzoru e-mailu.

**Vzor:** `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`

Jedná se o základní strukturální kontrolu, nikoli o plnou validaci dle RFC 5322. Ověřuje přítomnost `@`, doménové části a oddělovače TLD.

**Příklad:**

```typescript
isValidEmail('user@example.com');   // true
isValidEmail('a@b.c');              // true
isValidEmail('user@');              // false
isValidEmail('user@example');       // false
isValidEmail('user @example.com');  // false (mezera)
```

---

### `isValidUrl(value): boolean`

Testuje, zda je řetězec platná URL adresa pokusem o vytvoření objektu `URL`. Deleguje zcela na WHATWG URL parser zabudovaný v Node.js.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `value` | `string` | Řetězec k validaci |

**Vrací:** `boolean` — `true`, pokud lze hodnotu naparsovat jako URL.

**Příklad:**

```typescript
isValidUrl('https://example.com');           // true
isValidUrl('http://localhost:3000/api');      // true
isValidUrl('ftp://files.example.com/doc');   // true
isValidUrl('not-a-url');                     // false
isValidUrl('');                              // false
```

---

### `isValidIsoDate(value): boolean`

Testuje, zda je řetězec platné datum ve formátu ISO 8601 (pouze datum nebo datum s časem). Provádí tři úrovně validace:

1. **Kontrola regexem** — ověřuje, že řetězec strukturálně odpovídá formátu ISO data.
2. **Kontrola parsováním** — ověřuje, že `new Date(value)` vytvoří platné datum (nikoli `NaN`).
3. **Kontrola zpětným převodem** — ověřuje, že naparsované datum odpovídá vstupu, čímž zachytí data jako `2024-02-30`, která JavaScript tiše upraví na `2024-03-01`.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `value` | `string` | Řetězec k validaci |

**Vrací:** `boolean` — `true`, pokud je hodnota platné, chronologicky reálné ISO datum.

**Akceptované formáty:**

| Formát | Příklad |
|--------|---------|
| Pouze datum | `2024-01-15` |
| Datum + čas (UTC) | `2024-01-15T10:30:00Z` |
| Datum + čas (offset) | `2024-01-15T10:30:00+02:00` |
| Datum + čas (zlomky sekund) | `2024-01-15T10:30:00.123Z` |

**Příklad:**

```typescript
isValidIsoDate('2024-01-15');               // true
isValidIsoDate('2024-01-15T10:30:00Z');     // true
isValidIsoDate('2024-01-15T10:30:00.123Z'); // true
isValidIsoDate('2024-01-15T10:30:00+02:00'); // true
isValidIsoDate('2024-02-29');               // true  (2024 je přestupný rok)
isValidIsoDate('2023-02-29');               // false (2023 není přestupný rok)
isValidIsoDate('2024-02-30');               // false (únor nikdy nemá 30 dní)
isValidIsoDate('2024-13-01');               // false (měsíc 13)
isValidIsoDate('not-a-date');               // false
isValidIsoDate('');                         // false
```

---

## Parsování TTL

### `parseTtl(ttl): number`

Převádí hodnotu TTL na milisekundy. Přijímá buď číslo (již v milisekundách), nebo lidsky čitelný řetězec s příponou jednotky.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `ttl` | `number \| string` | TTL jako milisekundy (číslo) nebo řetězec doby trvání (`"30s"`, `"5m"`, `"1h"`, `"7d"`) |

**Vrací:** `number` — TTL v milisekundách.

**Vyhazuje:** `Error` — pokud hodnota není kladná, není konečná nebo je formát řetězce nerozpoznaný.

**Syntaxe řetězce doby trvání:** `<hodnota><jednotka>` — hodnota může být celé číslo nebo desetinné číslo, volitelná mezera před jednotkou.

| Jednotka | Přípona | Násobitel | Příklady |
|----------|---------|-----------|----------|
| Sekundy | `s` | 1 000 ms | `"30s"`, `"2.5s"` |
| Minuty | `m` | 60 000 ms | `"5m"`, `"1.5m"` |
| Hodiny | `h` | 3 600 000 ms | `"1h"`, `"0.5h"` |
| Dny | `d` | 86 400 000 ms | `"7d"`, `"90d"` |

**Příklad:**

```typescript
parseTtl(5000);     // 5000
parseTtl('30s');    // 30000
parseTtl('5m');     // 300000
parseTtl('1h');     // 3600000
parseTtl('7d');     // 604800000
parseTtl('1.5h');   // 5400000
parseTtl('30 m');   // 1800000  (mezera je povolena)
```

**Chybové případy:**

```typescript
parseTtl(0);         // Error: TTL must be a positive finite number, got 0
parseTtl(-100);      // Error: TTL must be a positive finite number, got -100
parseTtl(Infinity);  // Error: TTL must be a positive finite number, got Infinity
parseTtl('');        // Error: Invalid TTL format ""
parseTtl('fast');    // Error: Invalid TTL format "fast"
parseTtl('10w');     // Error: Invalid TTL format "10w" (týdny nejsou podporovány)
```

---

## Deep equality (interní)

### `deepEqual(a, b): boolean`

Provádí hluboké strukturální porovnání rovnosti. Používá se interně v `QueryManager` k určení, zda se výsledek reaktivního dotazu skutečně změnil, než budou notifikováni odběratelé.

> **Není součástí veřejného API.** Tato funkce není exportována z hlavního vstupního bodu `@hamicek/noex-store`. Je zde zdokumentována pro úplnost, protože řídí chování diffingu reaktivních dotazů.

**Parametry:**

| Parametr | Typ | Popis |
|----------|-----|-------|
| `a` | `unknown` | První hodnota |
| `b` | `unknown` | Druhá hodnota |

**Vrací:** `boolean` — `true`, pokud jsou obě hodnoty strukturálně identické.

**Pravidla porovnání:**

| Typ | Metoda porovnání |
|-----|-------------------|
| Primitivní typy | Striktní rovnost (`===`) |
| `NaN` | `NaN === NaN` je `true` (na rozdíl od standardního JS) |
| `Date` | Porovnání přes `getTime()` |
| `RegExp` | Porovnání `source` + `flags` |
| `Array` | Kontrola délky + rekurzivní porovnání prvků |
| Prosté objekty | Kontrola počtu klíčů + rekurzivní porovnání hodnot (pouze vlastní vlastnosti) |
| Ostatní typy | Vždy `false` (Map, Set, instance tříd atd.) |

„Prostý objekt" je takový, jehož prototyp je `Object.prototype` nebo `null`.

**Příklad:**

```typescript
// Interně používáno — ekvivalentní chování:
deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] });  // true
deepEqual({ a: 1 }, { a: 2 });                          // false
deepEqual(NaN, NaN);                                     // true
deepEqual(new Date('2024-01-01'), new Date('2024-01-01')); // true
deepEqual([1, 2, 3], [1, 2, 3]);                         // true
deepEqual([1, 2], [1, 2, 3]);                            // false
```

---

## Integrace se schématem

Pomocné funkce přímo odpovídají funkcím schématu:

| Funkce schématu | Utility funkce | Konfigurace schématu |
|-----------------|----------------|----------------------|
| Generování UUID | `generateUuid()` | `{ generated: 'uuid' }` |
| Generování CUID | `generateCuid()` | `{ generated: 'cuid' }` |
| Generování timestampu | `generateTimestamp()` | `{ generated: 'timestamp' }` |
| Validace e-mailu | `isValidEmail()` | `{ format: 'email' }` |
| Validace URL | `isValidUrl()` | `{ format: 'url' }` |
| Validace ISO data | `isValidIsoDate()` | `{ format: 'iso-date' }` |
| Parsování TTL | `parseTtl()` | `BucketDefinition.ttl` |

`SchemaValidator` volá tyto funkce automaticky při operacích `insert` a `update`. Přímo je potřebujete volat pouze při práci mimo systém schémat store.

**Příklad — použití validátorů mimo store:**

```typescript
import { isValidEmail, parseTtl, generateUuid } from '@hamicek/noex-store';

// Validace uživatelského vstupu před předáním do storu
if (!isValidEmail(userInput.email)) {
  throw new Error('Invalid email address');
}

// Převod TTL konfigurace pro externí použití
const cacheMs = parseTtl('5m');
setTimeout(cleanup, cacheMs);

// Generování ID pro externí systémy
const correlationId = generateUuid();
```

---

## Viz také

- [Schéma a typy](./schema.md) — `FieldDefinition.generated`, `FieldDefinition.format` a `SchemaValidator`, který tyto utility používá
- [TTL a životní cyklus](./ttl-lifecycle.md) — `parseTtl()` v kontextu konfigurace TTL bucketu
- [Reaktivní dotazy](./reactive-queries.md) — deep equality diffing, který zabraňuje zbytečným notifikacím odběratelů
- **Výuka:** [Buckety a schémata](../learn/02-zaciname/02-buckety-a-schemata.md) — definice schématu s generovanými poli a validací formátů
- **Výuka:** [TTL expirace](../learn/09-ttl-zivotni-cyklus/01-ttl-expirace.md) — syntaxe doby trvání TTL v praxi
- **Zdrojový kód:** [`src/utils/id-generator.ts`](../../../src/utils/id-generator.ts)
- **Zdrojový kód:** [`src/utils/format-validators.ts`](../../../src/utils/format-validators.ts)
- **Zdrojový kód:** [`src/utils/parse-ttl.ts`](../../../src/utils/parse-ttl.ts)
- **Zdrojový kód:** [`src/utils/deep-equal.ts`](../../../src/utils/deep-equal.ts)
