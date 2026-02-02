# Nastavení Bridge

Váš store sleduje stavy skladu, akce uživatelů a stavy objednávek. Samostatný pravidlový engine vyhodnocuje byznys logiku — „pokud zásoby klesnou pod 10, označ k doobjednání" nebo „pokud uživatel zadá tři objednávky za minutu, spusť kontrolu podvodu." Ale pravidlový engine neví, kdy se data změní. Mohli byste store pollovat, ale to je plýtvání a zavádí latenci. Mohli byste duplikovat napojení na události ručně, ale to vás váže na konkrétní formáty témat a rozbije se při změně bucketů.

`bridgeStoreToRules()` řeší tento problém tak, že se přihlásí k odběru všech bucket událostí a přeposílá je jakémukoliv systému, který implementuje jedinou metodu `emit()`. Jedno volání funkce, automatický úklid a plná kontrola nad filtrováním a transformací. Bridge je záměrně jednosměrný — události ze store tečou ven k příjemci — čímž izoluje interní smyčku událostí store od selhání downstream systémů.

## Co se naučíte

- Co vyžaduje rozhraní `EventReceiver` a proč je minimální
- Jak `bridgeStoreToRules()` odebírá bucket události a přeposílá je
- Jak filtrovat události tak, aby k příjemci dorazily jen relevantní mutace
- Jak transformovat témata a data událostí před přeposláním
- Jak bridge zpracovává chyby příjemce bez ovlivnění store
- Jak bridge čistě ukončit pomocí vrácené funkce pro odhlášení

## Rozhraní EventReceiver

Bridge nezávisí přímo na `@hamicek/noex-rules`. Místo toho cílí na minimální rozhraní:

```typescript
interface EventReceiver {
  emit(topic: string, data: Record<string, unknown>): Promise<unknown>;
}
```

Jakýkoliv objekt s metodou `emit`, která přijímá řetězec tématu a datový objekt, vyhovuje. To znamená, že bridge funguje s:

- Pravidlovým enginem `@hamicek/noex-rules` (primární případ použití)
- Vlastním loggerem nebo analytickým pipeline
- Adaptérem pro frontu zpráv
- Testovým dvojníkem

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `emit` | `(topic: string, data: Record<string, unknown>) => Promise<unknown>` | Přijímá přeposílané události. Návratová hodnota je ignorována. |

Návratový typ je `Promise<unknown>` — bridge na nic nečeká. Volá `emit` stylem fire-and-forget, zachycuje a pohlcuje jakékoliv odmítnutí. Toto je záměrné designové rozhodnutí: selhávající příjemce nesmí nikdy blokovat nebo shodit EventBus store.

## Jak Bridge funguje

`bridgeStoreToRules()` přijímá store, příjemce a volitelnou konfiguraci. Přihlásí se k odběru `bucket.*.*` — každá mutace na každém bucketu — a přeposílá odpovídající události příjemci:

```text
  Store (EventBus)                    bridgeStoreToRules()              EventReceiver
  +------------------+               +------------------------+        +----------------+
  |                  |               |                        |        |                |
  | bucket.users.    | ─────────────>| 1. filter(event)?      |        |                |
  |   inserted       |               |    Ne  → přeskočit     |        |                |
  |                  |               |    Ano → pokračovat     |        |                |
  | bucket.orders.   | ─────────────>|                        |        |                |
  |   updated        |               | 2. mapTopic(topic)?    |        |                |
  |                  |               |    transformovat        |        |                |
  | bucket.sessions. | ─────────────>|    nebo propustit      |        |                |
  |   deleted        |               | 3. mapData(event)?     |───────>| emit(topic,    |
  |                  |               |    transformovat        |        |   data)        |
  +------------------+               |    nebo propustit      |        |                |
                                     |                        |        |                |
                                     | 4. receiver.emit()     |        +----------------+
                                     |    fire-and-forget     |
                                     +------------------------+
                                              |
                                     Vrací: unsubscribe()
```

