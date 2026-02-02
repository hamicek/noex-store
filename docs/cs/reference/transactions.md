# Referenční dokumentace API transakcí

> Atomické zápisy do více bucketů s izolací read-your-own-writes, optimistickým zamykáním a automatickým rollbackem při selhání.

## Přehled

Transakce umožňují seskupit více zápisových operací napříč jedním nebo více buckety do jedné atomické jednotky. Všechny zápisy jsou lokálně bufferovány během callbacku transakce a commitnuty společně po jeho dokončení. Pokud callback vyhodí výjimku, nic se nezapíše. Pokud commit selže uprostřed zpracování (např. konflikt verzí), dříve commitnuté buckety jsou rollbackovány na bázi best-effort.

Transakce se vytvářejí pomocí `store.transaction()`. Uvnitř callbacku obdržíte `TransactionContext`, který poskytuje instance `TransactionBucketHandle` — ty bufferují zápisy lokálně a překrývají je přes čtení, čímž vám zajistí sémantiku read-your-own-writes.

## API

### `store.transaction(fn): Promise<T>`

Provede transakční callback. Vytvoří `TransactionContext`, předá ho do `fn` a po dokončení `fn` atomicky commitne všechny bufferované zápisy. Pokud `fn` vyhodí výjimku, transakce se zahodí — žádné zápisy se nedostanou do store.

Návratová hodnota `fn` je předána jako návratová hodnota `transaction()`.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `fn` | `(tx: TransactionContext) => Promise<T>` | — | Asynchronní callback provádějící transakční operace |

**Vrací:** `Promise<T>` — hodnotu vrácenou z `fn`

