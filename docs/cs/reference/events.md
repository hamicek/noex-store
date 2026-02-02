# API reference systému událostí

> Odebírejte notifikace o změnách dat v reálném čase s porovnáváním pomocí wildcard vzorů napříč všemi buckety.

## Přehled

Systém událostí upozorní váš kód vždy, když jsou záznamy vloženy, aktualizovány nebo smazány v jakémkoli bucketu. Handlery událostí registrujete pomocí `store.on()` s tečkou oddělenými vzory témat, které podporují `*` wildcard. Každý handler obdrží payload události a odpovídající řetězec tématu a může být kdykoli odebrán zavoláním vrácené odhlašovací funkce.

Události jsou publikovány synchronně po každé mutaci, ale doručeny handlerům asynchronně — původní operace se dokončí dříve, než se spustí jakýkoli handler. U transakcí jsou události odloženy a publikovány až poté, co všechny buckety úspěšně potvrdí commit.

## API

### `store.on(pattern, handler): Promise<() => Promise<void>>`

Registruje handler událostí pro události bucketu odpovídající danému vzoru.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `pattern` | `string` | — | Tečkou oddělený vzor tématu (podporuje `*` wildcard) |
| `handler` | `(event: T, topic: string) => void` | — | Callback přijímající payload události a úplný řetězec tématu |

**Typový parametr:** `T` má výchozí hodnotu `BucketEvent`. Zužte jej na konkrétní typ události pro typově bezpečný přístup k polím specifickým pro daný typ události.

**Vrací:** `Promise<() => Promise<void>>` — asynchronní odhlašovací funkce

**Příklad:**

```typescript
import type { BucketInsertedEvent, BucketEvent } from '@hamicek/noex-store';

// Typovaný handler — pouze insert události pro konkrétní bucket
const unsub = await store.on<BucketInsertedEvent>(
  'bucket.users.inserted',
  (event, topic) => {
    console.log(`New user: ${event.record.name}`);
    // topic === 'bucket.users.inserted'
  },
);

// Obecný handler — všechny události všech bucketů
await store.on<BucketEvent>('bucket.*.*', (event, topic) => {
  console.log(`${event.type} in ${event.bucket}`);
});

// Ukončení naslouchání
await unsub();
```

---

## Formát témat

Každá událost bucketu je publikována do tématu s formátem:

```
bucket.<bucketName>.<eventType>
```

Kde `<eventType>` je jedno z `inserted`, `updated` nebo `deleted`.

**Příklady:**

| Téma | Význam |
|------|--------|
| `bucket.users.inserted` | Záznam byl vložen do bucketu `users` |
| `bucket.orders.updated` | Záznam byl aktualizován v bucketu `orders` |
| `bucket.sessions.deleted` | Záznam byl smazán z bucketu `sessions` |

---

## Wildcard vzory

Wildcard `*` odpovídá přesně jednomu segmentu mezi tečkami. Rekurzivní wildcard `**` neexistuje. Porovnávání je doslovné a rozlišuje velká a malá písmena.

| Vzor | Odpovídá | Příklady témat |
|------|----------|----------------|
| `bucket.users.inserted` | Pouze vložení v `users` | `bucket.users.inserted` |
| `bucket.users.*` | Všechny události v `users` | `bucket.users.inserted`, `bucket.users.updated`, `bucket.users.deleted` |
| `bucket.*.inserted` | Všechna vložení napříč všemi buckety | `bucket.users.inserted`, `bucket.orders.inserted` |
| `bucket.*.*` | Všechny události bucketů | Jakékoli téma `bucket.<name>.<type>` |

**Pravidla:**

- Každý `*` odpovídá přesně jednomu segmentu (oddělenému `.`)
- Téma má přesně tři segmenty: `bucket`, název bucketu a typ události
- Doslovné segmenty musí odpovídat přesně (rozlišují se velká a malá písmena)

---

## Typy událostí

### `BucketInsertedEvent`

Publikováno, když je do bucketu vložen nový záznam.

