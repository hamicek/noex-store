# Strom supervize

Postavíte store se šesti buckety, necháte ho běžet hodiny a pak okrajový případ ve validaci schématu vyhodí neošetřenou chybu uvnitř aktoru jednoho bucketu. V tradiční architektuře tato chyba shodí celý proces — a všech šest bucketů spadne. Uživatelé ztratí přístup ke všemu, nejen k bucketu, který selhal. Přidáte try/catch bloky všude, ale některé chyby proklouznou. Potřebujete, aby byl každý bucket izolovaný, takže jeden výpadek nezpůsobí kaskádový pád.

noex-store je postaven na actor modelu (`@hamicek/noex`). Každý bucket běží jako nezávislý GenServer proces, spravovaný Supervisorem se strategií `one_for_one`. Pokud bucket spadne, supervisor restartuje pouze tento bucket. Ostatní buckety pokračují v obsluze požadavků, jako by se nic nestalo. Tato kapitola ukazuje přesnou strukturu stromu supervize, jak jsou procesy registrovány a proč tato architektura dělá store odolným.

## Co se naučíte

- Jak Store, Supervisor, BucketServer a EventBus tvoří procesní hierarchii
- Co znamená supervizní strategie `one_for_one` a proč se používá
- Jak BucketServer zapouzdřuje stav jako GenServer aktor
- Jak Registry pojmenovává procesy pro ladění a monitoring
- Jak `defineBucket()` a `dropBucket()` dynamicky modifikují strom
- Jak se graceful shutdown propaguje hierarchií

## Kompletní procesní strom

Když zavoláte `Store.start()`, store vytvoří strom supervize:

```text
  Store.start({ name: 'app' })
        │
        ├── EventBus ─────────────── "app:events"
        │
        ├── Supervisor ──────────── "app:supervisor"  (one_for_one)
        │       │
        │       ├── BucketServer ── "app:bucket:users"     (GenServer)
        │       ├── BucketServer ── "app:bucket:orders"    (GenServer)
        │       └── BucketServer ── "app:bucket:sessions"  (GenServer)
        │
        ├── QueryManager ────────── (in-process, není aktor)
        │
        ├── StorePersistence ────── (volitelný, odebírá z EventBus)
        │
        └── TtlManager ─────────── (volitelný, periodický setTimeout řetězec)
```

Store samotný není aktor — je to obyčejný TypeScript objekt, který drží reference na všechny pohyblivé části. Aktory jsou EventBus, Supervisor a BucketServery. QueryManager, StorePersistence a TtlManager jsou běžné objekty, které interagují s aktory prostřednictvím předávání zpráv.

## Supervisor

Supervisor je páteří odolnosti proti chybám. Spravuje podřízené procesy (BucketServery) a restartuje je, když selžou.

### Strategie one_for_one

```text
  Supervisor (one_for_one)
      │
      ├── BucketServer "users"     ← spadne
      ├── BucketServer "orders"    ← nedotčen, běží dál
      └── BucketServer "sessions"  ← nedotčen, běží dál
```

Se strategií `one_for_one`, když podřízený proces spadne, **pouze tento proces** je restartován. Sourozenci pokračují v běhu bez přerušení. Toto je správná strategie, když jsou podřízené procesy nezávislé — a buckety nezávislé jsou. Bucket users nepotřebuje bucket orders k fungování.

Srovnání s alternativami:

| Strategie | Při pádu potomka | Kdy použít |
|-----------|-----------------|------------|
| `one_for_one` | Restartuje pouze spadlého potomka | Potomci jsou nezávislí (buckety) |
| `one_for_all` | Restartuje všechny potomky | Potomci na sobě závisí |
| `rest_for_one` | Restartuje spadlého potomka a všechny potomky spuštěné po něm | Sekvenční závislosti |

noex-store používá `one_for_one`, protože každý bucket je samostatná jednotka s vlastními daty, schématem a indexy. Žádný bucket nezávisí na vnitřním stavu jiného bucketu.

### Jak se Supervisor spouští

Store vytváří supervisor během `Store.start()`:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'app' });