### Krok za krokem

1. Bridge zavolá `store.on('bucket.*.*', handler)`, čímž se přihlásí k odběru všech bucket událostí
2. Pro každou událost zkontroluje predikát `filter` (pokud je poskytnut). Události, které neprojdou, jsou tiše zahozeny
3. Téma je volitelně transformováno pomocí `mapTopic`. Bez něj projde původní téma (např. `bucket.users.inserted`)
4. Data události jsou volitelně transformována pomocí `mapData`. Bez něj se přepošle celý objekt `BucketEvent`
5. Bridge zavolá `receiver.emit(finalTopic, finalData)` a zachytí jakékoliv odmítnutí
6. Vrácená funkce, po zavolání, odhlásí odběr z EventBus — žádné další přeposílání

## BridgeOptions

Všechny tři volby jsou volitelné. Vynechání všech přeposílá každou událost s jejím původním tématem a úplnými daty:

```typescript
interface BridgeOptions {
  readonly filter?: (event: BucketEvent) => boolean;
  readonly mapTopic?: (topic: string, event: BucketEvent) => string;
  readonly mapData?: (event: BucketEvent) => Record<string, unknown>;
}
```

| Volba | Typ | Výchozí | Účel |
|-------|-----|---------|------|
| `filter` | `(event: BucketEvent) => boolean` | Všechny události projdou | Vrátit `true` pro přeposlání, `false` pro přeskočení |
| `mapTopic` | `(topic: string, event: BucketEvent) => string` | Identita (původní téma) | Transformovat řetězec tématu před přeposláním |
| `mapData` | `(event: BucketEvent) => Record<string, unknown>` | Celý BucketEvent beze změn | Transformovat nebo zredukovat payload události |

## Příprava

Všechny příklady v této kapitole používají následující store:

```typescript
import { Store } from '@hamicek/noex-store';
import { bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BridgeOptions } from '@hamicek/noex-store';
import type { BucketEvent } from '@hamicek/noex-store';

const store = await Store.start({ name: 'bridge-demo' });

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
    status: { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
  },
  indexes: ['userId', 'status'],
});

const users = store.bucket('users');
const orders = store.bucket('orders');
```

## Základní Bridge — přeposílání všeho

Nejjednodušší použití přeposílá všechny události bez transformace:

```typescript
// Minimální příjemce, který loguje události
const receiver: EventReceiver = {
  async emit(topic, data) {
    console.log(`[rules] ${topic}`, data);
  },
};

const unbridge = await bridgeStoreToRules(store, receiver);

await users.insert({ name: 'Alice', email: 'alice@example.com' });
// [rules] bucket.users.inserted { type: 'inserted', bucket: 'users', key: '...', record: {...} }

await orders.insert({ userId: 'alice-id', total: 99 });
// [rules] bucket.orders.inserted { type: 'inserted', bucket: 'orders', key: 1, record: {...} }

// Zastavení přeposílání
await unbridge();
```

Po zavolání `unbridge()` žádné další události nedorazí k příjemci. Store pokračuje v normálním provozu.

## Filtrování událostí

Použijte `filter` pro přeposílání pouze konkrétních událostí. Filtr přijímá celý `BucketEvent` a vrací `true` pro přeposlání nebo `false` pro přeskočení.

### Filtrování podle bucketu

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.bucket === 'orders',
});

await users.insert({ name: 'Bob', email: 'bob@example.com' });
// Nic nepřeposláno — bucket users je odfiltrován

await orders.insert({ userId: 'bob-id', total: 200 });
// [rules] bucket.orders.inserted { ... }
```

### Filtrování podle typu události

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.type === 'inserted' || event.type === 'deleted',
});

const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
// Přeposláno — inserted

await users.update(alice.id, { role: 'admin' });
// NEPŘEPOSLÁNO — updaty jsou odfiltrovány

await users.delete(alice.id);
// Přeposláno — deleted
```

