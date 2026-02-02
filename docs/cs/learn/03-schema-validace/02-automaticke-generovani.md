# Automatické generování

Každý záznam potřebuje identifikátor. Mnoho záznamů také potřebuje časové razítko vytvoření. Psaní `crypto.randomUUID()` a `Date.now()` v každém volání insertu je únavné, náchylné k chybám a snadno se na to zapomene. Horší je, že různé části kódu mohou generovat ID v různých formátech — jeden modul používá UUID, další sekvenční čítače, třetí náhodné řetězce.

noex-store přesouvá generování ID a časových razítek do schématu. Deklarujte `generated` na poli a Store ho automaticky vyplní při každém insertu — konzistentně, správně, pokaždé.

## Co se naučíte

- Čtyři generované typy: `uuid`, `cuid`, `autoincrement` a `timestamp`
- Kdy je který typ vhodný a jaké hodnoty produkuje
- Jak `default` poskytuje statické nebo vypočítané záložní hodnoty
- Pořadí priority: explicitní hodnota > generovaná > výchozí
- Jak se generovaná pole chovají při insertu vs updatu

## Generované typy

Pole s `generated` je automaticky vyplněno při vložení záznamu, pokud pole chybí ve vstupu:

```typescript
schema: {
  id: { type: 'string', generated: 'uuid' },
}
```

K dispozici jsou čtyři strategie:

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │                     GENEROVANÉ TYPY                                │
  │                                                                    │
  │  uuid           ─── '550e8400-e29b-41d4-a716-446655440000'        │
  │                     RFC 4122 v4, 128 bitů, globálně unikátní       │
  │                                                                    │
  │  cuid           ─── 'c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'         │
  │                     Odolný vůči kolizím, 33 znaků (c + 32 hex)     │
  │                                                                    │
  │  autoincrement  ─── 1, 2, 3, 4, …                                 │
  │                     Sekvenční celé číslo per bucket, začíná na 1   │
  │                                                                    │
  │  timestamp      ─── 1706745600000                                  │
  │                     Unix milisekundy přes Date.now()               │
  └──────────────────────────────────────────────────────────────────┘
```

### `uuid` — Universálně unikátní identifikátor

Generuje v4 UUID: 128 náhodných bitů formátovaných jako `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.

```typescript
await store.defineBucket('sessions', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
});

const sessions = store.bucket('sessions');

const s1 = await sessions.insert({ userId: 'alice' });
console.log(s1.id); // '550e8400-e29b-41d4-a716-446655440000'

const s2 = await sessions.insert({ userId: 'bob' });
console.log(s2.id); // 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
```

**Kdy použít:** Univerzální primární klíče. UUID jsou globálně unikátní bez koordinace, což je činí bezpečnými pro distribuované systémy a scénáře importu/exportu.

### `cuid` — ID odolné vůči kolizím

Generuje identifikátor odolný vůči kolizím: prefix `c` následovaný 32 hexadecimálními znaky.

```typescript
await store.defineBucket('events', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'cuid' },
    type: { type: 'string', required: true },
  },
});

const events = store.bucket('events');

const e = await events.insert({ type: 'click' });
console.log(e.id); // 'c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'
```

**Kdy použít:** Když potřebujete URL-safe, kompaktní ID, která jsou stále odolná vůči kolizím. CUID jsou kratší než UUID a neobsahují pomlčky ani speciální znaky.

### `autoincrement` — Sekvenční celé číslo

Používá čítač per bucket, který se zvyšuje s každým insertem. Začíná na 1.

```typescript
await store.defineBucket('invoices', {
  key: 'number',
  schema: {
    number: { type: 'number', generated: 'autoincrement' },
    amount: { type: 'number', required: true, min: 0 },
  },
});

const invoices = store.bucket('invoices');

const inv1 = await invoices.insert({ amount: 100 });
console.log(inv1.number); // 1

const inv2 = await invoices.insert({ amount: 250 });
console.log(inv2.number); // 2

const inv3 = await invoices.insert({ amount: 75 });
console.log(inv3.number); // 3
```

**Kdy použít:** Lidsky čitelné sekvenční identifikátory — čísla faktur, ID tiketů, čísla objednávek. Pozor: čítače autoincrement se ve výchozím stavu neperzistují; pokud restartujete Store bez persistence, čítač se resetuje na 1.