// V tomto bodě procesní strom vypadá takto:
//
//   Store
//     ├── EventBus ("app:events")
//     ├── Supervisor ("app:supervisor")  ← prázdný, žádní potomci
//     ├── TtlManager (nečinný)
//     └── QueryManager (prázdný)
```

Supervisor startuje s nulovým počtem potomků. BucketServery se přidávají dynamicky voláním `defineBucket()`.

## BucketServer: GenServer aktor

Každý bucket je zajištěn BucketServerem — GenServerem, který drží data bucketu a zpracovává všechny operace sekvenčně. Toto je architektonicky nejdůležitější koncept v noex-store.

### Proč GenServer?

GenServer zpracovává zprávy jednu po druhé, v pořadí. To eliminuje chyby souběžnosti bez zámků:

```text
  Požadavek A: insert({name: 'Alice'})  ──┐
  Požadavek B: update('key-1', {...})    ──┤     ┌──────────────┐
  Požadavek C: where({role: 'admin'})    ──┼────►│ BucketServer │──► Odpověď A
  Požadavek D: delete('key-2')           ──┤     │  (mailbox)   │──► Odpověď B
  Požadavek E: insert({name: 'Bob'})     ──┘     └──────────────┘──► Odpověď C
                                                                  ──► Odpověď D
                                                                  ──► Odpověď E
```

Zprávy se řadí do mailboxu a zpracovávají se sekvenčně. Zatímco BucketServer zpracovává požadavek A, požadavky B až E čekají. To vám dává serializovatelnou izolaci bez režie zamykání — každá operace vidí konzistentní snapshot dat.

### Vnitřní stav BucketServeru

Každý BucketServer udržuje čtyři části stavu:

```text
  ┌─────────────────────────────────────────────┐
  │              BucketServer                     │
  │                                               │
  │   ┌───────────────────────────────────────┐   │
  │   │  table: Map<PrimaryKey, StoreRecord>  │   │
  │   │                                       │   │
  │   │  Vlastní data. Mapa klíčovaná hodnotou│   │
  │   │  primárního klíče.                    │   │
  │   └───────────────────────────────────────┘   │
  │                                               │
  │   ┌─────────────────────┐  ┌──────────────┐  │
  │   │  SchemaValidator    │  │ IndexManager  │  │
  │   │                     │  │              │  │
  │   │  Validuje inserty   │  │ Unikátní a   │  │
  │   │  a updaty.          │  │ neunikátní   │  │
  │   │  Generuje hodnoty.  │  │ sekundární   │  │
  │   │  Připojuje metadata.│  │ indexy.      │  │
  │   └─────────────────────┘  └──────────────┘  │
  │                                               │
  │   autoincrementCounter: number                │
  │                                               │
  └─────────────────────────────────────────────┘
```

| Komponenta | Typ | Účel |
|------------|-----|------|
| `table` | `Map<unknown, StoreRecord>` | Primární úložiště dat, klíčované hodnotou primárního klíče |
| `validator` | `SchemaValidator` | Validuje data proti schématu, generuje automatické hodnoty, připojuje metadata |
| `indexManager` | `IndexManager` | Udržuje sekundární indexy (unikátní a neunikátní) pro rychlé vyhledávání |
| `autoincrementCounter` | `number` | Sleduje další hodnotu pro pole `generated: 'autoincrement'` |

Všechny čtyři žijí uvnitř stavu GenServeru. Nikdy se nesdílí s jinými aktory — každý bucket má vlastní validátor, index manager a datovou mapu.

### Protokol zpráv

BucketServer komunikuje výhradně přes `GenServer.call()` — synchronní mechanismus požadavek/odpověď. Volající pošle zprávu a čeká na odpověď:

```text
  BucketHandle                          BucketServer (GenServer)
       │                                       │
       │  GenServer.call(ref, {               │
       │    type: 'insert',                    │
       │    data: { name: 'Alice' }            │
       │  })                                   │
       │──────────────────────────────────────►│
       │                                       │  1. Validace schématu
       │                                       │  2. Generování hodnot
       │                                       │  3. Aktualizace indexů
       │                                       │  4. Uložení do tabulky
       │                                       │  5. Publikování události
       │                                       │
       │◄──────────────────────────────────────│
       │  reply: StoreRecord                   │