```typescript
interface BucketInsertedEvent {
  readonly type: 'inserted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `type` | `'inserted'` | Diskriminant — vždy `'inserted'` |
| `bucket` | `string` | Název bucketu |
| `key` | `unknown` | Primární klíč vloženého záznamu |
| `record` | `StoreRecord` | Úplný vložený záznam (včetně generovaných polí a metadat) |

---

### `BucketUpdatedEvent`

Publikováno, když je aktualizován existující záznam.

```typescript
interface BucketUpdatedEvent {
  readonly type: 'updated';
  readonly bucket: string;
  readonly key: unknown;
  readonly oldRecord: StoreRecord;
  readonly newRecord: StoreRecord;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `type` | `'updated'` | Diskriminant — vždy `'updated'` |
| `bucket` | `string` | Název bucketu |
| `key` | `unknown` | Primární klíč aktualizovaného záznamu |
| `oldRecord` | `StoreRecord` | Záznam před aktualizací |
| `newRecord` | `StoreRecord` | Záznam po aktualizaci |

**Poznámka:** `oldRecord` a `newRecord` obsahují pole metadat. Porovnejte `_version` pro zjištění počtu provedených aktualizací, nebo porovnejte jednotlivá pole pro detekci změn.

---

### `BucketDeletedEvent`

Publikováno, když je záznam smazán — ať už explicitně, expirací TTL nebo evikací `maxSize`.

```typescript
interface BucketDeletedEvent {
  readonly type: 'deleted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `type` | `'deleted'` | Diskriminant — vždy `'deleted'` |
| `bucket` | `string` | Název bucketu |
| `key` | `unknown` | Primární klíč smazaného záznamu |
| `record` | `StoreRecord` | Záznam, který byl smazán (snapshot v okamžiku smazání) |

---

### `BucketEvent`

Sjednocení všech typů událostí. Použijte jako typový parametr, když chcete zpracovávat všechny události genericky.

```typescript
type BucketEvent = BucketInsertedEvent | BucketUpdatedEvent | BucketDeletedEvent;
```

Diskriminujte podle pole `type`:

```typescript
await store.on<BucketEvent>('bucket.*.*', (event) => {
  switch (event.type) {
    case 'inserted':
      console.log('New record:', event.record);
      break;
    case 'updated':
      console.log('Changed:', event.oldRecord, '→', event.newRecord);
      break;
    case 'deleted':
      console.log('Removed:', event.record);
      break;
  }
});
```

---

### `BucketEventType`

Sjednocení řetězcových literálů diskriminantů typů událostí.

```typescript
type BucketEventType = 'inserted' | 'updated' | 'deleted';
```

---

## Emitování událostí

### Jednotlivé operace

Pro jednotlivá volání `insert`, `update` a `delete` na BucketHandle je událost publikována synchronně poté, co je mutace aplikována na store. Handler běží asynchronně — mutace se vrátí volajícímu dříve, než se spustí jakýkoli handler.

```typescript
const users = store.bucket('users');

await store.on<BucketInsertedEvent>('bucket.users.inserted', (event) => {
  // Toto se spustí poté, co insert() už vrátil výsledek
  console.log('Inserted:', event.record.name);
});

const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
// alice je už dostupná — handler běží asynchronně
```

### Události z transakcí

Uvnitř transakce se žádné události nepublikují. Události jsou shromažďovány během fáze commitu a publikovány až poté, co **všechny** buckety úspěšně potvrdí commit.

```typescript
const events: BucketEvent[] = [];
await store.on<BucketEvent>('bucket.*.*', (event) => {
  events.push(event);
});

await store.transaction(async (tx) => {
  const customers = await tx.bucket('customers');
  const orders = await tx.bucket('orders');

  await customers.insert({ name: 'Jan', email: 'jan@example.com' });
  await orders.insert({ customerId: 'c1', amount: 100, items: ['widget'] });
  // events.length === 0 — zatím nebyly publikovány žádné události
});

// Po dokončení commitu jsou obě události publikovány
```

Pokud je transakce vrácena zpět (callback vyhodí výjimku nebo dojde ke konfliktu při commitu), **žádné události se nepublikují**.

### TTL expirace

Když záznamy expirují kvůli TTL, pro každý expirovaný záznam je publikována událost `deleted`. Tyto události jsou identické s událostmi manuálního smazání — pole `type` je `'deleted'` a pole `record` obsahuje expirovaný záznam.

### MaxSize evikce

Když bucket dosáhne svého limitu `maxSize` a vyřadí nejstarší záznamy, pro každý vyřazený záznam je publikována událost `deleted`.

---

## Doručování událostí

### Pořadí

- **Jednotlivé operace:** Každá mutace publikuje přesně jednu událost. Události ze sekvenčních operací jsou publikovány v pořadí, v jakém se operace dokončí.
- **Transakce:** Události jsou publikovány v pořadí, v jakém byly shromážděny během commitu — bucket po bucketu, operace po operaci v rámci každého bucketu.
- **Více odběratelů:** Pořadí volání odběratelů není zaručeno. Nespoléhejte na to, že se jeden odběratel spustí před jiným.

### Izolace chyb

Chyby handlerů jsou izolovány od operace, která událost vyvolala, i od ostatních handlerů:

- Chyba vyhozená handlerem **nezpůsobí** rollback ani neovlivní původní mutaci.
- Chyba vyhozená handlerem **nezabrání** ostatním handlerům v přijetí události.
- Chyby handlerů by měly být zachyceny a zalogovány uvnitř handleru.

```typescript
await store.on<BucketEvent>('bucket.*.*', async (event) => {
  try {
    await auditLog.insert({
      action: event.type,
      bucket: event.bucket,
      key: event.key,
    });
  } catch (err) {
    console.error('Audit log failed:', err);
    // Původní operace už uspěla — zalogovat a pokračovat
  }
});
```

---

## Odhlášení

Funkce vrácená `store.on()` odebere handler z event busu. Je asynchronní a měla by být awaitována.

```typescript
const unsub = await store.on('bucket.users.*', (event) => {
  console.log(event.type);
});

// Později: odebrání handleru
await unsub();
```

Pokud zapomenete odhlásit odběr, dojde k úniku paměti — handlery jsou drženy event busem neomezeně dlouho, dokud není zavoláno `store.stop()`.

---

## Běžné vzory

### Auditní logování

```typescript
const auditLog = store.bucket('auditLog');

await store.on<BucketEvent>('bucket.*.*', async (event) => {
  if (event.bucket === 'auditLog') return; // prevence nekonečné rekurze

  await auditLog.insert({
    action: event.type,
    bucket: event.bucket,
    key: String(event.key),
    timestamp: Date.now(),
  });
});
```

### Detekce změn

```typescript
await store.on<BucketUpdatedEvent>('bucket.products.updated', (event) => {
  if (event.oldRecord.price !== event.newRecord.price) {
    console.log(
      `Price changed: ${event.oldRecord.price} → ${event.newRecord.price}`,
    );
  }
});
```

### Kaskádové mazání

```typescript
await store.on<BucketDeletedEvent>('bucket.customers.deleted', async (event) => {
  const orders = store.bucket('orders');
  const customerOrders = await orders.where({ customerId: event.key });
  for (const order of customerOrders) {
    await orders.delete(order.id);
  }
});
```

> **Upozornění:** Kaskádové mazání produkuje další události `deleted`. Chraňte se před nekonečnou rekurzí, když handlery zapisují zpět do bucketů, které spouštějí stejný handler.

---

## Integrace s reaktivními dotazy

Store interně odebírá `bucket.*.*` pro řízení přehodnocování reaktivních dotazů. Když nastane jakákoli událost bucketu, správce dotazů zkontroluje, které odběry závisí na dotčeném bucketu a klíči, a naplánuje přehodnocení. Toto je pro uživatelský kód transparentní — nemusíte ručně propojovat události s dotazy.

---

## Typy

### Exportované typy

Všechny typy událostí jsou veřejně exportovány z hlavního balíčku:

```typescript
import type {
  BucketEventType,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
  BucketEvent,
} from '@hamicek/noex-store';
```

### Metadata `StoreRecord` v událostech

Každý záznam v události obsahuje automatická pole metadat:

| Pole | Typ | Popis |
|------|-----|-------|
| `_version` | `number` | Verze záznamu, začíná na 1, inkrementuje se při každé aktualizaci |
| `_createdAt` | `number` | Unixový milisekundový timestamp vytvoření |
| `_updatedAt` | `number` | Unixový milisekundový timestamp poslední modifikace |
| `_expiresAt` | `number \| undefined` | Unixový milisekundový timestamp expirace (pouze buckety s TTL) |

U BucketUpdatedEvent obsahují `oldRecord` i `newRecord` své příslušné hodnoty metadat — porovnejte je, abyste viděli, jak se záznam vyvíjel.

## Viz také

- [Store API](./store.md) — signatura metody `store.on()` a životní cyklus store
- [Transakce](./transactions.md) — odložené emitování událostí po atomickém commitu
- [TTL a životní cyklus](./ttl-lifecycle.md) — TTL expirace a `maxSize` evikce produkující události `deleted`
- [Schéma a typy](./schema.md) — struktura `StoreRecord` a pole metadat
- [Rules Bridge](./bridge.md) — přeposílání událostí store do noex-rules
- [Chyby](./errors.md) — kompletní katalog chyb
- **Výuka:** [Systém událostí](../learn/06-udalosti/01-system-udalosti.md) — koncepční úvod do událostí
- **Výuka:** [Vzory událostí](../learn/06-udalosti/02-vzory-udalosti.md) — praktické příklady a cvičení
- **Zdrojový kód:** [`src/types/events.ts`](../../../src/types/events.ts)
- **Zdrojový kód:** [`src/core/bucket-server.ts`](../../../src/core/bucket-server.ts)