### `timestamp` — Unix milisekundy

Generuje aktuální časové razítko přes `Date.now()`.

```typescript
await store.defineBucket('logs', {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    message:   { type: 'string', required: true },
    createdAt: { type: 'number', generated: 'timestamp' },
  },
});

const logs = store.bucket('logs');

const log = await logs.insert({ message: 'Server started' });
console.log(log.createdAt); // 1706745600000 (Unix ms)
```

**Kdy použít:** Když potřebujete doménově specifické časové razítko oddělené od metadat záznamu `_createdAt`. Například `event.occurredAt` představující, kdy se něco stalo v reálném světě, ne kdy byl záznam vytvořen.

> **Poznámka:** Každý záznam již automaticky dostává metadata `_createdAt` a `_updatedAt`. Použijte `generated: 'timestamp'`, když potřebujete dodatečné, aplikační časové razítko.

## Volba správného generovaného typu

| Potřeba | Generovaný typ | Typ | Příklad hodnoty |
|---------|----------------|-----|-----------------|
| Globálně unikátní řetězcové ID | `'uuid'` | `'string'` | `'550e8400-e29b-…'` |
| Kompaktní, URL-safe ID | `'cuid'` | `'string'` | `'c9a1b2c3d4e5f…'` |
| Lidsky čitelné sekvenční číslo | `'autoincrement'` | `'number'` | `1`, `2`, `3` |
| Aktuální čas v milisekundách | `'timestamp'` | `'number'` | `1706745600000` |

## Výchozí hodnoty

Zatímco `generated` vytváří nové hodnoty algoritmicky, `default` poskytuje pevnou záložní hodnotu, když pole chybí. Výchozí hodnoty mají dvě formy:

### Statické výchozí hodnoty

Prostá hodnota použitá tak, jak je:

```typescript
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    name:   { type: 'string', required: true },
    role:   { type: 'string', default: 'viewer' },
    active: { type: 'boolean', default: true },
    score:  { type: 'number', default: 0 },
  },
});

const users = store.bucket('users');

const alice = await users.insert({ name: 'Alice' });
console.log(alice.role);   // 'viewer'
console.log(alice.active); // true
console.log(alice.score);  // 0
```

### Funkcionální výchozí hodnoty

Funkce volaná při každém insertu, produkující čerstvou hodnotu pokaždé. Nezbytné pro mutable typy jako pole a objekty:

```typescript
await store.defineBucket('profiles', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true },
    tags:     { type: 'array', default: () => [] },
    settings: { type: 'object', default: () => ({ theme: 'light', lang: 'en' }) },
  },
});

const profiles = store.bucket('profiles');

const p1 = await profiles.insert({ name: 'Alice' });
const p2 = await profiles.insert({ name: 'Bob' });

console.log(p1.tags);     // []
console.log(p2.tags);     // []
console.log(p1.tags === p2.tags); // false — odlišné instance pole
```

**Proč funkce pro pole a objekty?** Statická výchozí hodnota jako `default: []` by sdílela stejnou referenci pole napříč všemi záznamy. Mutace tagů jednoho záznamu by zmutovala všechny. Funkcionální výchozí hodnota vytváří novou instanci pro každý insert.

## Pořadí priority: Explicitní > Generovaná > Výchozí

Když má pole více zdrojů hodnot, priorita je:

```text
  ┌─────────────────────────────────────────────────────────────┐
  │                     PRIORITA HODNOT                           │
  │                                                               │
  │  1. Explicitní hodnota ─── poskytnuta ve vstupu insertu       │
  │     └─ použita tak, jak je, žádné generování ani default      │
  │                                                               │
  │  2. Generovaná         ─── pole má `generated` a žádnou       │
  │     └─ Store vygeneruje hodnotu            explicitní hodnotu │
  │                                                               │
  │  3. Výchozí            ─── pole má `default`, stále undefined │
  │     └─ aplikována statická hodnota nebo výsledek funkce       │
  │                                                               │
  │  4. undefined          ─── nic z výše uvedeného               │
  │     └─ pole chybí v záznamu                                   │
  └─────────────────────────────────────────────────────────────┘
```