**Vyhazuje:**
- `TransactionConflictError` — při commitu byl detekován konflikt verzí (viz [Optimistické zamykání](#optimistické-zamykání))
- Jakákoliv chyba vyhozená z `fn` — propagována tak, jak je, transakce se zahodí

**Příklad:**

```typescript
const newOrder = await store.transaction(async (tx) => {
  const customers = await tx.bucket('customers');
  const orders = await tx.bucket('orders');

  const customer = await customers.get('cust-1');
  if (!customer) throw new Error('Customer not found');

  const order = await orders.insert({
    customerId: 'cust-1',
    total: 99.99,
    status: 'pending',
  });

  await customers.update('cust-1', {
    orderCount: (customer.orderCount as number) + 1,
  });

  return order;
});
```

---

## TransactionContext

Kontextový objekt předaný do callbacku transakce. Poskytuje přístup k transakčním bucket handle.

### `tx.bucket(name): Promise<TransactionBucketHandle>`

Vrátí `TransactionBucketHandle` pro pojmenovaný bucket. Handle se vytváří lazy při prvním přístupu a je kešován — další volání se stejným názvem vrátí tentýž handle.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `name` | `string` | — | Název definovaného bucketu |

**Vrací:** `Promise<TransactionBucketHandle>`

**Vyhazuje:** `Error` — bucket není definován

**Příklad:**

```typescript
await store.transaction(async (tx) => {
  const users = await tx.bucket('users');
  const orders = await tx.bucket('orders');

  // Při opakovaném přístupu je vrácen tentýž handle
  const usersAgain = await tx.bucket('users');
  // usersAgain === users
});
```

---

## TransactionBucketHandle

Bucket handle pro použití v rámci transakce. Zápisové operace jsou bufferovány lokálně. Čtecí operace aplikují buffer jako překryvnou vrstvu nad skutečným stavem store, čímž poskytují izolaci read-your-own-writes.

### Rozdíly oproti BucketHandle

| Aspekt | `BucketHandle` | `TransactionBucketHandle` |
|--------|----------------|---------------------------|
| **Zápisy** | Aplikovány okamžitě | Bufferovány do commitu |
| **Čtení** | Vždy ze store | Překryvná vrstva (buffer + store) |
| **Dostupné metody** | Kompletní API (CRUD, dotazy, stránkování, agregace) | `insert`, `get`, `update`, `delete`, `all`, `where`, `findOne`, `count` |
| **Události** | Emitovány okamžitě | Emitovány po commitu |

### Zápisové operace

---

### `bucket.insert(data): Promise<StoreRecord>`

Zvaliduje a připraví záznam a poté ho zařadí do bufferu pro vložení. Validace schématu, výchozí hodnoty a generovaná pole (uuid, cuid, autoincrement, timestamp) se aplikují okamžitě. Záznam je viditelný pro následující čtení v rámci téže transakce, ale do store se dostane až při commitu.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `data` | `Record<string, unknown>` | — | Data záznamu (validovaná proti schématu) |

**Vrací:** `Promise<StoreRecord>` — připravený záznam s generovanými poli a metadaty

**Vyhazuje:** `ValidationError` — data neprošla validací schématu

**Příklad:**

```typescript
await store.transaction(async (tx) => {
  const orders = await tx.bucket('orders');

  const order = await orders.insert({ product: 'Widget', amount: 42 });
  console.log(order.id); // generovaný klíč je dostupný okamžitě

  // Insert je viditelný v rámci této transakce
  const fetched = await orders.get(order.id);
  // fetched === order
});
```

---

### `bucket.update(key, changes): Promise<StoreRecord>`

Přečte aktuální záznam (z překryvné vrstvy bufferu nebo store), aplikuje změny, zvaliduje a zařadí update do bufferu. Pole `_version` je v připraveném záznamu inkrementováno. `expectedVersion` zaznamenaná v bufferu odpovídá verzi v okamžiku prvního čtení, což umožňuje optimistické zamykání v době commitu.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `key` | `unknown` | — | Primární klíč záznamu k aktualizaci |
| `changes` | `Record<string, unknown>` | — | Částečný záznam s poli k změně |

**Vrací:** `Promise<StoreRecord>` — aktualizovaný záznam

**Vyhazuje:** `Error` — záznam neexistuje (nenalezen v bufferu ani ve store)

**Příklad:**

```typescript
await store.transaction(async (tx) => {
  const products = await tx.bucket('products');

  await products.update('prod-1', { price: 29.99 });

  // Update je viditelný v rámci této transakce
  const updated = await products.get('prod-1');
  console.log(updated?.price); // 29.99
});
```

---

### `bucket.delete(key): Promise<void>`

Přečte aktuální záznam a zařadí operaci delete do bufferu. Idempotentní — smazání neexistujícího klíče je no-op.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `key` | `unknown` | — | Primární klíč záznamu ke smazání |

**Vrací:** `Promise<void>`

**Příklad:**

```typescript
await store.transaction(async (tx) => {
  const sessions = await tx.bucket('sessions');

  await sessions.delete('sess-expired');

  // Záznam je v rámci této transakce nedostupný
  const deleted = await sessions.get('sess-expired');
  // deleted === undefined
});
```

---

### Čtecí operace

Všechny čtecí operace aplikují zápisový buffer transakce jako překryvnou vrstvu nad skutečnými daty store:

- **Inserty** v bufferu se připojí k sadě výsledků
- **Updaty** v bufferu nahradí odpovídající záznamy ze store
- **Delety** v bufferu odstraní záznamy ze sady výsledků

---

### `bucket.get(key): Promise<StoreRecord | undefined>`

Přečte jeden záznam podle primárního klíče. Nejprve kontroluje buffer (vrací bufferovanou verzi nebo `undefined` pro bufferované delety), poté se obrací na skutečný store.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `key` | `unknown` | — | Primární klíč záznamu |

**Vrací:** `Promise<StoreRecord | undefined>`

---

### `bucket.all(): Promise<StoreRecord[]>`

Vrátí všechny záznamy ze store s aplikovanou překryvnou vrstvou bufferu.

**Vrací:** `Promise<StoreRecord[]>`

---

### `bucket.where(filter): Promise<StoreRecord[]>`

Vrátí záznamy odpovídající filtru (logika AND přes vlastnosti) z překryté datové sady.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `filter` | `Record<string, unknown>` | — | Páry klíč-hodnota, které musí záznamy splňovat |

**Vrací:** `Promise<StoreRecord[]>`

---

### `bucket.findOne(filter): Promise<StoreRecord | undefined>`

Vrátí první záznam odpovídající filtru z překryté datové sady.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `filter` | `Record<string, unknown>` | — | Páry klíč-hodnota k porovnání |

**Vrací:** `Promise<StoreRecord | undefined>`

---

### `bucket.count(filter?): Promise<number>`

Vrátí počet záznamů odpovídajících filtru (nebo celkový počet) z překryté datové sady.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `filter` | `Record<string, unknown>` | `undefined` | Volitelný filtr |

**Vrací:** `Promise<number>`

---

## Read-Your-Own-Writes

V rámci transakce všechna čtení reflektují necommitnuté zápisy provedené dříve v téže transakci. To platí pro všechny čtecí metody (`get`, `all`, `where`, `findOne`, `count`).

```typescript
await store.transaction(async (tx) => {
  const users = await tx.bucket('users');

  // Vložení nového uživatele
  const alice = await users.insert({ name: 'Alice', role: 'admin' });

  // Insert je okamžitě viditelný
  const all = await users.all();
  const found = all.find((u) => u.name === 'Alice');
  // found !== undefined

  // Aktualizace právě vloženého uživatele
  await users.update(alice.id, { role: 'superadmin' });

  // Update je reflektován
  const updated = await users.get(alice.id);
  // updated.role === 'superadmin'

  // Smazání
  await users.delete(alice.id);

  // Nedostupný při čtení
  const afterDelete = await users.get(alice.id);
  // afterDelete === undefined
});
```

Logika překryvné vrstvy bufferu:

| Stav bufferu pro klíč | `get(key)` vrací | Vliv na `all()` / `where()` |
|----------------------|--------------------|-------------------------------|
| Vložen (insert) | Bufferovaný záznam | Připojen k výsledkům |
| Aktualizován (update) | Bufferovaný záznam | Nahrazuje verzi ve store |
| Smazán (delete) | `undefined` | Vyloučen z výsledků |
| Není v bufferu | Hodnota ze store | Zahrnut tak, jak je |

---

## Optimistické zamykání

Transakce používají optimistické řízení souběžnosti prostřednictvím pole `_version` na každém záznamu. Během transakce se nedrží žádné zámky — konflikty se detekují v okamžiku commitu.

### Jak to funguje

1. Když `TransactionBucketHandle` přečte záznam (pro `update` nebo `delete`), zachytí aktuální `_version` záznamu jako `expectedVersion`.
2. V okamžiku commitu je každá operace update/delete validována vůči aktuálnímu stavu store.
3. Pokud `_version` záznamu ve store již neodpovídá `expectedVersion`, je vyhozena `TransactionConflictError`.

### Scénáře konfliktu

| Scénář | Výsledek |
|----------|--------|
| Záznam aktualizován jinou operací mezi čtením a commitem | `TransactionConflictError` (neshoda verzí) |
| Záznam smazán jinou operací mezi čtením a commitem (update) | `TransactionConflictError` (záznam nenalezen) |
| Insert klíče, který již existuje | `TransactionConflictError` (duplicitní klíč) |

### Vzor opakování

```typescript
async function withRetry<T>(
  store: Store,
  fn: (tx: TransactionContext) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await store.transaction(fn);
    } catch (error) {
      if (error instanceof TransactionConflictError && attempt < maxRetries - 1) {
        continue; // opakování s čerstvými daty
      }
      throw error;
    }
  }
  throw new Error('Unreachable');
}
```

---

## Protokol commitu

Proces commitu následuje dvoufázový přístup v rámci každého bucketu a sekvenční přístup napříč buckety.

### Průběh commitu

1. **Callback dokončen** — `fn(tx)` se vrátí bez vyhození výjimky
2. **Sestavení operací** — bufferované inserty, updaty a delety jsou převedeny na pole `CommitBatchOp` pro každý bucket
3. **Sekvenční commit bucketů** — pro každý dotčený bucket:
   - **Fáze 1 (Validace):** Všechny operace jsou zkontrolovány vůči aktuálnímu stavu store (existence klíčů, shoda verzí, unikátní omezení) bez jakýchkoliv mutací
   - **Fáze 2 (Aplikace):** Všechny operace jsou aplikovány na store, přičemž se sbírají události a undo operace
4. **Emitování událostí** — po úspěšném commitu VŠECH bucketů jsou publikovány události

### Rollback při selhání

Pokud commit jakéhokoliv bucketu selže (validace ve Fázi 1 nebo chyba aplikace ve Fázi 2):

1. Částečné změny selhavšího bucketu z Fáze 2 jsou interně rollbackovány
2. Všechny dříve commitnuté buckety jsou rollbackovány v opačném pořadí pomocí jejich undo operací
3. Chyba je propagována volajícímu

Rollback je **best-effort** — pokud samotná rollback operace selže, chyba je potlačena a rollback pokračuje pro zbývající buckety.

### Emitování událostí

Události jsou publikovány až poté, co všechny buckety úspěšně commitnou. Pro každou operaci jsou emitovány individuální události `inserted`, `updated` a `deleted`:

```typescript
await store.transaction(async (tx) => {
  const users = await tx.bucket('users');
  const orders = await tx.bucket('orders');

  await users.insert({ name: 'Alice' });
  await orders.insert({ product: 'Widget', amount: 10 });
  await orders.insert({ product: 'Gadget', amount: 20 });
});

// Po commitu jsou emitovány tři události:
// 1. bucket.users.inserted  (Alice)
// 2. bucket.orders.inserted (Widget)
// 3. bucket.orders.inserted (Gadget)
```

Události jsou emitovány synchronně v pořadí po commitu. Pokud potřebujete počkat, než reaktivní dotazy zpracují tyto události, použijte `store.settle()`.

---

## Automatický rollback při chybě

Pokud callback transakce vyhodí výjimku, transakce se jednoduše zahodí — žádné zápisy nejsou commitnuty, žádné události nejsou emitovány.

```typescript
try {
  await store.transaction(async (tx) => {
    const users = await tx.bucket('users');

    await users.insert({ name: 'Alice' });
    await users.insert({ name: 'Bob' });

    throw new Error('Something went wrong');
    // Ani Alice, ani Bob nejsou vloženi
  });
} catch (error) {
  // error.message === 'Something went wrong'
  // Store zůstává nezměněn
}
```

---

## Typy

### `TransactionContext`

Kontextový objekt předaný do callbacku transakce. Poskytuje přístup k transakčním bucket handle.

```typescript
class TransactionContext {
  /** Vrátí transakční bucket handle (lazy vytváření, kešovaný). */
  bucket(name: string): Promise<TransactionBucketHandle>;

  /** Commitne všechny bufferované zápisy. Voláno automaticky metodou store.transaction(). */
  commit(): Promise<void>;
}
```

> **Poznámka:** `commit()` je volán automaticky metodou `store.transaction()` po dokončení callbacku. Neměli byste ho volat ručně.

---

### `TransactionBucketHandle`

Bucket handle s bufferovanými zápisy a překryvným čtením.

```typescript
class TransactionBucketHandle {
  readonly name: string;

  // Zápisové operace (bufferované)
  insert(data: Record<string, unknown>): Promise<StoreRecord>;
  update(key: unknown, changes: Record<string, unknown>): Promise<StoreRecord>;
  delete(key: unknown): Promise<void>;

  // Čtecí operace (překryvná vrstva nad store)
  get(key: unknown): Promise<StoreRecord | undefined>;
  all(): Promise<StoreRecord[]>;
  where(filter: Record<string, unknown>): Promise<StoreRecord[]>;
  findOne(filter: Record<string, unknown>): Promise<StoreRecord | undefined>;
  count(filter?: Record<string, unknown>): Promise<number>;
}
```

---

### `TransactionConflictError`

Vyhozena, když je při commitu detekován konflikt verzí nebo klíčů.

```typescript
class TransactionConflictError extends Error {
  readonly bucket: string;        // bucket, ve kterém nastal konflikt
  readonly key: unknown;          // primární klíč konfliktního záznamu
  readonly field: string | undefined; // dotčené pole (pokud je relevantní)
}
```

**Kdy je vyhozena:**

| Scénář | Vzor zprávy |
|----------|-----------------|
| Update záznamu, jehož verze se změnila | `Version mismatch: expected X, got Y` |
| Update smazaného záznamu | `Record with key "..." not found` |
| Delete záznamu, jehož verze se změnila | `Version mismatch: expected X, got Y` |
| Insert klíče, který již existuje | `Record with key "..." already exists` |

---

### `WriteBuffer`

Hlavní zápisový buffer, který spravuje buffery pro jednotlivé buckety. Interně používán třídou `TransactionContext`.

```typescript
class WriteBuffer {
  /** Získá nebo vytvoří buffer pro daný bucket. */
  forBucket(name: string): BucketWriteBuffer;

  /** Názvy všech bucketů, které mají bufferované operace. */
  getBucketNames(): string[];

  /** Získá buffer pro konkrétní bucket. */
  getBucket(name: string): BucketWriteBuffer | undefined;

  /** True, pokud žádné operace nejsou bufferovány v žádném bucketu. */
  readonly isEmpty: boolean;
}
```

---

### `BucketWriteBuffer`

Zápisový buffer pro jednotlivý bucket, který sleduje inserty, updaty a delety odděleně. Udržuje překryvnou vrstvu pro izolaci read-your-own-writes.

```typescript
class BucketWriteBuffer {
  readonly inserts: Map<unknown, StoreRecord>;
  readonly updates: Map<unknown, StoreRecord>;
  readonly deletes: Map<unknown, StoreRecord>;
  readonly ops: BufferedOp[];

  addInsert(key: unknown, record: StoreRecord): void;
  addUpdate(key: unknown, oldRecord: StoreRecord, newRecord: StoreRecord): void;
  addDelete(key: unknown, record: StoreRecord): void;

  /**
   * Vyhledá záznam v překryvné vrstvě.
   * Vrací: StoreRecord pokud je v insertech/updatech, null pokud je smazán, undefined pokud není bufferován.
   */
  getOverlay(key: unknown): StoreRecord | null | undefined;

  readonly isEmpty: boolean;
}
```

---

### `BufferedOp`

Diskriminovaná unie typů bufferovaných operací.

```typescript
interface BufferedInsert {
  readonly type: 'insert';
  readonly key: unknown;
  readonly record: StoreRecord;
}

interface BufferedUpdate {
  readonly type: 'update';
  readonly key: unknown;
  readonly oldRecord: StoreRecord;
  readonly newRecord: StoreRecord;
  readonly expectedVersion: number;
}

interface BufferedDelete {
  readonly type: 'delete';
  readonly key: unknown;
  readonly record: StoreRecord;
  readonly expectedVersion: number;
}

type BufferedOp = BufferedInsert | BufferedUpdate | BufferedDelete;
```

---

### Optimalizace bufferu

Zápisový buffer aplikuje optimalizaci čistého efektu pro určité sekvence operací v rámci jedné transakce:

| Sekvence | Čistý efekt |
|----------|------------|
| `insert` → `update` | Jediný insert s aktualizovaným záznamem |
| `insert` → `delete` | Žádná operace (obojí odstraněno z bufferu) |
| `update` → `update` | Jediný update s nejnovějším záznamem (původní `expectedVersion` zachována) |

Tím se snižuje počet operací odesílaných do store v okamžiku commitu.

---

## Viz také

- [Store API](./store.md) — vstupní bod `store.transaction()`
- [BucketHandle API](./bucket-handle.md) — netransakční operace s buckety
- [Události](./events.md) — typy událostí emitovaných po commitu transakce
- [Chyby](./errors.md) — kompletní katalog chyb včetně `TransactionConflictError`
- **Výuka:** [Proč transakce](../learn/07-transakce/01-proc-transakce.md) — koncepční úvod
- **Výuka:** [Použití transakcí](../learn/07-transakce/02-pouziti-transakci.md) — podrobný tutoriál
- **Zdrojový kód:** [`src/transaction/transaction.ts`](../../../src/transaction/transaction.ts)
- **Zdrojový kód:** [`src/transaction/transaction-bucket-handle.ts`](../../../src/transaction/transaction-bucket-handle.ts)
- **Zdrojový kód:** [`src/transaction/write-buffer.ts`](../../../src/transaction/write-buffer.ts)
