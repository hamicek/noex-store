# Systém událostí

Váš store běží jako hodinky — záznamy se vkládají, aktualizují, mažou. Ale nic mimo bucket o tom neví. Dashboard se nemůže obnovit, když přijdou nová data. Auditní stopa musí pollovat změny. Vrstva pro invalidaci cache musí hádat, co se změnilo. Bez událostí je každý konzument vašich dat slepý.

noex-store publikuje událost pro každou mutaci. Přihlásíte se k odběru konkrétních událostí pomocí vzorů témat se zástupnými znaky a store je doručuje asynchronně přes svůj actor-based EventBus. Žádný polling, žádné hádání, žádné zmeškané změny.

## Co se naučíte

- Jaké události store publikuje a jaká data každá událost nese
- Jak `store.on(pattern, handler)` přihlašuje odběr událostí
- Jak vzory témat a zástupné znaky umožňují přesné filtrování událostí
- Jak se odhlásit, když události již nepotřebujete
- Jak události proudí od mutace v bucketu k vašemu handleru
- Jak se liší časování událostí mezi jednotlivými operacemi a transakcemi

## Příprava

Všechny příklady v této kapitole používají následující store:

```typescript
import { Store } from '@hamicek/noex-store';
import type {
  BucketEvent,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
} from '@hamicek/noex-store';

const store = await Store.start({ name: 'events-demo' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', required: true, format: 'email' },
    role:  { type: 'string', enum: ['admin', 'editor', 'viewer'], default: 'viewer' },
  },
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:     { type: 'number', generated: 'autoincrement' },
    userId: { type: 'string', required: true },
    total:  { type: 'number', required: true, min: 0 },
    status: { type: 'string', enum: ['pending', 'paid', 'shipped', 'cancelled'], default: 'pending' },
  },
  indexes: ['userId', 'status'],
});

const users = store.bucket('users');
const orders = store.bucket('orders');
```

## Tři typy událostí

Každá mutace v bucketu vyprodukuje přesně jednu událost. Existují tři typy:

### `BucketInsertedEvent`

Publikována při vytvoření nového záznamu pomocí `insert()`:

```typescript
interface BucketInsertedEvent {
  readonly type: 'inserted';
  readonly bucket: string;      // Název bucketu
  readonly key: unknown;        // Primární klíč nového záznamu
  readonly record: StoreRecord; // Kompletní záznam s metadaty
}
```

### `BucketUpdatedEvent`

Publikována při úpravě existujícího záznamu pomocí `update()`:

```typescript
interface BucketUpdatedEvent {
  readonly type: 'updated';
  readonly bucket: string;
  readonly key: unknown;
  readonly oldRecord: StoreRecord; // Stav před aktualizací
  readonly newRecord: StoreRecord; // Stav po aktualizaci
}
```

Událost aktualizace nese starý i nový stav, takže handlery mohou porovnat, co se změnilo, bez dotazování bucketu.

### `BucketDeletedEvent`

Publikována při odebrání záznamu pomocí `delete()`:

```typescript
interface BucketDeletedEvent {
  readonly type: 'deleted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord; // Záznam, který byl smazán
}
```

Smazaný záznam je zahrnut v události, takže handlery na něj mohou reagovat i poté, co zmizel z bucketu.

### Metadata záznamu v událostech

Každý záznam v události obsahuje automatická pole metadat:

| Pole | Typ | Popis |
|------|-----|-------|
| `_version` | `number` | Inkrementováno při každé aktualizaci, začíná na 1 |
| `_createdAt` | `number` | Unix milisekundový timestamp vytvoření (neměnný) |
| `_updatedAt` | `number` | Unix milisekundový timestamp poslední aktualizace |
| `_expiresAt` | `number?` | Unix milisekundový timestamp expirace záznamu (buckety s TTL) |

## Přihlášení k odběru pomocí `store.on()`

`store.on(pattern, handler)` registruje handler pro události odpovídající vzoru tématu. Vrací asynchronní funkci pro odhlášení:

```typescript
const unsub = await store.on<BucketInsertedEvent>(
  'bucket.users.inserted',
  (event) => {
    console.log(`Nový uživatel: ${event.record.name} (${event.key})`);
  },
);

// Insert spustí handler
await users.insert({ name: 'Alice', email: 'alice@example.com' });
// Konzole: Nový uživatel: Alice (some-uuid)

// Ukončení naslouchání
await unsub();
```

Handler přijímá dva argumenty:

