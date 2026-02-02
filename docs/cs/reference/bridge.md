# Rules Bridge – Referenční příručka

> Přeposílá bucket události ze storu do externího event receiveru s podporou filtrování, mapování topiců a transformace dat.

## Přehled

Rules bridge propojuje instanci noex-store s libovolným systémem, který implementuje jedinou metodu `emit()` -- typicky `@hamicek/noex-rules` RuleEngine, ale také loggery, frontou zpráv nebo vlastní pipeline. Přihlásí se k odběru všech bucket událostí přes `bucket.*.*`, aplikuje volitelné filtrování a transformaci a odpovídající události přeposílá stylem fire-and-forget. Selhání receiveru se nikdy nepropaguje zpět do storu.

Bridge je záměrně jednosměrný: události ze storu proudí ven do receiveru. Pro opačný směr (pravidla zapisující zpět do storu) volají action handlery přímo metody storu -- žádné speciální API není potřeba.

## Import

```typescript
// Z hlavního balíčku
import { bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver, BridgeOptions } from '@hamicek/noex-store';

// Z dedikovaného vstupního bodu
import { bridgeStoreToRules } from '@hamicek/noex-store/bridge';
import type { EventReceiver, BridgeOptions } from '@hamicek/noex-store/bridge';
```

## API

### `bridgeStoreToRules(store, receiver, options?): Promise<() => Promise<void>>`

Přihlásí se k odběru všech bucket událostí na storu a přeposílá odpovídající události do receiveru. Vrací asynchronní teardown funkci, která odhlásí odběr z event busu.

**Parametry:**

| Parametr | Typ | Výchozí | Popis |
|----------|-----|---------|-------|
| `store` | `Store` | -- | Instance noex-store, ze které se přeposílají události |
| `receiver` | `EventReceiver` | -- | Libovolný objekt s metodou `emit(topic, data)` |
| `options` | `BridgeOptions` | `{}` | Volitelná konfigurace filtrování a transformace |

**Vrací:** `Promise<() => Promise<void>>` -- asynchronní teardown funkci. Jejím zavoláním se zastaví veškeré přeposílání událostí.

**Příklad:**

```typescript
import { Store, bridgeStoreToRules } from '@hamicek/noex-store';
import type { EventReceiver } from '@hamicek/noex-store';

const store = await Store.start({ name: 'my-app' });

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:    { type: 'number', generated: 'autoincrement' },
    total: { type: 'number', required: true, min: 0 },
  },
});

const receiver: EventReceiver = {
  async emit(topic, data) {
    console.log(topic, data);
  },
};

const unbridge = await bridgeStoreToRules(store, receiver);

await store.bucket('orders').insert({ total: 100 });
// receiver.emit zavoláno s topicem 'bucket.orders.inserted'

await unbridge();
// Žádné další události se nepřeposílají
```

---

## Pipeline zpracování událostí

Když dojde k mutaci bucketu, bridge ji zpracuje tímto pipeline:

```text
Příchod BucketEvent (přes store.on('bucket.*.*'))
      │
      ├── filter(event) → false? → PŘESKOČIT (událost je tiše zahozena)
      │
      ├── filter(event) → true (nebo filtr není definován)
      │
      ├── mapTopic(topic, event) → finalTopic (nebo původní topic bez mapTopic)
      │
      ├── mapData(event) → finalData (nebo celý BucketEvent bez mapData)
      │
      └── receiver.emit(finalTopic, finalData) — fire-and-forget
```

Pořadí je vždy: nejprve **filter**, potom **mapTopic**, potom **mapData** a nakonec **emit**. Pokud filtr událost odmítne, mapovací funkce se nikdy nezavolají.

---

## Typy

### `EventReceiver`

Minimální rozhraní, které musí receiver implementovat. Vyhýbá se tvrdé závislosti na `@hamicek/noex-rules`.

```typescript
interface EventReceiver {
  emit(topic: string, data: Record<string, unknown>): Promise<unknown>;
}
```

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `emit` | `(topic: string, data: Record<string, unknown>) => Promise<unknown>` | Přijímá přeposílané události. Návratová hodnota je bridgem ignorována. |