To znamená, že generované pole můžete vždy přepsat explicitním zadáním hodnoty:

```typescript
await store.defineBucket('items', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

const items = store.bucket('items');

// Generované — Store vytvoří UUID
const auto = await items.insert({ name: 'Auto ID' });
console.log(auto.id); // 'a1b2c3d4-…' (vygenerované UUID)

// Explicitní — vaše hodnota je použita, generování přeskočeno
const manual = await items.insert({ id: 'custom-id-001', name: 'Manual ID' });
console.log(manual.id); // 'custom-id-001'
```

A pokud má pole jak `generated`, tak `default`, generovaná hodnota má přednost:

```typescript
schema: {
  id: { type: 'string', generated: 'uuid', default: 'fallback' },
}

// Když id chybí: použije se vygenerované UUID, ne 'fallback'
// Výchozí hodnota by se uplatnila pouze, kdyby pole nebylo generované
```

## Generovaná pole při updatu

Generovaná pole jsou **chráněna při updatu**. Store je odstraní z payloadu updatu, čímž zabrání náhodnému nebo záměrnému přepsání:

```typescript
const items = store.bucket('items');

const item = await items.insert({ name: 'Widget' });
console.log(item.id); // 'a1b2c3d4-…'

// Pokus o změnu generovaného id — tiše ignorováno
const updated = await items.update(item.id, { id: 'hacked-id', name: 'Updated Widget' });
console.log(updated.id);   // 'a1b2c3d4-…' (nezměněno)
console.log(updated.name); // 'Updated Widget' (změněno)
```

Tato ochrana se vztahuje na všechna generovaná pole, nejen na primární klíč. Pokud máte pole `createdAt` s `generated: 'timestamp'`, nelze ho přepsat přes `update()`.

Stejné odstraňování se uplatňuje na:
- **Primární klíč** — nelze nikdy změnit
- **Generovaná pole** — chráněna před updatem
- **Metadata pole** (`_version`, `_createdAt`, `_updatedAt`) — spravována Store

## Kompletní funkční příklad

Bug tracker s generovanými ID, časovými razítky a výchozími hodnotami:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'auto-generation' });

  await store.defineBucket('bugs', {
    key: 'id',
    schema: {
      id:          { type: 'number', generated: 'autoincrement' },
      title:       { type: 'string', required: true, minLength: 5 },
      severity:    { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
      assignee:    { type: 'string' },
      reportedAt:  { type: 'number', generated: 'timestamp' },
      tags:        { type: 'array', default: () => [] },
      metadata:    { type: 'object', default: () => ({ source: 'manual' }) },
    },
  });

  const bugs = store.bucket('bugs');

  // Insert s minimálním vstupem — generated + defaults doplní zbytek
  const bug1 = await bugs.insert({ title: 'Login page crashes on submit' });
  console.log('Bug #' + String(bug1.id));         // Bug #1
  console.log('Závažnost:', bug1.severity);          // medium (výchozí)
  console.log('Nahlášeno v:', bug1.reportedAt);      // 1706745600000 (generovaný timestamp)
  console.log('Tagy:', bug1.tags);                   // [] (funkcionální výchozí)
  console.log('Metadata:', bug1.metadata);           // { source: 'manual' } (funkcionální výchozí)

  // Insert s explicitními přepisy
  const bug2 = await bugs.insert({
    title: 'Database timeout on large queries',
    severity: 'critical',
    assignee: 'alice',
    tags: ['backend', 'performance'],
    metadata: { source: 'monitoring', alertId: 'ALT-42' },
  });
  console.log('\nBug #' + String(bug2.id));         // Bug #2
  console.log('Závažnost:', bug2.severity);            // critical (explicitní, ne výchozí)
  console.log('Tagy:', bug2.tags);                     // ['backend', 'performance'] (explicitní)

  // Pokus přepsat generovaná pole přes update — tiše odstraněno
  const updated = await bugs.update(bug1.id, {
    id: 999,                    // odstraněno — primární klíč
    reportedAt: 0,              // odstraněno — generované pole
    severity: 'high',           // aplikováno — běžné pole
  });
  console.log('\nPo updatu:');
  console.log('ID:', updated.id);                    // 1 (nezměněno)
  console.log('Nahlášeno v:', updated.reportedAt);   // 1706745600000 (nezměněno)
  console.log('Závažnost:', updated.severity);         // high (aktualizováno)
  console.log('Verze:', updated._version);             // 2 (zvýšeno Store)

  // Sekvenční autoincrement
  const bug3 = await bugs.insert({ title: 'Pagination offset off by one' });
  console.log('\nBug #' + String(bug3.id));          // Bug #3

  await store.stop();
}

