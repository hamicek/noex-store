# Obnova a snapshoty

Vaše aplikace spadla ve 3 ráno. Proces se restartuje automaticky, ale store začíná prázdný. Uživatelé vkládali záznamy, měnili nastavení a zadávali objednávky — to vše musí být zpět v paměti než dorazí první požadavek. Navíc potřebujete, aby autoincrement čítače pokračovaly tam, kde skončily, indexy byly dotazovatelné a unikátní omezení vynucená. Ruční orchestrace této obnovy je náchylná k chybám a úzce svazuje vaši startovací logiku s interním stavem každého bucketu.

noex-store zvládá obnovu automaticky. Když zavoláte `defineBucket()` na store s povolenou persistencí, store načte poslední snapshot z adaptéru, naplní in-memory tabulku bucketu, přestaví všechny indexy a obnoví autoincrement čítač. Žádný ruční zásah není potřeba.

## Co se naučíte

- Jak funguje průběh obnovy při restartu store
- Co `BucketSnapshot` obsahuje a jak se zachycuje
- Jak se indexy a unikátní omezení přestavují z obnovených dat
- Jak autoincrement čítače zachovávají kontinuitu napříč restarty
- Jak `store.stop()` garantuje finální flush před ukončením
- Jak uvažovat o okně ztráty dat

## Průběh obnovy

Když je bucket definován na store s persistencí, obnova probíhá uvnitř `defineBucket()`:

```text
  store.defineBucket('users', definition)
      |
      v
  Je persistence povolená A persistent !== false?
      |
      ano
      |
      v
  adapter.load('my-app:bucket:users')
      |
      +-- nalezen snapshot ──> Extrahovat záznamy + autoincrementCounter
      |                            |
      |                            v
      |                      Inicializovat BucketServer s obnovenými daty:
      |                        - Naplnit in-memory Map záznamy
      |                        - Nastavit autoincrementCounter
      |                        - Přestavět všechny indexy ze záznamů
      |                            |
      |                            v
      |                      Zaregistrovat bucket v persistence vrstvě
      |
      +-- žádný snapshot ──> Spustit prázdný bucket (normální init)
      |
      +-- chyba adaptéru ──> Nahlásit přes onError, spustit prázdný bucket
```

### Klíčové vlastnosti

| Vlastnost | Chování |
|-----------|---------|
| **Tichá obnova** | Během obnovy nejsou emitovány žádné události — EventBus nevidí obnovené záznamy jako inserty |
| **Automatická přestavba indexů** | Každý obnovený záznam projde přes `IndexManager.addRecord()`, přestavující sekundární i unikátní indexy |
| **Kontinuita autoincrementu** | Čítač pokračuje od persistované hodnoty — žádné kolize ID |
| **Bez re-validace** | Obnovené záznamy se považují za validní (byly validovány při původním insertu/updatu) |
| **Graceful degradation** | Pokud načtení selže, bucket začíná prázdný a chyba je nahlášena přes `onError` |

## BucketSnapshot

`BucketSnapshot` je atomická reprezentace kompletního stavu bucketu v daném okamžiku:

```typescript
interface BucketSnapshot {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `records` | `Array<[key, StoreRecord]>` | Všechny záznamy jako dvojice klíč-hodnota |
| `autoincrementCounter` | `number` | Aktuální hodnota autoincrement sekvence |

### Jak se snapshoty zachycují

Snapshoty se zachycují přes GenServer call do BucketServeru. To garantuje atomicitu — snapshot odráží přesný stav v okamžiku zpracování volání, bez prokládání souběžných mutací:

```text
  StorePersistence                    BucketServer
       |                                   |
       |  GenServer.call({ type: 'getSnapshot' })
       |---------------------------------->|
       |                                   |
       |                                   |  Zpracování zprávy:
       |                                   |    - Přečíst všechny záznamy z Map
       |                                   |    - Přečíst autoincrementCounter
       |                                   |    - Vrátit BucketSnapshot
       |                                   |
       |  BucketSnapshot                   |
       |<----------------------------------|
       |                                   |
       |  adapter.save(key, snapshot)       |
       |                                   |