Kvalifikuje se jakýkoli objekt splňující toto rozhraní:

- `@hamicek/noex-rules` RuleEngine (primární případ použití)
- Vlastní logger nebo analytický pipeline
- Adaptér fronty zpráv
- Testovací double

**Příklad -- minimální receiver:**

```typescript
const receiver: EventReceiver = {
  async emit(topic, data) {
    console.log(`[event] ${topic}`, data);
  },
};
```

---

### `BridgeOptions`

Všechna pole jsou volitelná. Vynechání všech voleb přeposílá každou událost s původním topicem a celým `BucketEvent` jako daty.

```typescript
interface BridgeOptions {
  readonly filter?: (event: BucketEvent) => boolean;
  readonly mapTopic?: (topic: string, event: BucketEvent) => string;
  readonly mapData?: (event: BucketEvent) => Record<string, unknown>;
}
```

| Volba | Typ | Výchozí | Popis |
|-------|-----|---------|-------|
| `filter` | `(event: BucketEvent) => boolean` | Projdou všechny události | Vrátí `true` pro přeposlání události, `false` pro její přeskočení |
| `mapTopic` | `(topic: string, event: BucketEvent) => string` | Identita (původní topic) | Transformuje řetězec topicu před přeposláním |
| `mapData` | `(event: BucketEvent) => Record<string, unknown>` | Celý `BucketEvent` beze změny | Transformuje nebo redukuje payload události před přeposláním |

---

### `filter`

Řídí, které události se dostanou k receiveru. Funkce přijímá celý `BucketEvent` a vrací boolean.

**Příklad -- filtrování podle bucketu:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.bucket === 'orders',
});
```

**Příklad -- filtrování podle typu události:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.type === 'inserted' || event.type === 'deleted',
});
```

**Příklad -- složený filtr:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) =>
    event.bucket === 'orders' && event.type === 'updated',
});
```

---

### `mapTopic`

Transformuje řetězec topicu před přeposláním. Přijímá původní topic a událost. Pokud je vynechán, původní topic (např. `bucket.orders.inserted`) projde beze změny.

**Příklad -- tečka na dvojtečku jako oddělovač:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (topic) => topic.replaceAll('.', ':'),
});
// 'bucket.orders.inserted' → 'bucket:orders:inserted'
```

**Příklad -- přidání prefixu:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (topic) => `store.primary.${topic}`,
});
// 'bucket.orders.inserted' → 'store.primary.bucket.orders.inserted'
```

**Příklad -- zjednodušený topic z dat události:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapTopic: (_topic, event) => `${event.bucket}.${event.type}`,
});
// 'bucket.orders.inserted' → 'orders.inserted'
```

---

### `mapData`

Transformuje payload události před přeposláním. Přijímá celý `BucketEvent` a musí vrátit `Record<string, unknown>`. Pokud je vynechán, přepošle se celý objekt `BucketEvent`.

**Příklad -- extrakce pouze klíčových polí:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  mapData: (event) => ({
    bucket: event.bucket,
    eventType: event.type,
    key: event.key as string,
  }),
});
```

**Příklad -- kombinace všech tří voleb:**

```typescript
const unbridge = await bridgeStoreToRules(store, receiver, {
  filter: (event) => event.bucket === 'orders' && event.type === 'inserted',
  mapTopic: (_topic, event) => `order.${event.type}`,
  mapData: (event) => ({
    orderId: event.key as number,
    type: event.type,
  }),
});
```

---

## Zpracování chyb

Bridge používá fire-and-forget sémantiku. Volání `receiver.emit()` vrací promise, ale bridge na něj nečeká. Jakékoli odmítnutí je zachyceno a tiše spolknuto:

```typescript
// Interně:
receiver.emit(finalTopic, finalData).catch(() => {});
```

Jde o záměrné designové rozhodnutí:

- Selhávající nebo pomalý receiver **nikdy** neblokuje EventBus storu
- Selhávající receiver **nikdy** nezpůsobí selhání mutace storu
- Selhávající receiver **nikdy** nezabrání ostatním event handlerům v provedení

Store zůstává plně funkční bez ohledu na stav receiveru.

**Příklad -- odolnost vůči chybám receiveru:**

```typescript
const flakyReceiver: EventReceiver = {
  async emit() {
    throw new Error('Network timeout');
  },
};