main();
```

## Cvičení

Navrhujete objednávkový systém. Navrhněte schéma bucketu pro `orders` s těmito požadavky:

1. `id` — automaticky generované UUID
2. `orderNumber` — automaticky generované sekvenční číslo
3. `placedAt` — automaticky generované časové razítko (kdy byla objednávka zadána)
4. `status` — výchozí `'pending'`, omezeno na `['pending', 'processing', 'shipped', 'delivered']`
5. `items` — povinné, pole položek objednávky
6. `shippingAddress` — povinné, objekt
7. `notes` — volitelný řetězec, max 500 znaků
8. `priority` — výchozí `'standard'`, omezeno na `['express', 'standard', 'economy']`

Pak napište kód, který:
- Vloží objednávku pouze s `items` a `shippingAddress`
- Ověří, že `id`, `orderNumber`, `placedAt`, `status` a `priority` byly vyplněny automaticky
- Vloží druhou objednávku a ověří, že `orderNumber` se zvýšilo

<details>
<summary>Řešení</summary>

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'exercise' });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:              { type: 'string', generated: 'uuid' },
      orderNumber:     { type: 'number', generated: 'autoincrement' },
      placedAt:        { type: 'number', generated: 'timestamp' },
      status:          { type: 'string', enum: ['pending', 'processing', 'shipped', 'delivered'], default: 'pending' },
      items:           { type: 'array', required: true },
      shippingAddress: { type: 'object', required: true },
      notes:           { type: 'string', maxLength: 500 },
      priority:        { type: 'string', enum: ['express', 'standard', 'economy'], default: 'standard' },
    },
  });

  const orders = store.bucket('orders');

  // Insert pouze s povinnými poli
  const order1 = await orders.insert({
    items: [{ sku: 'WIDGET-01', qty: 2 }],
    shippingAddress: { street: '123 Main St', city: 'Prague', zip: '11000' },
  });

  // Ověření automaticky generovaných a výchozích polí
  console.log('ID:', typeof order1.id === 'string' && order1.id.length > 0);  // true
  console.log('Objednávka #:', order1.orderNumber);     // 1
  console.log('Zadáno v:', order1.placedAt > 0);        // true
  console.log('Status:', order1.status);                  // 'pending'
  console.log('Priorita:', order1.priority);              // 'standard'

  // Druhá objednávka — orderNumber se zvýší
  const order2 = await orders.insert({
    items: [{ sku: 'GADGET-05', qty: 1 }],
    shippingAddress: { street: '456 Oak Ave', city: 'Brno', zip: '60200' },
    priority: 'express',
  });
  console.log('Objednávka #:', order2.orderNumber);     // 2
  console.log('Priorita:', order2.priority);              // 'express' (explicitní přepis)

  await store.stop();
}

main();
```

</details>

## Shrnutí

- `generated: 'uuid'` vytváří v4 UUID — nejlepší pro globálně unikátní řetězcové ID
- `generated: 'cuid'` vytváří ID odolné vůči kolizím, kompaktní a URL-safe
- `generated: 'autoincrement'` používá sekvenční čítač per bucket začínající na 1
- `generated: 'timestamp'` zachytí aktuální čas jako Unix milisekundy
- `default` poskytuje statickou hodnotu nebo funkci produkující čerstvou hodnotu per insert
- Použijte funkcionální výchozí hodnoty (`default: () => []`) pro mutable typy, abyste se vyhnuli sdíleným referencím
- Pořadí priority: explicitní hodnota > generovaná > výchozí
- Generovaná pole a primární klíče jsou odstraněny z payloadu updatu — nelze je přepsat
- Metadata záznamu (`_version`, `_createdAt`, `_updatedAt`) jsou spravována Store automaticky

---

Další: [Unikátní omezení](./03-unikatni-omezeni.md)