### Kombinace podmínek

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) =>
    event.bucket === 'orders' && event.type === 'updated',
});
// Přeposílá pouze updaty objednávek — užitečné pro sledování změn stavu
```

## Transformace témat

Použijte `mapTopic` pro změnu toho, jak příjemce vidí témata. To je užitečné, když příjemce očekává jinou konvenci pojmenování:

```typescript
// Konverze témat oddělených tečkou na témata oddělená dvojtečkou
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (topic) => topic.replace(/\./g, ':'),
});

await users.insert({ name: 'Alice', email: 'alice@example.com' });
// receiver.emit('bucket:users:inserted', ...)
```

### Prefix pro prostředí s více store

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (topic) => `store.primary.${topic}`,
});

// Téma se změní na: store.primary.bucket.users.inserted
```

### Zjednodušení témat

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (_topic, event) => `${event.bucket}.${event.type}`,
});

// Téma se změní na: users.inserted (odstraní prefix 'bucket.')
```

## Transformace dat událostí

Použijte `mapData` pro přetvarování payloadu před přeposláním. To je užitečné pro odstranění interních metadat, extrakci konkrétních polí nebo adaptaci na očekávané schéma příjemce.

### Extrakce pouze klíčových polí

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapData: (event) => ({
    type: event.type,
    bucket: event.bucket,
    key: event.key as string,
  }),
});

await users.insert({ name: 'Alice', email: 'alice@example.com' });
// receiver.emit('bucket.users.inserted', { type: 'inserted', bucket: 'users', key: 'abc-123' })
// Žádná data záznamu — pouze typ mutace a klíč
```

### Přeposlání dat záznamu bez metadat

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapData: (event) => {
    if (event.type === 'updated') {
      const { _version, _createdAt, _updatedAt, ...newData } = event.newRecord;
      const { _version: _v, _createdAt: _c, _updatedAt: _u, ...oldData } = event.oldRecord;
      return { type: event.type, bucket: event.bucket, oldData, newData };
    }

    const record = event.type === 'inserted' ? event.record : event.record;
    const { _version, _createdAt, _updatedAt, ...data } = record;
    return { type: event.type, bucket: event.bucket, data };
  },
});
```

## Kombinace všech tří voleb

Filter, mapTopic a mapData fungují společně. Pipeline je: nejprve filter, pak mapTopic, pak mapData:

```text
  BucketEvent dorazí
        │
        ├── filter(event) → false? → PŘESKOČIT
        │
        ├── filter(event) → true (nebo bez filtru)
        │
        ├── mapTopic(topic, event) → finalTopic
        │
        ├── mapData(event) → finalData
        │
        └── receiver.emit(finalTopic, finalData)
```

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  // Přeposílat pouze mutace objednávek
  filter: (event) => event.bucket === 'orders',

  // Zjednodušený formát tématu
  mapTopic: (_topic, event) => `order.${event.type}`,

  // Poslat pouze byznysově relevantní data
  mapData: (event) => ({
    orderId: event.key as number,
    type: event.type,
    ...(event.type === 'updated'
      ? { status: event.newRecord.status, total: event.newRecord.total }
      : event.type === 'inserted'
        ? { status: event.record.status, total: event.record.total }
        : { status: event.record.status }),
  }),
});

await orders.insert({ userId: 'alice-id', total: 150 });
// receiver.emit('order.inserted', { orderId: 1, type: 'inserted', status: 'pending', total: 150 })
```

## Odolnost vůči chybám

Bridge používá sémantiku fire-and-forget. Pokud příjemce vyhodí výjimku nebo odmítne promise, chyba je zachycena a pohlcena:

```typescript
const flakyReceiver: EventReceiver = {
  async emit() {
    throw new Error('Network timeout');
  },
};

const unbridge = await bridgeStoreToRules(store, flakyReceiver);

// Tento insert proběhne normálně — chyba příjemce se nepropaguje
const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
console.log(alice.name); // 'Alice'

// EventBus store, reaktivní dotazy a persistence nejsou ovlivněny
```