| Argument | Typ | Popis |
|----------|-----|-------|
| `event` | `T` (generický) | Objekt události odpovídající vzoru |
| `topic` | `string` | Plný řetězec tématu (např. `'bucket.users.inserted'`) |

## Vzory témat a zástupné znaky

Události se publikují na témata ve formátu `bucket.{názevBucketu}.{typUdálosti}`. Můžete se přihlásit k přesným tématům nebo použít `*` jako zástupný znak pro libovolný segment:

| Vzor | Odpovídá |
|------|----------|
| `bucket.users.inserted` | Pouze insert události na bucketu `users` |
| `bucket.users.updated` | Pouze update události na bucketu `users` |
| `bucket.users.deleted` | Pouze delete události na bucketu `users` |
| `bucket.users.*` | Všechny události (insert, update, delete) na `users` |
| `bucket.*.inserted` | Insert události na všech bucketech |
| `bucket.*.*` | Všechny události na všech bucketech |

### Odběr všech událostí jednoho bucketu

```typescript
await store.on<BucketEvent>('bucket.users.*', (event, topic) => {
  console.log(`[${topic}] type=${event.type} key=${String(event.key)}`);
});

const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
// [bucket.users.inserted] type=inserted key=<uuid>

await users.update(alice.id, { role: 'admin' });
// [bucket.users.updated] type=updated key=<uuid>

await users.delete(alice.id);
// [bucket.users.deleted] type=deleted key=<uuid>
```

### Odběr jednoho typu události napříč všemi buckety

```typescript
await store.on<BucketInsertedEvent>('bucket.*.inserted', (event) => {
  console.log(`Nový záznam v ${event.bucket}: key=${String(event.key)}`);
});

await users.insert({ name: 'Bob', email: 'bob@example.com' });
// Nový záznam v users: key=<uuid>

await orders.insert({ userId: 'bob-id', total: 99.99 });
// Nový záznam v orders: key=1
```

### Globální listener — vše

```typescript
await store.on<BucketEvent>('bucket.*.*', (event) => {
  console.log(`${event.bucket}.${event.type}`);
});
```

Zachytí každou mutaci ve store. Použijte pro průřezové záležitosti jako logování nebo persistence.

## Rozlišování typů událostí

Pole `type` je řetězcový literál, takže TypeScript správně zužuje unii:

```typescript
await store.on<BucketEvent>('bucket.users.*', (event) => {
  switch (event.type) {
    case 'inserted':
      // TypeScript ví: event je BucketInsertedEvent
      console.log('Vytvořen:', event.record.name);
      break;

    case 'updated':
      // TypeScript ví: event je BucketUpdatedEvent
      console.log('Změněn:', event.oldRecord.name, '->', event.newRecord.name);
      break;

    case 'deleted':
      // TypeScript ví: event je BucketDeletedEvent
      console.log('Odebrán:', event.record.name);
      break;
  }
});
```

## Odhlášení z odběru

Každé volání `store.on()` vrací cleanup funkci. Zavoláním ukončíte příjem událostí:

```typescript
const events: BucketEvent[] = [];

const unsub = await store.on<BucketEvent>('bucket.users.*', (event) => {
  events.push(event);
});

await users.insert({ name: 'First', email: 'first@example.com' });
console.log(events.length); // 1

// Ukončení naslouchání
await unsub();

await users.insert({ name: 'Second', email: 'second@example.com' });
console.log(events.length); // 1 — handler se již nevolá
```

Vždy se odhlaste, když skončí životnost listeneru. Zapomenutí na odhlášení vytváří memory leak — EventBus drží referenci na váš handler neomezeně dlouho.

## Jak události proudí systémem

Když zavoláte `insert()`, `update()` nebo `delete()`, událost se publikuje poté, co operace uspěje uvnitř BucketServeru:

```text
  users.insert({ name: 'Alice', email: 'alice@example.com' })
      |
      v
  BucketHandle                  BucketServer (GenServer)
  +------------+   call()     +---------------------------------+
  | insert()   | -----------> | handle_call('insert', data)     |
  |            |              |                                 |
  |            |              |  1. Validace proti schématu     |
  |            |              |  2. Generování klíče + metadat  |
  |            |              |  3. Aktualizace indexů           |
  |            |              |  4. Uložení do paměti           |
  |            |              |  5. Publikování události:       |
  |            |              |     téma: bucket.users.inserted |
  |            |              |     payload: { type, bucket,    |
  |            |              |       key, record }             |
  |            | <----------- |  6. Odpověď se záznamem         |
  +------------+   reply      +---------------------------------+
      |
      v                       EventBus
  Volající dostane             +---------------------------+
  záznam                       | Doručení všem odpovídajícím|
                               | odběratelům:              |
                               |   bucket.users.inserted   |
                               |   bucket.users.*          |
                               |   bucket.*.inserted       |
                               |   bucket.*.*              |
                               +---------------------------+
```