```

Model souběžnosti GenServeru založený na mailboxu zajišťuje konzistenci snapshotu — pokud právě probíhá insert, buď se dokončí před snapshotem, nebo je zachycen v dalším.

### Co se persistuje

Snapshot je zabalen do obálky `PersistedState` s metadaty:

```text
  adapter.save("my-app:bucket:users", {
    state: {
      records: [
        ["id-1", { id: "id-1", name: "Alice", _version: 2, _createdAt: ..., _updatedAt: ... }],
        ["id-2", { id: "id-2", name: "Bob",   _version: 1, _createdAt: ..., _updatedAt: ... }],
      ],
      autoincrementCounter: 0
    },
    metadata: {
      persistedAt: 1704067200000,
      serverId: "my-app",
      schemaVersion: 1
    }
  })
```

Formát klíče úložiště je `<storeName>:bucket:<bucketName>`. Každý bucket je uložen nezávisle — načtení `users` nevyžaduje načtení `orders`.

## Přestavba indexů

Během obnovy BucketServer iteruje všechny obnovené záznamy a přidá je do `IndexManager`:

```text
  Obnovené záznamy: [Alice, Bob, Carol]
  Definice: indexes: ['email', 'role'], email má unique: true

  Pro každý záznam:
    indexManager.addRecord(key, record)
      |
      +-- Sekundární index 'email':  email -> Set<key>
      +-- Sekundární index 'role':   role  -> Set<key>
      +-- Unikátní index 'email':    email -> key  (vynucuje unikátnost)
```

Po obnově dotazy využívající indexovaná pole fungují na plnou rychlost — žádná degradace ve srovnání se store, který se nikdy nerestartoval:

```typescript
// Po restartu — indexy jsou přestavěny ze snapshotu
const admins = await store.bucket('users').where({ role: 'admin' });
// Používá přestavěný index 'role', ne plný scan

// Unikátní omezení jsou vynucena z přestavěného unikátního indexu
await store.bucket('users').insert({ name: 'Fake', email: 'alice@example.com' });
// Vyhodí UniqueConstraintError — unikátní index byl přestavěn ze snapshotu
```

## Kontinuita autoincrementu

Autoincrement čítač je součástí snapshotu. Po restartu nové záznamy dostávají další sekvenční ID:

```typescript
import { Store } from '@hamicek/noex-store';
import { MemoryAdapter } from '@hamicek/noex';

const adapter = new MemoryAdapter();

// První běh: vložení 3 objednávek (ID: 1, 2, 3)
const store1 = await Store.start({
  name: 'shop',
  persistence: { adapter },
});

await store1.defineBucket('orders', {
  key: 'id',
  schema: {
    id:      { type: 'number', generated: 'autoincrement' },
    product: { type: 'string', required: true },
  },
});

await store1.bucket('orders').insert({ product: 'Widget' });  // id: 1
await store1.bucket('orders').insert({ product: 'Gadget' });  // id: 2
await store1.bucket('orders').insert({ product: 'Gizmo' });   // id: 3
await store1.stop();

// Druhý běh: čítač pokračuje od 3
const store2 = await Store.start({
  name: 'shop',
  persistence: { adapter },
});

await store2.defineBucket('orders', {
  key: 'id',
  schema: {
    id:      { type: 'number', generated: 'autoincrement' },
    product: { type: 'string', required: true },
  },
});

const next = await store2.bucket('orders').insert({ product: 'Doohickey' });
console.log(next.id); // 4 — ne 1

await store2.stop();
```

Bez persistence autoincrementu by se čítač resetoval na 0 a další insert by dostal `id: 1`, kolidující s existujícím záznamem.

## Flush při ukončení

Když je zavolán `store.stop()`, persistence vrstva provede finální flush všech zaregistrovaných bucketů — nejen těch dirty. To garantuje uložení posledního stavu i pro buckety, které byly modifikovány méně než `debounceMs` milisekund zpátky:

```text
  store.stop()
      |
      v
  1. Zastavit TtlManager (žádné další kontroly expirace)
  2. Zničit QueryManager (žádné další reaktivní odběry)
  3. Odhlásit se z EventBus
      |
      v
  4. StorePersistence.stop()
      |
      v
     4a. Označit VŠECHNY zaregistrované buckety jako dirty
     4b. Flush (zrušit debounce časovač, persistovat všechny dirty)
     4c. Odhlásit se z EventBus
     4d. Zavřít adaptér (pokud adapter.close existuje)
      |
      v
  5. Zastavit Supervisor (ukončí všechny BucketServery)
  6. Zastavit EventBus