const unbridge = await bridgeStoreToRules(store, flakyReceiver);

// Operace storu proběhnou normálně navzdory chybám receiveru
const record = await store.bucket('orders').insert({ total: 100 });
console.log(record); // { id: 1, total: 100, ... }
```

---

## Odpojení

Funkce vrácená z `bridgeStoreToRules()` odhlásí bridge handler z EventBusu storu. Je asynchronní a měla by být awaitována.

```typescript
const unbridge = await bridgeStoreToRules(store, receiver);

// Události se přeposílají...
await store.bucket('orders').insert({ total: 100 });

// Zastavení přeposílání
await unbridge();

// Události se již nepřeposílají
await store.bucket('orders').insert({ total: 200 });
// receiver.emit se NEVOLÁ
```

Zavolejte `unbridge()` při ukončování aplikace, při přepojování na jiný receiver nebo když bridge již není potřeba. Store po odpojení funguje zcela normálně.

Pokud zapomenete zavolat `unbridge()`, handler zůstane registrován na event busu. Bude uklizen při zavolání `store.stop()`.

---

## Obousměrná integrace

Bridge zajišťuje směr **store -> receiver** (jednosměrně). Pro směr **receiver -> store** (opačný) volají action handlery v rule engine přímo metody storu:

```text
┌───────────┐   bridge (události)  ┌──────────────┐
│           │ ──────────────────── │              │
│   Store   │                      │ Rule Engine  │
│           │ ◄────────────────── │              │
└───────────┘   akce (přímé volání └──────────────┘
                 metod storu)
```

Store nikdy neodkazuje na rule engine. Action handlery pravidel drží referenci na store (nebo bucket handle) a přímo volají `insert`, `update`, `delete`. Pro tento směr neexistuje žádné speciální bridge API.

**Prevence nekonečných smyček:** Když akce pravidel zapisují zpět do storu, tyto zápisy produkují nové události. Chraňte se před nekonečnou rekurzí pomocí:

1. **Filtrování podle bucketu** -- Přeposílejte přes bridge pouze "zdrojové" buckety; akce pravidel zapisují do "cílových" bucketů, které bridge ignoruje
2. **Filtrování podle obsahu** -- Použijte podmínky (guards) v handlerech pravidel, aby reagovaly pouze na konkrétní přechody stavů
3. **Oddělené instance bridge** -- Použijte více bridgů s různými filtry pro různé domény

**Příklad -- bezpečná zpětná smyčka:**

```typescript
// Přeposíláme pouze události objednávek do rule engine
const unbridge = await bridgeStoreToRules(store, ruleEngine, {
  filter: (event) => event.bucket === 'orders',
});

// Akce pravidla zapisuje do bucketu 'loyalty' — tato událost se NEPŘEPOSÍLÁ,
// protože filtr blokuje události jiných bucketů. Žádná nekonečná smyčka.
```

---

## Viz také

- [Události](./events.md) -- typy událostí, wildcardové vzory a `store.on()`, které bridge interně používá
- [Store API](./store.md) -- signatury metod `Store.start()` a `store.on()`
- [Transakce](./transactions.md) -- použití transakcí uvnitř action handlerů pravidel pro atomické vícebucketové aktualizace
- **Výuka:** [Nastavení bridge](../learn/11-propojeni-s-pravidly/01-nastaveni-bridge.md) -- podrobný tutoriál s cvičeními
- **Výuka:** [Pravidla řízená storem](../learn/11-propojeni-s-pravidly/02-pravidla-rizena-storem.md) -- vzory obousměrné integrace a prevence smyček
- **Zdrojový kód:** [`src/bridge/rules-bridge.ts`](../../../src/bridge/rules-bridge.ts)