Toto je kritické pro produkční spolehlivost. Pomalý nebo selhávající pravidlový engine nesmí nikdy degradovat výkon zápisů store ani blokovat jeho interní zpracování událostí.

## Ukončení

Funkce vrácená z `bridgeStoreToRules()` odhlásí odběr z EventBus:

```typescript
const unbridge = await bridgeStoreToRules(store, receiver);

// Události jsou přeposílány...
await users.insert({ name: 'Alice', email: 'alice@example.com' });
// receiver.emit zavolán

// Ukončení bridge
await unbridge();

// Události již nejsou přeposílány
await users.insert({ name: 'Bob', email: 'bob@example.com' });
// receiver.emit NEZAVOLÁN
```

Zavolejte `unbridge()` během ukončování aplikace, při opětovném připojení k jinému příjemci nebo když bridge již není potřeba. Store pokračuje v normálním provozu po ukončení.

## Kompletní funkční příklad

Bridge, který přeposílá změny stavu objednávek do mock pravidlového enginu, s filtrováním, transformací témat a čistým ukončením:

```typescript
import { Store, bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BucketEvent } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'bridge-example' });

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

  // Mock pravidlový engine, který sbírá přijaté události
  const received: Array<{ topic: string; data: Record<string, unknown> }> = [];
  const ruleEngine: EventReceiver = {
    async emit(topic, data) {
      received.push({ topic, data });
    },
  };

  // Bridge pouze pro události objednávek, se zjednodušenými tématy a minimálními daty
  const unbridge = await bridgeStoreToRules(store, ruleEngine, {
    filter: (event) => event.bucket === 'orders',
    mapTopic: (_topic, event) => `order.${event.type}`,
    mapData: (event) => ({
      orderId: event.key as number,
      type: event.type,
    }),
  });

  // Tyto události uživatelů jsou odfiltrovány — pravidlový engine je nevidí
  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  const bob = await users.insert({ name: 'Bob', email: 'bob@example.com' });

  // Tyto události objednávek projdou přes bridge
  const order1 = await ordersBucket.insert({ userId: alice.id as string, total: 100 });
  const order2 = await ordersBucket.insert({ userId: bob.id as string, total: 250 });
  await ordersBucket.update(order1.id, { status: 'paid' });
  await ordersBucket.update(order2.id, { status: 'paid' });
  await ordersBucket.update(order2.id, { status: 'shipped' });

  // Čekání na asynchronní doručení událostí
  await new Promise((resolve) => setTimeout(resolve, 50));

  console.log(`Události přijaté pravidlovým enginem: ${received.length}`);
  // Události přijaté pravidlovým enginem: 5

  for (const { topic, data } of received) {
    console.log(`  ${topic} — orderId: ${data.orderId}`);
  }
  // order.inserted — orderId: 1
  // order.inserted — orderId: 2
  // order.updated — orderId: 1
  // order.updated — orderId: 2
  // order.updated — orderId: 2

  // Čisté ukončení
  await unbridge();
  await store.stop();
}

main();
```

## Cvičení

Budujete notifikační systém. Store má buckety `users` a `tickets`. Pravidlový engine by měl přijímat události pouze tehdy, když:

- Je vytvořen nový tiket (inserted)
- Priorita tiketu se změní z jakékoliv hodnoty na `'critical'`

Pravidlový engine očekává témata ve formátu `notifications:{eventType}` a data obsahující pouze `{ ticketId, userId, priority }`.

S tímto nastavením:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

await store.defineBucket('tickets', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    userId:   { type: 'string', required: true },
    title:    { type: 'string', required: true },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  },
});