```

Kompletní sada typů zpráv:

| Kategorie | Zprávy |
|-----------|--------|
| **CRUD** | `insert`, `get`, `update`, `delete`, `clear` |
| **Dotazy** | `all`, `where`, `findOne`, `count`, `first`, `last`, `paginate` |
| **Agregace** | `sum`, `avg`, `min`, `max` |
| **Životní cyklus** | `purgeExpired`, `getSnapshot`, `getStats` |
| **Transakce** | `commitBatch`, `rollbackBatch`, `getAutoincrementCounter` |

Každá zpráva prochází stejným mailboxem. Neexistuje prioritní fronta — `get` čeká za `commitBatch`, pokud dorazil později.

## BucketHandle: Bezstavový proxy

BucketHandle je to, s čím interagujete v aplikačním kódu. Je to tenký wrapper, který posílá zprávy BucketServeru:

```text
  Aplikační kód               BucketHandle              BucketServer
        │                          │                          │
        │  users.insert(data)      │                          │
        │─────────────────────────►│                          │
        │                          │  GenServer.call(ref,     │
        │                          │    { type: 'insert',     │
        │                          │      data })             │
        │                          │─────────────────────────►│
        │                          │                          │  (zpracování)
        │                          │◄─────────────────────────│
        │                          │  reply: StoreRecord      │
        │◄─────────────────────────│                          │
        │  return StoreRecord      │                          │
```

BucketHandle drží pouze dvě věci: název bucketu a referenci na GenServer. Vytvoření více handle na stejný bucket je zdarma — všechny ukazují na stejného aktora:

```typescript
const a = store.bucket('users');
const b = store.bucket('users');
// a i b posílají zprávy stejnému BucketServer aktoru
// Žádná duplikace dat ani stavu
```

## Registrace a pojmenování procesů

Každý aktor ve stromu je registrován se jménem pro ladění a monitoring:

| Aktor | Vzor názvu | Příklad |
|-------|-----------|---------|
| EventBus | `{storeName}:events` | `app:events` |
| Supervisor | `{storeName}:supervisor` | `app:supervisor` |
| BucketServer | `{storeName}:bucket:{bucketName}` | `app:bucket:users` |

Tyto názvy se zobrazují v logech a chybových zprávách. Když BucketServer spadne, vidíte přesně, který bucket selhal:

```text
[Supervisor] Child "app:bucket:sessions" crashed: ValidationError: ...
[Supervisor] Restarting child "app:bucket:sessions" (one_for_one)
```

## Dynamická modifikace stromu

Strom supervize není statický. Buckety můžete přidávat a odebírat za běhu.

### Přidání bucketu: `defineBucket()`

```text
  store.defineBucket('products', definition)
        │
        ├── 1. Kontrola: název bucketu ještě není registrován
        │
        ├── 2. Načtení persistovaných dat (pokud je persistence zapnutá)
        │
        ├── 3. Vytvoření BucketServer behavioru
        │       (SchemaValidator, IndexManager, počáteční data)
        │
        ├── 4. Supervisor.startChild()
        │       → Spustí GenServer s behaviorem
        │       → Zaregistruje jako "app:bucket:products"
        │
        ├── 5. Registrace u StorePersistence (pokud je aktivní)
        │
        └── 6. Registrace u TtlManager (pokud je nastaveno ttl)
```

Každý krok je sekvenční. Bucket není dostupný pro CRUD, dokud nejsou dokončeny všechny kroky. Pokud je název bucketu již obsazen, `defineBucket()` vyhodí `BucketAlreadyExistsError`.

### Odebrání bucketu: `dropBucket()`

```text
  store.dropBucket('products')
        │
        ├── 1. Odregistrace z TtlManager
        │
        ├── 2. Odregistrace z StorePersistence
        │
        ├── 3. Supervisor.terminateChild('products')
        │       → Zastaví GenServer elegantně
        │       → Odstraní ze seznamu potomků supervisoru
        │
        └── 4. Odstranění z interních map store
