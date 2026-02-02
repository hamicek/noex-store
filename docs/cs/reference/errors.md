# Chybové třídy — API reference

> Kompletní katalog všech chybových tříd knihovny `@hamicek/noex-store` — podmínky vyvolání, vlastnosti a doporučené vzory ošetření.

## Přehled

Všechny chybové třídy dědí z nativní třídy `Error` a nesou kontextové read-only vlastnosti (název bucketu, název pole apod.), které umožňují programově reagovat bez parsování textové zprávy. Každá chyba nastavuje popisnou vlastnost `name`, takže spolehlivě fungují jak kontroly přes `instanceof`, tak serializovaná jména chyb.

```typescript
import {
  ValidationError,
  UniqueConstraintError,
  BucketAlreadyExistsError,
  BucketNotDefinedError,
  TransactionConflictError,
  QueryAlreadyDefinedError,
  QueryNotDefinedError,
} from '@hamicek/noex-store';
```

## Rychlý přehled

| Třída chyby | Podmínka vyvolání | Klíčové vlastnosti |
|-------------|-------------------|--------------------|
| [`ValidationError`](#validationerror) | Porušení schématického omezení při insert/update | `issues` |
| [`UniqueConstraintError`](#uniqueconstrainterror) | Duplicitní hodnota v poli s unikátním indexem | `bucket`, `field`, `value` |
| [`BucketAlreadyExistsError`](#bucketalreadyexistserror) | Volání `defineBucket()` s duplicitním názvem | `bucket` |
| [`BucketNotDefinedError`](#bucketnotdefinederror) | Volání `bucket()` nebo `dropBucket()` pro neznámý název | `bucket` |
| [`TransactionConflictError`](#transactionconflicterror) | Konflikt optimistic locking při commitu transakce | `bucket`, `key`, `field` |
| [`QueryAlreadyDefinedError`](#queryalreadydefinederror) | Volání `defineQuery()` s duplicitním názvem | `query` |
| [`QueryNotDefinedError`](#querynotdefinederror) | Volání `subscribe()` nebo `runQuery()` pro neznámý dotaz | `query` |

---

## ValidationError

Vyvolána, když data předaná do `insert()` nebo `update()` porušují jedno nebo více schématických omezení. Všechna porušení se shromáždí do jediné chyby, aby je bylo možné zobrazit najednou (např. ve formuláři).

**Hierarchie:** `ValidationError` → `Error`

**Zdrojový kód:** [`src/core/schema-validator.ts`](../../../src/core/schema-validator.ts)

### Vlastnosti

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `'ValidationError'` | Název chyby pro identifikaci bez `instanceof` |
| `message` | `string` | Čitelný souhrn: `Validation failed for bucket "<name>": field1: msg; field2: msg` |
| `issues` | `readonly ValidationIssue[]` | Strukturovaný seznam všech porušení omezení |

### ValidationIssue

```typescript
interface ValidationIssue {
  readonly field: string;   // Pole schématu, které neprošlo validací
  readonly message: string; // Čitelný popis chyby
  readonly code: string;    // Strojově čitelný kód pro programové zpracování
}
```

**Validační kódy:**

| Kód | Omezení | Příklad zprávy |
|-----|---------|----------------|
| `required` | `required: true` | `Field is required` |
| `type` | `type: 'string'` etc. | `Expected type "string", got number` |
| `enum` | `enum: [...]` | `Value must be one of: active, inactive` |
| `minLength` | `minLength: N` | `Minimum length is 3` |
| `maxLength` | `maxLength: N` | `Maximum length is 100` |
| `pattern` | `pattern: '...'` | `Value must match pattern "^[A-Z]+"` |
| `format` | `format: 'email'` etc. | `Invalid email format` |
| `min` | `min: N` | `Minimum value is 0` |
| `max` | `max: N` | `Maximum value is 100` |

### Kdy je vyvolána

- **`bucket.insert(data)`** — po vygenerování polí a aplikaci výchozích hodnot se celý záznam zvaliduje proti schématu.
- **`bucket.update(key, changes)`** — změny se sloučí s existujícím záznamem a výsledek se zvaliduje.
- **`tx.bucket(name).insert(data)`** / **`tx.bucket(name).update(key, changes)`** — uvnitř transakcí platí stejná pravidla.

Více porušení omezení na jednom záznamu se shromáždí do jediné `ValidationError`.

### Příklad — vyvolání chyby

```typescript
store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 2 },
    email: { type: 'string', required: true, format: 'email' },
    age:   { type: 'number', min: 0, max: 150 },
  },
});

const users = store.bucket('users');

// Chybějící povinná pole + neplatný formát
await users.insert({ name: '', email: 'not-an-email', age: -5 });
// Vyvolá ValidationError se 3 problémy:
//   name:  "Minimum length is 2"  (kód: 'minLength')
//   email: "Invalid email format"  (kód: 'format')
//   age:   "Minimum value is 0"    (kód: 'min')
```

### Doporučené ošetření

```typescript
try {
  await users.insert(input);
} catch (err) {
  if (err instanceof ValidationError) {
    // Zobrazit všechny problémy, např. namapovat na chyby formulářových polí
    for (const issue of err.issues) {
      console.error(`${issue.field}: ${issue.message} [${issue.code}]`);
    }
    return;
  }
  throw err;
}
```

---

## UniqueConstraintError

Vyvolána, když by `insert()` nebo `update()` vytvořil duplicitní hodnotu v poli s unikátním indexem.

**Hierarchie:** `UniqueConstraintError` → `Error`

**Zdrojový kód:** [`src/core/store.ts`](../../../src/core/store.ts) (definice) / [`src/core/index-manager.ts`](../../../src/core/index-manager.ts) (vyvolání)

### Vlastnosti

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `'UniqueConstraintError'` | Název chyby |
| `message` | `string` | `Unique constraint violation in bucket "<bucket>": field "<field>" already has value "<value>"` |
| `bucket` | `string` | Bucket, ve kterém ke konfliktu došlo |
| `field` | `string` | Pole s unikátním omezením |
| `value` | `unknown` | Konfliktní hodnota |

### Kdy je vyvolána

- **`bucket.insert(data)`** — hodnota pole s unikátním indexem již existuje v jiném záznamu.
- **`bucket.update(key, changes)`** — aktualizovaná hodnota pole s unikátním indexem již existuje v jiném záznamu.
- **Commit transakce** — stejná pravidla, kontrola proběhne během fáze commitu.

Hodnoty `null` a `undefined` jsou z kontrol unikátního indexu vyloučeny — více záznamů může mít chybějící unikátní pole.

### Příklad — vyvolání chyby

```typescript
store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    email: { type: 'string', unique: true },
  },
});

const users = store.bucket('users');
await users.insert({ email: 'alice@example.com' });

// Druhý insert se stejným emailem
await users.insert({ email: 'alice@example.com' });
// Vyvolá UniqueConstraintError: field "email" already has value "alice@example.com"
```

### Doporučené ošetření

```typescript
try {
  await users.insert(input);
} catch (err) {
  if (err instanceof UniqueConstraintError) {
    console.error(`Duplicate ${err.field}: ${String(err.value)}`);
    return;
  }
  throw err;
}
```

---

## BucketAlreadyExistsError

Vyvolána, když je `store.defineBucket()` zavolána s názvem, který je již registrován.

**Hierarchie:** `BucketAlreadyExistsError` → `Error`

**Zdrojový kód:** [`src/core/store.ts`](../../../src/core/store.ts)

### Vlastnosti

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `'BucketAlreadyExistsError'` | Název chyby |
| `message` | `string` | `Bucket "<bucket>" already exists` |
| `bucket` | `string` | Duplicitní název bucketu |

### Kdy je vyvolána

- **`store.defineBucket(name, definition)`** — bucket se stejným názvem `name` již byl v této instanci store definován.

### Příklad — vyvolání chyby

```typescript
await store.defineBucket('users', {
  key: 'id',
  schema: { id: { type: 'string' } },
});

// Opětovná definice stejného bucketu
await store.defineBucket('users', {
  key: 'id',
  schema: { id: { type: 'string' } },
});
// Vyvolá BucketAlreadyExistsError: Bucket "users" already exists
```

### Doporučené ošetření

Toto je typicky programátorská chyba (duplicitní definice v inicializačním kódu). V produkčním kódu definujte každý bucket přesně jednou při inicializaci. Pokud se potřebujete pojistit:

```typescript
try {
  await store.defineBucket('users', definition);
} catch (err) {
  if (err instanceof BucketAlreadyExistsError) {
    // Bucket je již nastaven — lze bezpečně ignorovat při idempotentní inicializaci
  } else {
    throw err;
  }
}
```

---

## BucketNotDefinedError

Vyvolána při pokusu o přístup k bucketu nebo jeho odstranění, pokud nebyl definován.

**Hierarchie:** `BucketNotDefinedError` → `Error`

**Zdrojový kód:** [`src/core/store.ts`](../../../src/core/store.ts)

### Vlastnosti

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `'BucketNotDefinedError'` | Název chyby |
| `message` | `string` | `Bucket "<bucket>" is not defined` |
| `bucket` | `string` | Neznámý název bucketu |

### Kdy je vyvolána

- **`store.bucket(name)`** — žádný bucket s tímto názvem nebyl definován.
- **`store.dropBucket(name)`** — žádný bucket s tímto názvem neexistuje k odstranění.

### Příklad — vyvolání chyby

```typescript
const store = await Store.start();

// Žádný bucket dosud nebyl definován
const handle = store.bucket('orders');
// Vyvolá BucketNotDefinedError: Bucket "orders" is not defined
```

### Doporučené ošetření

Téměř vždy se jedná o programátorskou chybu — překlep v názvu bucketu nebo chybějící volání `defineBucket()`. Opravte název nebo zajistěte, aby byl bucket definován před přístupem k němu:

```typescript
try {
  const handle = store.bucket(name);
} catch (err) {
  if (err instanceof BucketNotDefinedError) {
    console.error(`Unknown bucket: ${err.bucket}`);
  }
  throw err;
}
```

---

## TransactionConflictError

Vyvolána během commitu transakce, když store detekuje, že jiná operace mezitím upravila data, na kterých transakce závisí. Toto je jádro mechanismu [optimistic locking](./transactions.md#optimistic-locking).

**Hierarchie:** `TransactionConflictError` → `Error`

**Zdrojový kód:** [`src/core/store.ts`](../../../src/core/store.ts) (definice) / [`src/core/bucket-server.ts`](../../../src/core/bucket-server.ts) (vyvolání)

### Vlastnosti

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `'TransactionConflictError'` | Název chyby |
| `message` | `string` | `Transaction conflict in bucket "<bucket>" for key "<key>": <detail>` |
| `bucket` | `string` | Bucket, ve kterém ke konfliktu došlo |
| `key` | `unknown` | Primární klíč konfliktního záznamu |
| `field` | `string \| undefined` | Pole, které konflikt způsobilo (pokud je relevantní) |

### Kdy je vyvolána

Během fáze commitu `store.transaction()` jsou detekovány tři scénáře konfliktu:

| Scénář | Detailní zpráva |
|--------|-----------------|
| **Konflikt při insertu** | Záznam se stejným klíčem již v bucketu existuje |
| **Update — chybějící záznam** | Záznam byl smazán mezi čtením v transakci a commitem |
| **Update/Delete — neshoda verzí** | Záznam byl upraven jinou operací, `_version` se již neshoduje |

### Příklad — vyvolání chyby

```typescript
const users = store.bucket('users');
await users.insert({ id: 'u1', name: 'Alice' });

// Zahájení transakce, která čte záznam
await store.transaction(async (tx) => {
  const txUsers = await tx.bucket('users');
  const user = await txUsers.get('u1');

  // Souběžná modifikace mimo transakci
  await users.update('u1', { name: 'Bob' });

  // Při commitu bude detekována neshoda verzí
  await txUsers.update('u1', { name: 'Charlie' });
});
// Vyvolá TransactionConflictError
```

### Doporučené ošetření — vzor s opakováním

```typescript
async function withRetry<T>(
  store: Store,
  fn: (tx: TransactionContext) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await store.transaction(fn);
    } catch (err) {
      if (err instanceof TransactionConflictError && attempt < maxRetries) {
        continue; // Opakovat s čerstvými daty
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}
```

---

## QueryAlreadyDefinedError

Vyvolána, když je `store.defineQuery()` zavolána s názvem, který je již registrován.

**Hierarchie:** `QueryAlreadyDefinedError` → `Error`

**Zdrojový kód:** [`src/core/query-errors.ts`](../../../src/core/query-errors.ts)

### Vlastnosti

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `'QueryAlreadyDefinedError'` | Název chyby |
| `message` | `string` | `Query "<query>" is already defined` |
| `query` | `string` | Duplicitní název dotazu |

### Kdy je vyvolána

- **`store.defineQuery(name, fn)`** — dotaz se stejným názvem `name` již byl definován.

### Příklad — vyvolání chyby

```typescript
store.defineQuery('activeUsers', (ctx) => {
  return ctx.bucket('users').where({ status: 'active' });
});

// Opětovná definice stejného dotazu
store.defineQuery('activeUsers', (ctx) => {
  return ctx.bucket('users').where({ status: 'active' });
});
// Vyvolá QueryAlreadyDefinedError: Query "activeUsers" is already defined
```

### Doporučené ošetření

Stejně jako `BucketAlreadyExistsError` se jedná o programátorskou chybu. Definujte každý dotaz jednou při inicializaci:

```typescript
try {
  store.defineQuery('activeUsers', queryFn);
} catch (err) {
  if (err instanceof QueryAlreadyDefinedError) {
    // Dotaz je již registrován — lze bezpečně ignorovat při idempotentní inicializaci
  } else {
    throw err;
  }
}
```

---

## QueryNotDefinedError

Vyvolána při pokusu o odběr nebo spuštění dotazu, který nebyl definován.

**Hierarchie:** `QueryNotDefinedError` → `Error`

**Zdrojový kód:** [`src/core/query-errors.ts`](../../../src/core/query-errors.ts)

### Vlastnosti

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `name` | `'QueryNotDefinedError'` | Název chyby |
| `message` | `string` | `Query "<query>" is not defined` |
| `query` | `string` | Neznámý název dotazu |

### Kdy je vyvolána

- **`store.subscribe(name, callback)`** — žádný dotaz s tímto názvem nebyl definován.
- **`store.subscribe(name, params, callback)`** — totéž.
- **`store.runQuery(name, params?)`** — totéž.

### Příklad — vyvolání chyby

```typescript
// Žádný dotaz dosud nebyl definován
store.subscribe('topProducts', (result) => {
  console.log(result);
});
// Vyvolá QueryNotDefinedError: Query "topProducts" is not defined
```

### Doporučené ošetření

Jedná se o programátorskou chybu — překlep nebo chybějící volání `defineQuery()`. Zajistěte, aby všechny dotazy byly definovány před přihlášením k odběru:

```typescript
try {
  store.subscribe(queryName, callback);
} catch (err) {
  if (err instanceof QueryNotDefinedError) {
    console.error(`Unknown query: ${err.query}`);
  }
  throw err;
}
```

---

## Vzory ošetření chyb

### Univerzální vzor

Pokud potřebujete ošetřit chyby store obecně:

```typescript
import {
  ValidationError,
  UniqueConstraintError,
  TransactionConflictError,
} from '@hamicek/noex-store';

try {
  await users.insert(data);
} catch (err) {
  if (err instanceof ValidationError) {
    // Porušení schématu — zobrazit problémy uživateli
    return { errors: err.issues };
  }
  if (err instanceof UniqueConstraintError) {
    // Duplicitní hodnota — zobrazit konkrétní konflikt pole
    return { errors: [{ field: err.field, message: `Already taken` }] };
  }
  // Neočekávaná chyba — znovu vyvolat
  throw err;
}
```

### Identifikace podle jména

Při práci přes hranice modulů, kde `instanceof` nemusí fungovat (např. více verzí balíčku), použijte vlastnost `name`:

```typescript
try {
  await users.insert(data);
} catch (err) {
  if (err instanceof Error && err.name === 'ValidationError') {
    // Bezpečná kontrola napříč verzemi
  }
}
```

---

## Viz také

- [Schéma a typy](./schema.md) — omezení `FieldDefinition`, která vyvolávají `ValidationError`
- [Transakce](./transactions.md) — optimistic locking a vzory opakování pro `TransactionConflictError`
- [Store](./store.md) — metody `defineBucket()`, `defineQuery()` a `bucket()`, které vyvolávají chyby bucketů/dotazů
- [Reaktivní dotazy](./reactive-queries.md) — `subscribe()` a `runQuery()`, které vyvolávají `QueryNotDefinedError`
- **Výuka:** [Omezení polí](../learn/03-schema-validace/01-omezeni-poli.md) — schématická omezení v praxi
- **Výuka:** [Unikátní omezení](../learn/03-schema-validace/03-unikatni-omezeni.md) — unikátní indexy a `UniqueConstraintError`
- **Výuka:** [Optimistické zamykání](../learn/07-transakce/03-optimisticke-zamykani.md) — `TransactionConflictError` se vzory opakování
- **Zdrojový kód:** [`src/core/store.ts`](../../../src/core/store.ts) — `BucketAlreadyExistsError`, `BucketNotDefinedError`, `UniqueConstraintError`, `TransactionConflictError`
- **Zdrojový kód:** [`src/core/schema-validator.ts`](../../../src/core/schema-validator.ts) — `ValidationError`, `ValidationIssue`
- **Zdrojový kód:** [`src/core/query-errors.ts`](../../../src/core/query-errors.ts) — `QueryAlreadyDefinedError`, `QueryNotDefinedError`