Události se publikují synchronně uvnitř GenServeru, ale doručují se handlerům asynchronně. To znamená:

1. Mutace je vždy potvrzena dříve, než se spustí jakýkoliv handler
2. Handlery běží mimo smyčku zpráv GenServeru a nemohou blokovat budoucí operace
3. Pořadí spouštění handlerů mezi více odběrateli není garantováno

## Události v transakcích

Když k mutacím dochází uvnitř transakce, události se odloží, dokud neuspějí všechny commity bucketů:

```typescript
await store.on<BucketEvent>('bucket.*.*', (event) => {
  console.log(`${event.bucket}.${event.type}`);
});

await store.transaction(async (tx) => {
  const txUsers = await tx.bucket('users');
  const txOrders = await tx.bucket('orders');

  const user = await txUsers.insert({ name: 'Carol', email: 'carol@example.com' });
  await txOrders.insert({ userId: user.id, total: 250 });

  // Zatím žádné události — stále uvnitř transakce
});

// Po commitu se obě události publikují:
// users.inserted
// orders.inserted
```

Pokud transakce selže a provede rollback, žádné události se nepublikují. To garantuje, že handlery nikdy neuvidí částečný nebo nevalidní stav.

```text
  Transakce
  +-----------------------------------------------+
  |                                                 |
  |  1. Insert user   -> bufferováno, zatím žádná  |
  |                      událost                    |
  |  2. Insert order  -> bufferováno, zatím žádná  |
  |                      událost                    |
  |                                                 |
  |  Commit:                                        |
  |    Aplikace insertu uživatele -> úspěch        |
  |    Aplikace insertu objednávky -> úspěch       |
  |                                                 |
  |  Vše uspělo -> publikování VŠECH událostí      |
  |                                                 |
  +-----------------------------------------------+
      |
      v
  EventBus přijímá:
    bucket.users.inserted
    bucket.orders.inserted
```

## Více odběratelů

Můžete registrovat více handlerů pro stejný vzor. Každý obdrží vlastní kopii události:

```typescript
// Handler 1: logování
await store.on<BucketEvent>('bucket.users.*', (event) => {
  console.log(`[LOG] ${event.type} na ${event.bucket}`);
});

// Handler 2: metriky
await store.on<BucketEvent>('bucket.users.*', (event) => {
  console.log(`[METRIKA] user_${event.type}_total++`);
});

await users.insert({ name: 'Dave', email: 'dave@example.com' });
// [LOG] inserted na users
// [METRIKA] user_inserted_total++
```

## Kompletní funkční příklad

Notifikační služba, která sleduje změny uživatelů a aktualizace objednávek:

```typescript
import { Store } from '@hamicek/noex-store';
import type {
  BucketEvent,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
} from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'event-system-demo' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true, format: 'email' },
    },
  });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:     { type: 'number', generated: 'autoincrement' },
      userId: { type: 'string', required: true },
      total:  { type: 'number', required: true, min: 0 },
      status: { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
    },
    indexes: ['userId', 'status'],
  });

  const users = store.bucket('users');
  const ordersBucket = store.bucket('orders');

  // --- Přihlášení k odběru událostí ---

  // 1. Logování všech mutací uživatelů
  const unsubUsers = await store.on<BucketEvent>('bucket.users.*', (event, topic) => {
    console.log(`[users] ${event.type} — téma: ${topic}`);
  });

  // 2. Reakce na konkrétní události objednávek
  const unsubOrderInsert = await store.on<BucketInsertedEvent>(
    'bucket.orders.inserted',
    (event) => {
      console.log(`[orders] Nová objednávka #${event.key} — celkem: $${event.record.total}`);
    },
  );

  const unsubOrderUpdate = await store.on<BucketUpdatedEvent>(
    'bucket.orders.updated',
    (event) => {
      const { oldRecord, newRecord } = event;
      if (oldRecord.status !== newRecord.status) {
        console.log(
          `[orders] Objednávka #${event.key} stav: ${oldRecord.status} -> ${newRecord.status}`,
        );
      }
    },
  );

  // 3. Globální listener pro metriky
  let mutationCount = 0;
  const unsubGlobal = await store.on<BucketEvent>('bucket.*.*', () => {
    mutationCount++;
  });

  // --- Provedení operací ---

  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  // [users] inserted — téma: bucket.users.inserted

  await users.update(alice.id, { name: 'Alice Smith' });
  // [users] updated — téma: bucket.users.updated

  const order = await ordersBucket.insert({ userId: alice.id, total: 150 });
  // [orders] Nová objednávka #1 — celkem: $150

  await ordersBucket.update(order.id, { status: 'paid' });
  // [orders] Objednávka #1 stav: pending -> paid

  await ordersBucket.update(order.id, { status: 'shipped' });
  // [orders] Objednávka #1 stav: paid -> shipped

  console.log(`\nCelkem mutací: ${mutationCount}`); // 5

  // --- Cleanup ---
  await unsubUsers();
  await unsubOrderInsert();
  await unsubOrderUpdate();
  await unsubGlobal();

  await store.stop();
}