const ruleEngine: EventReceiver = {
  async emit(topic, data) {
    console.log(`[rule] ${topic}`, data);
  },
};
```

1. Napište funkci `filter`, která propustí pouze inserty tiketů a updaty, kde se priorita změnila na `'critical'`
2. Napište funkci `mapTopic`, která produkuje `notifications:created` nebo `notifications:escalated`
3. Napište funkci `mapData`, která vrací `{ ticketId, userId, priority }`
4. Zavolejte `bridgeStoreToRules` se všemi třemi volbami
5. Otestujte vložením tiketu, aktualizací na `'critical'` a aktualizací uživatele (měl by být odfiltrován)

<details>
<summary>Řešení</summary>

```typescript
import { bridgeStoreToRules } from '@hamicek/noex-store';
import type { BucketEvent } from '@hamicek/noex-store';

const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  filter: (event: BucketEvent) => {
    if (event.bucket !== 'tickets') return false;
    if (event.type === 'inserted') return true;
    if (event.type === 'updated') {
      return event.newRecord.priority === 'critical'
        && event.oldRecord.priority !== 'critical';
    }
    return false;
  },

  mapTopic: (_topic, event) => {
    const action = event.type === 'inserted' ? 'created' : 'escalated';
    return `notifications:${action}`;
  },

  mapData: (event) => {
    const record = event.type === 'updated' ? event.newRecord : event.record;
    return {
      ticketId: event.key as number,
      userId: record.userId as string,
      priority: record.priority as string,
    };
  },
});

const ticketsBucket = store.bucket('tickets');
const usersBucket = store.bucket('users');

// Vložení tiketu — projde filtrem (inserted + bucket tickets)
await ticketsBucket.insert({ userId: 'user-1', title: 'Login broken', priority: 'medium' });
// [rule] notifications:created { ticketId: 1, userId: 'user-1', priority: 'medium' }

// Aktualizace na critical — projde filtrem (priorita se změnila na critical)
await ticketsBucket.update(1, { priority: 'critical' });
// [rule] notifications:escalated { ticketId: 1, userId: 'user-1', priority: 'critical' }

// Aktualizace na high — NEPROJDE filtrem (priorita není critical)
await ticketsBucket.update(1, { priority: 'high' });
// Nic — odfiltrováno

// Vložení uživatele — NEPROJDE filtrem (špatný bucket)
await usersBucket.insert({ name: 'Alice' });
// Nic — odfiltrováno

await unbridge();
```

Filtr používá zúžení diskriminovaného sjednocení: když `event.type === 'updated'`, TypeScript ví, že událost má `oldRecord` a `newRecord`. Funkce `mapTopic` mapuje `inserted` na `created` a `updated` na `escalated`. Funkce `mapData` vybírá správný záznam (`newRecord` pro updaty, `record` pro inserty) a extrahuje pouze pole, která pravidlový engine potřebuje.

</details>

## Shrnutí

- **`EventReceiver`** je minimální rozhraní s jedinou metodou `emit(topic, data)` — žádná závislost na `@hamicek/noex-rules`
- **`bridgeStoreToRules(store, receiver, options?)`** se přihlásí k odběru `bucket.*.*` a přeposílá odpovídající události příjemci
- Bridge vrací **asynchronní funkci pro ukončení**, která odhlásí odběr z EventBus
- **`filter`** řídí, které události dorazí k příjemci — vrátit `true` pro přeposlání, `false` pro přeskočení
- **`mapTopic`** transformuje řetězec tématu před přeposláním — užitečné pro adaptaci na konvenci pojmenování příjemce
- **`mapData`** transformuje nebo redukuje payload události — odstranění metadat, extrakce polí nebo přetvarování pro schéma příjemce
- Zpracovatelský pipeline je: **filter** (přeskočit nebo pokračovat) → **mapTopic** (transformace tématu) → **mapData** (transformace dat) → **emit**
- Chyby příjemce jsou **zachyceny a pohlceny** — selhávající nebo pomalý příjemce nikdy neblokuje ani neshodí EventBus store
- Bridge je **jednosměrný**: události ze store tečou k příjemci, ale příjemce nemůže posílat události zpět přes bridge

---

Další: [Pravidla řízená Storem](./02-pravidla-rizena-storem.md)