```

Pořadí je kritické: persistence flushuje **před** zastavením Supervisoru. Flush potřebuje posílat zprávy `getSnapshot` živým BucketServerům. Pokud by se Supervisor zastavil jako první, GenServer volání by selhala a data by se ztratila.

```typescript
// Mutace těsně před ukončením jsou bezpečné
await store.bucket('users').insert({ name: 'Záznam na poslední chvíli' });
await store.stop(); // Tento insert se zapíše do adaptéru
```

## Okno ztráty dat

Mezi debounce flushy existuje okno, kdy mutace existují pouze v paměti. Pokud proces během tohoto okna spadne, tyto mutace se ztratí:

```text
  Časová osa:
  ─────────────────────────────────────────────────>

  t=0     insert('Alice')    -> dirty, časovač spuštěn
  t=30    insert('Bob')      -> dirty
  t=100   FLUSH              -> Alice + Bob uloženi ✓
  t=130   insert('Carol')    -> dirty, časovač spuštěn
  t=150   PÁD!               -> Carol ztracena ✗
```

### Zmenšení okna

| Strategie | Kompromis |
|-----------|-----------|
| Snížit `debounceMs` (např. 10) | Častější zápisy, vyšší I/O |
| Použít `SQLiteAdapter` | Atomické zápisy, žádná částečná korupce souborů |
| Přijmout výchozí hodnotu (100ms) | Dobrá rovnováha pro většinu zátěží |

Záměrně neexistuje možnost synchronního zápisu per operace. Debounce model optimalizuje propustnost na úkor per-operační trvanlivosti — pokud potřebujete striktní garance trvanlivosti pro každý zápis, použijte externí databázi jako zdroj pravdy a store jako cache vrstvu.

## Persistence s transakcemi

Transakce interagují s persistencí přirozeně. Když se transakce potvrdí, aplikuje všechny bufferované zápisy do reálných bucketů. Každý bucket emituje události pro aplikované mutace. Persistence vrstva přijímá tyto události a označí dotčené buckety jako dirty:

```text
  store.transaction(async (tx) => {
    txCustomers.insert(...)   // bufferováno
    txOrders.insert(...)      // bufferováno
  })
      |
      v
  Commit: aplikovat do reálných bucketů
      |
      v
  Emitované události: bucket.customers.inserted, bucket.orders.inserted
      |
      v
  StorePersistence: označit 'customers' jako dirty, označit 'orders' jako dirty
      |
      v
  Debounce časovač vypršel -> snapshot obou bucketů
```

Selhavší transakce neemituje žádné události, takže persistence vrstva není nikdy spuštěna — konzistentní se sémantikou „nic se nestalo" vrácené transakce.

## Kompletní funkční příklad

Inventární systém demonstrující obnovu, přestavbu indexů, kontinuitu autoincrementu a per-bucket opt-out:

```typescript
import { Store, UniqueConstraintError } from '@hamicek/noex-store';
import { MemoryAdapter } from '@hamicek/noex';