main();
```

## Cvičení

S následující přípravou store:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('products', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true },
    price:    { type: 'number', required: true, min: 0 },
    category: { type: 'string', enum: ['electronics', 'clothing', 'food'] },
    active:   { type: 'boolean', default: true },
  },
});

const products = store.bucket('products');
```

Napište kód, který:

1. Přihlásí se k odběru všech událostí na bucketu `products` a sbírá je do pole
2. Přihlásí se pouze k událostem `deleted` a loguje název každého smazaného produktu
3. Vloží dva produkty, jednomu aktualizuje cenu a druhý smaže
4. Po všech operacích zaloguje celkový počet sebraných událostí a jejich typy
5. Odhlásí oba handlery

<details>
<summary>Řešení</summary>

```typescript
import type { BucketEvent, BucketDeletedEvent } from '@hamicek/noex-store';

// 1. Sbírání všech událostí produktů
const events: BucketEvent[] = [];
const unsubAll = await store.on<BucketEvent>('bucket.products.*', (event) => {
  events.push(event);
});

// 2. Logování názvů smazaných produktů
const unsubDeleted = await store.on<BucketDeletedEvent>(
  'bucket.products.deleted',
  (event) => {
    console.log(`Smazaný produkt: ${event.record.name}`);
  },
);

// 3. Provedení operací
const laptop = await products.insert({ name: 'Laptop', price: 999, category: 'electronics' });
const shirt = await products.insert({ name: 'T-Shirt', price: 25, category: 'clothing' });

await products.update(laptop.id, { price: 899 });
await products.delete(shirt.id);
// Konzole: Smazaný produkt: T-Shirt

// Čekání na asynchronní doručení událostí
await new Promise((resolve) => setTimeout(resolve, 50));

// 4. Logování výsledků
console.log(`Celkem událostí: ${events.length}`); // 4
console.log(`Typy: ${events.map((e) => e.type).join(', ')}`);
// Typy: inserted, inserted, updated, deleted

// 5. Odhlášení
await unsubAll();
await unsubDeleted();
```

</details>

## Shrnutí

- Store publikuje tři typy událostí: **`inserted`**, **`updated`** a **`deleted`** — jednu na mutaci
- **`BucketInsertedEvent`** nese nový záznam; **`BucketUpdatedEvent`** nese starý i nový stav; **`BucketDeletedEvent`** nese odebraný záznam
- **`store.on(pattern, handler)`** přihlašuje odběr událostí odpovídajících vzoru tématu a vrací asynchronní funkci pro odhlášení
- Témata mají formát **`bucket.{název}.{typ}`** — použijte `*` jako zástupný znak pro libovolný segment
- **`bucket.users.*`** zachytí všechny události jednoho bucketu; **`bucket.*.inserted`** zachytí jeden typ události napříč všemi buckety; **`bucket.*.*`** zachytí vše
- Události se publikují po úspěšné mutaci — handlery nikdy nevidí nepotvrzená data
- V transakcích se události odloží, dokud neuspějí všechny commity — selhavší transakce nepublikuje nic
- Více handlerů se může nezávisle přihlásit ke stejnému vzoru
- Vždy zavolejte funkci pro odhlášení, když skončí životnost listeneru, aby se předešlo memory leakům

---

Další: [Vzory událostí](./02-vzory-udalosti.md)