```

Po `dropBucket()` je aktor ukončen a jeho data jsou pryč (pokud nejsou persistována). Volání `store.bucket('products')` po tomto vyhodí `BucketNotDefinedError`.

## Graceful shutdown

Když zavoláte `store.stop()`, vypnutí se propaguje stromem v určitém pořadí:

```text
  store.stop()
        │
        ├── 1. Zastavení TtlManager
        │       → Zrušení čekajícího setTimeout
        │       → Žádné další promazávací cykly
        │
        ├── 2. Flush StorePersistence
        │       → Označení všech bucketů jako dirty
        │       → Okamžité uložení snapshotů (bez debounce)
        │       → Zavření adaptéru
        │
        ├── 3. Zastavení Supervisoru
        │       → Ukončení všech BucketServer potomků
        │       → Každý GenServer zpracuje zbývající zprávy, pak skončí
        │
        └── 4. Zastavení EventBus
                → Žádné další doručování událostí
```

Pořadí je důležité. Persistence provádí flush **před** tím, než supervisor zastaví BucketServery — jinak by snapshoty obsahovaly zastaralá data (nebo by buckety již neexistovaly). EventBus se zastavuje **jako poslední**, protože persistence a další komponenty mohou publikovat události během vypínání.

## Kompletní funkční příklad

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  // 1. Spuštění store — vytvoří Supervisor, EventBus, TtlManager
  const store = await Store.start({ name: 'demo' });

  // 2. Definice bucketů — každý spustí BucketServer pod Supervisorem
  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', format: 'email', unique: true },
    },
    indexes: ['email'],
  });

  await store.defineBucket('logs', {
    key: 'id',
    schema: {
      id:      { type: 'number', generated: 'autoincrement' },
      action:  { type: 'string', required: true },
      userId:  { type: 'string', required: true },
    },
    indexes: ['userId'],
    ttl: '7d',
    maxSize: 100_000,
  });

  // Procesní strom nyní vypadá takto:
  //
  //   Store "demo"
  //     ├── EventBus ("demo:events")
  //     ├── Supervisor ("demo:supervisor")
  //     │     ├── BucketServer ("demo:bucket:users")
  //     │     └── BucketServer ("demo:bucket:logs")
  //     ├── TtlManager (sleduje "logs")
  //     └── QueryManager

  // 3. Použití bucketů — zprávy jdou přes BucketHandle → GenServer.call → BucketServer
  const users = store.bucket('users');
  const logs = store.bucket('logs');

  const alice = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  await logs.insert({ action: 'user.created', userId: alice.id as string });

  // 4. Kontrola statistik — každý BucketServer hlásí vlastní statistiky
  const stats = await store.getStats();
  console.log('Celkem bucketů:', stats.buckets.length);    // 2
  console.log('Počet users:', stats.buckets[0].recordCount); // 1
  console.log('Počet logs:', stats.buckets[1].recordCount);  // 1

  // 5. Odstranění bucketu — odstraní ho ze supervisoru
  await store.dropBucket('logs');

  // Strom je nyní:
  //   Supervisor
  //     └── BucketServer ("demo:bucket:users")

  // store.bucket('logs') by vyhodilo BucketNotDefinedError

  // 6. Graceful shutdown
  await store.stop();
}

main();
```

## Jak funguje izolace chyb

Uvažme, co se stane, když BucketServer narazí na nenapravitelnou chybu:

```text
  Čas     BucketServer "users"    BucketServer "orders"    Supervisor
  ─────  ──────────────────────  ───────────────────────  ────────────────
  t=0    Zpracovává insert       Zpracovává where         Monitoruje
  t=1    *** PÁD ***             Zpracovává where         Detekuje pád
  t=2    (mrtvý)                 Obsluhuje get            Restartuje "users"
  t=3    Reinicializace...       Obsluhuje update         Čeká na init
  t=4    Připraven (prázdný)     Obsluhuje insert         Potomek registrován
```

Klíčová pozorování:

1. **Žádná kaskáda**: Bucket orders si nikdy nevšiml, že bucket users spadl. Jeho mailbox, stav a zpracování pokračují bez přerušení.
2. **Automatický restart**: Supervisor detekuje pád a restartuje BucketServer s čerstvým stavem (prázdná tabulka, resetované indexy).
3. **Ztráta dat**: Restartovaný bucket začíná prázdný. Pokud je zapnutá persistence, bucket načte svůj poslední snapshot — ale jakékoliv zápisy mezi posledním snapshotem a pádem jsou ztraceny.
4. **Čekající požadavky selžou**: Jakýkoliv `GenServer.call()`, který byl v průběhu ke spadlému BucketServeru, obdrží chybu. `await` volajícího se odmítne s chybou.