async function main() {
  const adapter = new MemoryAdapter();

  // === První běh: naplnění store ===

  const store1 = await Store.start({
    name: 'inventory',
    persistence: { adapter },
  });

  await store1.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:      { type: 'string', required: true },
      name:     { type: 'string', required: true },
      price:    { type: 'number', required: true, min: 0 },
      category: { type: 'string', required: true },
    },
    indexes: ['category'],
  });

  await store1.defineBucket('orders', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      sku:      { type: 'string', required: true },
      quantity: { type: 'number', required: true, min: 1 },
    },
    indexes: ['sku'],
  });

  await store1.defineBucket('viewCount', {
    key: 'sku',
    schema: {
      sku:   { type: 'string', required: true },
      views: { type: 'number', required: true },
    },
    persistent: false, // Dočasná analytika — nepersistovaná
  });

  // Vložení produktů
  await store1.bucket('products').insert({
    sku: 'LAPTOP-1', name: 'Pro Laptop', price: 1299, category: 'electronics',
  });
  await store1.bucket('products').insert({
    sku: 'MOUSE-1', name: 'Wireless Mouse', price: 49, category: 'electronics',
  });
  await store1.bucket('products').insert({
    sku: 'DESK-1', name: 'Standing Desk', price: 599, category: 'furniture',
  });

  // Vložení objednávek (ID: 1, 2, 3)
  await store1.bucket('orders').insert({ sku: 'LAPTOP-1', quantity: 1 });
  await store1.bucket('orders').insert({ sku: 'MOUSE-1', quantity: 5 });
  await store1.bucket('orders').insert({ sku: 'LAPTOP-1', quantity: 2 });

  // Vložení počtů zobrazení (dočasné)
  await store1.bucket('viewCount').insert({ sku: 'LAPTOP-1', views: 1500 });

  console.log('=== První běh ===');
  console.log(`Produkty: ${await store1.bucket('products').count()}`);
  console.log(`Objednávky: ${await store1.bucket('orders').count()}`);
  console.log(`Počty zobrazení: ${await store1.bucket('viewCount').count()}`);

  await store1.stop();

  // === Druhý běh: ověření obnovy ===

  const store2 = await Store.start({
    name: 'inventory',
    persistence: { adapter },
  });

  await store2.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:      { type: 'string', required: true },
      name:     { type: 'string', required: true },
      price:    { type: 'number', required: true, min: 0 },
      category: { type: 'string', required: true },
    },
    indexes: ['category'],
  });

  await store2.defineBucket('orders', {
    key: 'id',
    schema: {
      id:       { type: 'number', generated: 'autoincrement' },
      sku:      { type: 'string', required: true },
      quantity: { type: 'number', required: true, min: 1 },
    },
    indexes: ['sku'],
  });

  await store2.defineBucket('viewCount', {
    key: 'sku',
    schema: {
      sku:   { type: 'string', required: true },
      views: { type: 'number', required: true },
    },
    persistent: false,
  });

  console.log('\n=== Druhý běh (po restartu) ===');

  // 1. Data obnovena
  console.log(`Produkty: ${await store2.bucket('products').count()}`);          // 3
  console.log(`Objednávky: ${await store2.bucket('orders').count()}`);          // 3
  console.log(`Počty zobrazení: ${await store2.bucket('viewCount').count()}`);  // 0 (nepersistované)

  // 2. Indexy fungují
  const electronics = await store2.bucket('products').where({ category: 'electronics' });
  console.log(`Elektronika: ${electronics.map((p) => p.name).join(', ')}`);

  const laptopOrders = await store2.bucket('orders').where({ sku: 'LAPTOP-1' });
  console.log(`Objednávky laptopů: ${laptopOrders.length}`); // 2

  // 3. Kontinuita autoincrementu
  const newOrder = await store2.bucket('orders').insert({ sku: 'DESK-1', quantity: 1 });
  console.log(`ID nové objednávky: ${newOrder.id}`); // 4 (pokračuje od 3)

  // 4. Metadata záznamů zachována
  const laptop = await store2.bucket('products').get('LAPTOP-1');
  console.log(`Verze laptopů: ${laptop?._version}`);          // 1
  console.log(`Laptop vytvořen: ${laptop?._createdAt}`);       // Původní časová značka

  // 5. Store je plně funkční po obnově
  await store2.bucket('products').update('LAPTOP-1', { price: 1199 });
  const updated = await store2.bucket('products').get('LAPTOP-1');
  console.log(`Cena laptopů: $${updated?.price}, verze: ${updated?._version}`); // $1199, verze 2

  await store2.stop();
}

main();
```

## Cvičení

Vytváříte task tracker. Store persistuje úlohy s autoincrement ID a nepersistentní bucket `activityLog`, který sleduje akce uživatelů.

```typescript
const adapter = new MemoryAdapter();

const store = await Store.start({
  name: 'task-tracker',
  persistence: { adapter },
});

await store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:          { type: 'number', generated: 'autoincrement' },
    title:       { type: 'string', required: true },
    status:      { type: 'string', enum: ['todo', 'in-progress', 'done'], default: 'todo' },
    assignee:    { type: 'string' },
  },
  indexes: ['status', 'assignee'],
});

await store.defineBucket('activityLog', {
  key: 'id',
  schema: {
    id:        { type: 'number', generated: 'autoincrement' },
    action:    { type: 'string', required: true },
    taskId:    { type: 'number', required: true },
    timestamp: { type: 'number', generated: 'timestamp' },
  },
  persistent: false,
});
```

1. Vložte 3 úlohy: „Design mockups" (todo, přiřazená: „Alice"), „Write tests" (in-progress, přiřazená: „Bob"), „Deploy v2" (todo).
2. Zalogujte aktivitu pro každé vložení úlohy (např. action: „created", taskId: ID úlohy).
3. Zastavte store a restartujte ho se stejným adaptérem. Znovu definujte oba buckety.
4. Po restartu: Kolik úloh existuje? Jaké je další autoincrement ID pro úlohy? Kolik záznamů v activity logu existuje?
5. Po restartu dotazujte úlohy se `status: 'todo'`. Funguje index?
6. Vložte novou úlohu. Jaké ID dostane?

<details>
<summary>Řešení</summary>

```typescript
const tasks = store.bucket('tasks');
const log = store.bucket('activityLog');

