# Referenční příručka API reaktivních dotazů

> Automatické dotazy se sledováním závislostí, které se přepočítají při změně podkladových dat a upozorní odběratele pouze tehdy, když se výsledky skutečně liší.

## Přehled

Reaktivní dotazy umožňují definovat pojmenované výpočty pouze pro čtení nad daty v bucketech a odebírat jejich výsledky. Systém automaticky sleduje, které buckety a záznamy každý dotaz čte, přepočítá dotaz při změně těchto závislostí a vyvolá callback odběratele pouze tehdy, když se nový výsledek strukturálně liší od předchozího (kontrola deep equality).

Dotazy se registrují pomocí `store.defineQuery()`, konzumují pomocí `store.subscribe()` nebo `store.runQuery()` a uklízejí voláním vrácené funkce pro odhlášení nebo `store.stop()`.

## API

### Definice dotazů

---

### `store.defineQuery(name, fn): void`

Zaregistruje pojmenovaný reaktivní dotaz. Funkce dotazu přijímá [`QueryContext`](#querycontext) a volitelné parametry a musí asynchronně vrátit výsledek. Uvnitř dotazu jsou povoleny pouze operace čtení — mutace (insert, update, delete) nejsou na rozhraní [`QueryBucket`](#querybucket) dostupné.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `name` | `string` | — | Unikátní název dotazu |
| `fn` | [`QueryFn<TParams, TResult>`](#queryfntparams-tresult) | — | Asynchronní funkce `(ctx, params?) => Promise<TResult>` |

**Vrací:** `void`

**Vyhazuje:** `QueryAlreadyDefinedError` — dotaz se stejným názvem je již definován

**Příklad:**

```typescript
// Dotaz bez parametrů
store.defineQuery('vipCustomers', async (ctx) => {
  return ctx.bucket('customers').where({ tier: 'vip' });
});

// Dotaz s parametry
store.defineQuery('customerOrders', async (ctx, params: { customerId: string }) => {
  return ctx.bucket('orders').where({ customerId: params.customerId });
});
```

---

### Odběr dotazů

---

### `store.subscribe(queryName, callback): Promise<() => void>`

Přihlásí odběr reaktivního dotazu bez parametrů. Dotaz se vyhodnotí okamžitě během volání subscribe, aby se stanovil počáteční výsledek a sada závislostí. Callback se **nevolá** při počátečním přihlášení — spouští se pouze při následných přepočtech, které vytvoří strukturálně odlišný výsledek.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `queryName` | `string` | — | Název definovaného dotazu |
| `callback` | `(result: TResult) => void` | — | Volá se při změně výsledku dotazu |

**Vrací:** `Promise<() => void>` — funkce pro odhlášení (idempotentní, bezpečné volat vícekrát)

**Vyhazuje:** `QueryNotDefinedError` — dotaz nebyl definován

### `store.subscribe(queryName, params, callback): Promise<() => void>`

Přihlásí odběr reaktivního dotazu s parametry. Každá unikátní sada parametrů vytváří nezávislý odběr s vlastním sledováním závislostí a porovnáváním výsledků.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `queryName` | `string` | — | Název definovaného dotazu |
| `params` | `TParams` | — | Parametry předané funkci dotazu |
| `callback` | `(result: TResult) => void` | — | Volá se při změně výsledku dotazu |

**Vrací:** `Promise<() => void>` — funkce pro odhlášení

**Příklad:**

```typescript
// Bez parametrů
const unsub = await store.subscribe('vipCustomers', (vips) => {
  console.log('VIP customers changed:', vips.length);
});

// S parametry — každá sada parametrů je nezávislá
const unsubAlice = await store.subscribe(
  'customerOrders',
  { customerId: 'alice-1' },
  (orders) => console.log('Alice orders:', orders.length),
);

const unsubBob = await store.subscribe(
  'customerOrders',
  { customerId: 'bob-1' },
  (orders) => console.log('Bob orders:', orders.length),
);

// Ukončení odběru
unsub();
unsubAlice();
unsubBob();
```

---

### `store.runQuery(queryName, params?): Promise<TResult>`

Provede dotaz jednou a vrátí výsledek. Nevytváří odběr a nesleduje závislosti — jedná se čistě o jednorázové spuštění.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `queryName` | `string` | — | Název definovaného dotazu |
| `params` | `unknown` | `undefined` | Volitelné parametry předané funkci dotazu |

**Vrací:** `Promise<TResult>` — výsledek dotazu

**Vyhazuje:** `QueryNotDefinedError` — dotaz nebyl definován

**Příklad:**

```typescript
const vips = await store.runQuery<StoreRecord[]>('vipCustomers');

const orders = await store.runQuery<StoreRecord[]>(
  'customerOrders',
  { customerId: 'alice-1' },
);
```

---

### `store.settle(): Promise<void>`

Počká na dokončení všech probíhajících přepočtů reaktivních dotazů. Nezbytné v testech a sekvenčních tocích pro zajištění, že všechny callbacky odběratelů byly vyvolány po mutaci.

**Parametry:** žádné

**Vrací:** `Promise<void>`

**Příklad:**

```typescript
await store.bucket('customers').insert({ name: 'Charlie', tier: 'vip' });
await store.settle(); // všechny reaktivní dotazy byly přepočteny
```

---

## QueryContext

### `ctx.bucket(name): QueryBucket`

Vrátí [`QueryBucket`](#querybucket) pouze pro čtení pro pojmenovaný bucket. Závislosti se sledují na **úrovni volání metody**, nikoli na úrovni přístupu k bucketu — samotné volání `ctx.bucket('users')` nevytváří žádnou závislost. Pro registraci závislosti musíte zavolat metodu pro čtení na vráceném `QueryBucket`.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `name` | `string` | — | Název definovaného bucketu |

**Vrací:** [`QueryBucket`](#querybucket) — rozhraní bucketu pouze pro čtení se sledováním závislostí

**Příklad:**

```typescript
store.defineQuery('summary', async (ctx) => {
  const users = ctx.bucket('users');    // zatím žádná závislost
  const all = await users.all();        // závislost na úrovni bucketu na 'users'
  return { total: all.length };
});
```

---

## QueryBucket

Rozhraní bucketu pouze pro čtení dostupné uvnitř funkcí dotazů. Vystavuje stejné operace čtení jako [`BucketHandle`](./bucket-handle.md), ale bez jakýchkoli mutačních metod. Každé volání metody registruje závislost, která určuje, kdy bude dotaz přepočítán.

### Úrovně závislostí

Metody na `QueryBucket` registrují závislosti na dvou odlišných úrovních:

| Úroveň | Metody | Spouštěč přepočtu |
|--------|--------|-------------------|
| **Úroveň záznamu** | `get` | Pouze při změně konkrétního klíče |
| **Úroveň bucketu** | `all`, `where`, `findOne`, `count`, `first`, `last`, `paginate`, `sum`, `avg`, `min`, `max` | Při změně **jakéhokoli** záznamu v bucketu |

---

### `bucket.get(key): Promise<StoreRecord | undefined>`

Přečte jeden záznam podle primárního klíče. Registruje závislost na **úrovni záznamu** — přepočet se spustí pouze při vložení, aktualizaci nebo smazání tohoto konkrétního klíče.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `key` | `unknown` | — | Primární klíč záznamu |

**Vrací:** `Promise<StoreRecord | undefined>` — záznam, nebo `undefined` pokud nebyl nalezen

---

### `bucket.all(): Promise<StoreRecord[]>`

Vrátí všechny záznamy v bucketu. Registruje závislost na **úrovni bucketu**.

---

### `bucket.where(filter): Promise<StoreRecord[]>`

Vrátí záznamy odpovídající filtru (logika AND napříč vlastnostmi). Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `filter` | `Record<string, unknown>` | — | Páry klíč-hodnota, kterým musí záznamy odpovídat |

---

### `bucket.findOne(filter): Promise<StoreRecord | undefined>`

Vrátí první záznam odpovídající filtru. Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `filter` | `Record<string, unknown>` | — | Páry klíč-hodnota pro shodu |

---

### `bucket.count(filter?): Promise<number>`

Vrátí počet odpovídajících záznamů (nebo všech záznamů, pokud není zadán filtr). Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr |

---

### `bucket.first(n): Promise<StoreRecord[]>`

Vrátí prvních N záznamů (buckety s uspořádanou množinou). Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `n` | `number` | — | Počet záznamů k vrácení |

---

### `bucket.last(n): Promise<StoreRecord[]>`

Vrátí posledních N záznamů (buckety s uspořádanou množinou). Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `n` | `number` | — | Počet záznamů k vrácení |

---

### `bucket.paginate(options): Promise<PaginatedResult>`

Stránkování na základě kurzoru. Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `options` | [`PaginateOptions`](./bucket-handle.md#paginateoptions) | — | Kurzor a limit stránkování |

---

### `bucket.sum(field, filter?): Promise<number>`

Součet numerického pole. Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `field` | `string` | — | Název numerického pole |
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr |

---

### `bucket.avg(field, filter?): Promise<number>`

Průměr numerického pole. Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `field` | `string` | — | Název numerického pole |
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr |

---

### `bucket.min(field, filter?): Promise<number | undefined>`

Minimální hodnota numerického pole. Vrátí `undefined`, pokud neexistují odpovídající záznamy. Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `field` | `string` | — | Název numerického pole |
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr |

---

### `bucket.max(field, filter?): Promise<number | undefined>`

Maximální hodnota numerického pole. Vrátí `undefined`, pokud neexistují odpovídající záznamy. Registruje závislost na **úrovni bucketu**.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `field` | `string` | — | Název numerického pole |
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr |

---

## Sledování závislostí

Reaktivní dotazy používají **dvouúrovňový model závislostí** pro minimalizaci zbytečných přepočtů.

### Jak to funguje

1. Při provádění funkce dotazu každé volání metody pro čtení na `QueryBucket` zaznamená závislost.
2. Když dojde ke změně v bucketu (insert, update, delete), správce dotazů zkontroluje, které odběry závisejí na daném bucketu a klíči.
3. Dotčené odběry se přepočítají asynchronně.
4. Po přepočtu se nový výsledek porovná s předchozím pomocí deep equality. Callback se vyvolá **pouze** tehdy, pokud se výsledek skutečně změnil.

### Závislosti na úrovni záznamu

Pouze `get(key)` vytváří závislosti na úrovni záznamu. Dotaz se přepočítá pouze tehdy, když je modifikován konkrétní klíč, ke kterému přistupoval.

```typescript
store.defineQuery('singleUser', async (ctx, params: { id: string }) => {
  return ctx.bucket('users').get(params.id);
});

const unsub = await store.subscribe('singleUser', { id: 'u1' }, (user) => {
  console.log('User u1 changed:', user);
});

// Toto spustí přepočet — klíč 'u1' byl přečten
await store.bucket('users').update('u1', { name: 'Updated' });
await store.settle();

// Toto NESPUSTÍ přepočet — klíč 'u2' nebyl přečten
await store.bucket('users').update('u2', { name: 'Other' });
await store.settle();
```

### Závislosti na úrovni bucketu

Všechny ostatní metody pro čtení (`where`, `all`, `findOne`, `count`, `first`, `last`, `paginate`, `sum`, `avg`, `min`, `max`) vytvářejí závislosti na úrovni bucketu. Jakákoli změna v bucketu spustí přepočet.

```typescript
store.defineQuery('orderTotal', async (ctx) => {
  return ctx.bucket('orders').sum('amount');
});

// Jakýkoli insert/update/delete v 'orders' spustí přepočet
await store.bucket('orders').insert({ amount: 50, product: 'Widget' });
await store.settle();
```

### Smíšené závislosti

Jeden dotaz může mít závislosti na úrovni záznamu i na úrovni bucketu, a to i ve stejném bucketu. Pokud se bucket vyskytuje na obou úrovních, závislost na úrovni bucketu má přednost (jakákoli změna spustí přepočet).

```typescript
store.defineQuery('customerWithOrders', async (ctx, params: { id: string }) => {
  // Úroveň záznamu: pouze změny tohoto konkrétního zákazníka
  const customer = await ctx.bucket('customers').get(params.id);
  // Úroveň bucketu: jakákoli změna v objednávkách
  const orders = await ctx.bucket('orders').where({ customerId: params.id });
  return { customer, orders };
});
```

Závislosti pro tento dotaz:
- `customers` — na úrovni záznamu (pouze konkrétní `id`)
- `orders` — na úrovni bucketu (jakákoli změna)

### Dynamické závislosti

Závislosti se přepočítávají při každém vyhodnocení. Pokud dotaz podmíněně čte z bucketu, sada závislostí se může mezi vyhodnoceními měnit.

```typescript
store.defineQuery('conditionalOrders', async (ctx) => {
  const vips = await ctx.bucket('customers').where({ tier: 'vip' });
  if (vips.length > 0) {
    return ctx.bucket('orders').all(); // přístup pouze když existují VIP
  }
  return [];
});
```

- Když neexistují žádní VIP: závisí pouze na `customers` (na úrovni bucketu)
- Po přidání VIP: závisí na `customers` i `orders` (obojí na úrovni bucketu)
- Pokud jsou všichni VIP odebráni: zpět k závislosti pouze na `customers`

Index závislostí se automaticky aktualizuje po každém přepočtu.

---

## Deep equality

Callbacky odběratelů se vyvolají pouze tehdy, když se výsledek dotazu **strukturálně změnil**. Dva výsledky se považují za rovné, pokud mají stejný tvar a hodnoty, kontrolované rekurzivně:

| Typ | Porovnání |
|-----|-----------|
| Primitivní typy | `===` (striktní rovnost) |
| `NaN` | `NaN === NaN` (považováno za rovné) |
| `Date` | Porovnání `.getTime()` |
| `RegExp` | Porovnání `.source` a `.flags` |
| Pole | Délka + rekurzivní porovnání prvků po prvcích |
| Prosté objekty | Počet klíčů + rekurzivní porovnání hodnot |

To zabraňuje zbytečným vyvoláním callbacků, když se dotaz přepočte, ale vytvoří stejný výsledek — například `count()`, který vrátí `5` před i po nesouvisející aktualizaci ve stejném bucketu.

---

## Odolnost vůči chybám

Pokud funkce dotazu vyhodí výjimku během přepočtu, odběr zůstává aktivní a callback se přeskočí. Další změna v bucketu spustí nový pokus o přepočet, což umožňuje dotazu zotavit se z přechodných chyb.

```typescript
let failOnce = true;

store.defineQuery('resilient', async (ctx) => {
  if (failOnce) {
    failOnce = false;
    throw new Error('Transient failure');
  }
  return ctx.bucket('data').all();
});

const unsub = await store.subscribe('resilient', (data) => {
  // Tento callback bude přeskočen během neúspěšného vyhodnocení,
  // ale spustí se, když dotaz uspěje při následné změně.
  console.log('Data:', data);
});
```

---

## Chování odhlášení

Funkce pro odhlášení vrácená z `store.subscribe()` je **idempotentní** — její vícenásobné volání je bezpečné a nemá žádný další efekt. Při prvním volání:

1. Odebere odběr z interního registru
2. Odstraní všechny záznamy indexu závislostí pro daný odběr
3. Zabrání jakémukoli dalšímu vyvolání callbacku, i když probíhá přepočet

```typescript
const unsub = await store.subscribe('vipCustomers', (vips) => {
  console.log(vips);
});

unsub(); // odebere odběr a provede úklid
unsub(); // bezpečná operace bez efektu
```

---

## Typy

### `QueryFn<TParams, TResult>`

Signatura funkce dotazu. Čistá asynchronní funkce, která čte z bucketů prostřednictvím `QueryContext`.

```typescript
type QueryFn<TParams = void, TResult = unknown> =
  TParams extends void
    ? (ctx: QueryContext) => Promise<TResult>
    : (ctx: QueryContext, params: TParams) => Promise<TResult>;
```

Když je `TParams` roven `void` (výchozí), funkce přijímá pouze `ctx`. Když je `TParams` specifikován, funkce vyžaduje druhý argument `params`.

---

### `QueryContext`

Kontext provádění předávaný funkcím dotazů. Poskytuje přístup pouze pro čtení k bucketům s automatickým sledováním závislostí.

```typescript
interface QueryContext {
  bucket(name: string): QueryBucket;
}
```

---

### `QueryBucket`

Rozhraní bucketu pouze pro čtení dostupné uvnitř funkcí dotazů. Vystavuje všechny operace čtení z [`BucketHandle`](./bucket-handle.md) bez jakýchkoli mutačních metod.

```typescript
interface QueryBucket {
  get(key: unknown): Promise<StoreRecord | undefined>;
  all(): Promise<StoreRecord[]>;
  where(filter: Record<string, unknown>): Promise<StoreRecord[]>;
  findOne(filter: Record<string, unknown>): Promise<StoreRecord | undefined>;
  count(filter?: Record<string, unknown>): Promise<number>;
  first(n: number): Promise<StoreRecord[]>;
  last(n: number): Promise<StoreRecord[]>;
  paginate(options: PaginateOptions): Promise<PaginatedResult>;
  sum(field: string, filter?: Record<string, unknown>): Promise<number>;
  avg(field: string, filter?: Record<string, unknown>): Promise<number>;
  min(field: string, filter?: Record<string, unknown>): Promise<number | undefined>;
  max(field: string, filter?: Record<string, unknown>): Promise<number | undefined>;
}
```

---

### `QueryDependencies`

Struktura reprezentující závislosti sebrané během provádění dotazu.

```typescript
interface QueryDependencies {
  /** Buckety se závislostmi na úrovni bucketu — jakákoli změna spustí přepočet. */
  readonly bucketLevel: ReadonlySet<string>;
  /** Buckety se závislostmi na úrovni záznamu — přepočet spustí pouze změny konkrétních klíčů.
   *  Map<názevBucketu, Set<primárníKlíč>> */
  readonly recordLevel: ReadonlyMap<string, ReadonlySet<unknown>>;
}
```

---

### `QueryAlreadyDefinedError`

Vyhozena při pokusu o definici dotazu s názvem, který je již zaregistrován.

```typescript
class QueryAlreadyDefinedError extends Error {
  readonly query: string; // duplicitní název dotazu
}
```

---

### `QueryNotDefinedError`

Vyhozena při pokusu o přihlášení odběru nebo spuštění dotazu, který nebyl definován.

```typescript
class QueryNotDefinedError extends Error {
  readonly query: string; // chybějící název dotazu
}
```

## Viz také

- [Store API](./store.md) — `defineQuery()`, `subscribe()`, `runQuery()` a `settle()` na instanci store
- [BucketHandle API](./bucket-handle.md) — kompletní CRUD a operace čtení, které QueryBucket zrcadlí (podmnožina pouze pro čtení)
- [Chyby](./errors.md) — kompletní katalog tříd chyb včetně `QueryAlreadyDefinedError` a `QueryNotDefinedError`
- **Výuka:** [Co jsou reaktivní dotazy](../learn/05-reaktivni-dotazy/01-co-jsou-reaktivni-dotazy.md) — koncepční úvod do reaktivních dotazů
- **Výuka:** [Definice a odběr](../learn/05-reaktivni-dotazy/02-definice-a-odber.md) — návod krok za krokem
- **Výuka:** [Sledování závislostí](../learn/05-reaktivni-dotazy/03-sledovani-zavislosti.md) — podrobný pohled na fungování závislostí
- **Zdrojový kód:** [`src/reactive/query-manager.ts`](../../../src/reactive/query-manager.ts)
- **Zdrojový kód:** [`src/reactive/query-context.ts`](../../../src/reactive/query-context.ts)
- **Zdrojový kód:** [`src/types/query.ts`](../../../src/types/query.ts)