## Cvičení

Navrhujete store pro multi-tenant SaaS aplikaci. Každý tenant má vlastní bucket `projects` a sdílený bucket `auditLog`. Je 50 tenantů.

1. Jak byste strukturovali názvy bucketů, aby data každého tenanta byla izolována?
2. Pokud bucket projects tenanta #23 spadne, co se stane s buckety projects ostatních 49 tenantů?
3. Pokud spadne bucket `auditLog`, ovlivní to bucket `projects` některého tenanta?
4. Potřebujete přidat nového tenanta za běhu (tenant #51 se zaregistruje). Jak přidáte jeho bucket bez restartu store?
5. Tenant zruší předplatné. Jak odeberete jeho bucket a uvolníte paměť?

<details>
<summary>Řešení</summary>

**1. Konvence pojmenování:**

Použijte prefixovou konvenci jako `tenant:{id}:projects`:

```typescript
for (let i = 1; i <= 50; i++) {
  await store.defineBucket(`tenant:${i}:projects`, {
    key: 'id',
    schema: {
      id:   { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
    },
  });
}

await store.defineBucket('auditLog', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    tenantId: { type: 'number', required: true },
    action:   { type: 'string', required: true },
  },
  indexes: ['tenantId'],
  ttl: '90d',
});
```

Každý tenant dostane samostatný BucketServer pod supervisorem. Konvence pojmenování `tenant:{id}:projects` jasně ukazuje, který aktor patří kterému tenantovi.

**2. Tenant #23 spadne:**

Nic se nestane ostatním 49 tenantům. Supervisor používá `one_for_one` — pouze `tenant:23:projects` je restartován. Tenanti 1-22 a 24-50 pokračují v provozu bez přerušení.

**3. auditLog spadne:**

Žádný efekt na bucket `projects` jakéhokoliv tenanta. auditLog je samostatný potomek pod stejným supervisorem. Jeho pád spustí restart pouze BucketServeru auditLog.

**4. Přidání nového tenanta za běhu:**

```typescript
await store.defineBucket('tenant:51:projects', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});
// Supervisor nyní má 52 potomků (51 tenant bucketů + auditLog)
```

`defineBucket()` interně volá `Supervisor.startChild()` — žádný restart není potřeba.

**5. Odebrání tenanta:**

```typescript
await store.dropBucket('tenant:42:projects');
// Supervisor nyní má 51 potomků
// BucketServer je ukončen a jeho data uvolněna
```

`dropBucket()` volá `Supervisor.terminateChild()`, zastaví GenServer a odstraní registraci.

</details>

## Shrnutí

- noex-store je postaven na **actor modelu** z `@hamicek/noex` — každý bucket je GenServer proces spravovaný Supervisorem
- **Supervisor** používá strategii `one_for_one`: když BucketServer spadne, pouze tento bucket je restartován — ostatní buckety nejsou dotčeny
- Každý **BucketServer** zapouzdřuje datovou Mapu, SchemaValidator, IndexManager a autoincrement čítač — nic se mezi buckety nesdílí
- **BucketHandle** je bezstavový proxy, který deleguje každou operaci na `GenServer.call()` — vytváření handle je zdarma
- Každý aktor je registrován se **jménem** (`{store}:bucket:{name}`) pro logování a ladění
- **`defineBucket()`** dynamicky přidává BucketServer do stromu supervize; **`dropBucket()`** ho odstraní a ukončí
- **Graceful shutdown** se propaguje v pořadí: TtlManager se zastaví, persistence provede flush, supervisor ukončí potomky, EventBus se zastaví jako poslední
- Pokud BucketServer spadne, čekající požadavky selžou, bucket se restartuje prázdný (nebo z posledního persistence snapshotu) a sourozenecké buckety pokračují bez přerušení

---

Další: [Tok dat](./02-tok-dat.md)