// 1. Vložení úloh
const t1 = await tasks.insert({ title: 'Design mockups', status: 'todo', assignee: 'Alice' });
const t2 = await tasks.insert({ title: 'Write tests', status: 'in-progress', assignee: 'Bob' });
const t3 = await tasks.insert({ title: 'Deploy v2', status: 'todo' });

// 2. Zalogování aktivit
await log.insert({ action: 'created', taskId: t1.id as number });
await log.insert({ action: 'created', taskId: t2.id as number });
await log.insert({ action: 'created', taskId: t3.id as number });

console.log(`Úlohy: ${await tasks.count()}`);          // 3
console.log(`Activity log: ${await log.count()}`);      // 3

// 3. Restart
await store.stop();

const store2 = await Store.start({
  name: 'task-tracker',
  persistence: { adapter },
});

await store2.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    title:    { type: 'string', required: true },
    status:   { type: 'string', enum: ['todo', 'in-progress', 'done'], default: 'todo' },
    assignee: { type: 'string' },
  },
  indexes: ['status', 'assignee'],
});

await store2.defineBucket('activityLog', {
  key: 'id',
  schema: {
    id:        { type: 'number', generated: 'autoincrement' },
    action:    { type: 'string', required: true },
    taskId:    { type: 'number', required: true },
    timestamp: { type: 'number', generated: 'timestamp' },
  },
  persistent: false,
});

const tasks2 = store2.bucket('tasks');
const log2 = store2.bucket('activityLog');

// 4. Po restartu
console.log(`Úlohy po restartu: ${await tasks2.count()}`);         // 3
console.log(`Activity log po restartu: ${await log2.count()}`);     // 0 (nepersistovaný)

// 5. Dotaz na index funguje — přestavěn ze snapshotu
const todoTasks = await tasks2.where({ status: 'todo' });
console.log(`Todo úlohy: ${todoTasks.length}`); // 2 (Design mockups, Deploy v2)
console.log(todoTasks.map((t) => t.title));
// Ano, index funguje, protože byl přestavěn z obnovených záznamů během defineBucket().

// 6. Nová úloha dostane ID 4 (autoincrement čítač obnoven ze snapshotu)
const t4 = await tasks2.insert({ title: 'Write docs', assignee: 'Carol' });
console.log(`ID nové úlohy: ${t4.id}`); // 4

await store2.stop();
```

</details>

## Shrnutí

- **Obnova je automatická**: volání `defineBucket()` na store s persistencí načte poslední snapshot, naplní in-memory tabulku, přestaví indexy a obnoví autoincrement čítač
- **`BucketSnapshot`** obsahuje všechny záznamy jako dvojice klíč-hodnota a autoincrement čítač — je to kompletní stav bucketu
- Snapshoty se zachycují **atomicky** přes GenServer call — žádné souběžné mutace se nemohou prokládá během zachycení
- **Indexy se přestavují** z obnovených záznamů, včetně unikátních indexů — dotazy `where()` a unikátní omezení fungují ihned po obnově
- **Autoincrement čítače** pokračují od persistované hodnoty — žádné kolize ID po restartu
- **Během obnovy nejsou emitovány žádné události** — EventBus nevidí obnovené záznamy jako inserty
- **`store.stop()`** provede finální flush **všech** zaregistrovaných bucketů před ukončením — persistence flushuje před zastavením BucketServerů Supervisorem
- **Okno ztráty dat** se rovná `debounceMs` — mutace v posledním debounce intervalu před pádem mohou být ztraceny
- **Chyby načtení** vedou ke graceful degradation — bucket začíná prázdný a chyba je nahlášena přes `onError`
- Transakce interagují přirozeně — potvrzené zápisy spouští události, které spouští persistenci; vrácené transakce nespouští nic

---

Další: [TTL expirace](../09-ttl-zivotni-cyklus/01-ttl-expirace.md)
