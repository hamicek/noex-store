# Tok dat

Zavoláte `users.insert({ name: 'Alice' })` a dostanete zpět plně zformovaný záznam s vygenerovaným UUID, metadatovými poli a zárukami validace. Ale co se vlastně stalo mezi vaším voláním a odpovědí? Které komponenty se dotkly dat, v jakém pořadí a odkud přišly události?

Pochopení toku dat je zásadní pro ladění, úvahy o výkonu a rozšiřování store. Když se něco pokazí — chyba validace, porušení unikátního omezení, neočekávaná událost — znalost přesného kroku v pipeline, který chybu vyvolal, vám řekne, kam se podívat. Tato kapitola trasuje kompletní životní cyklus každé mutace a dotazovací operace skrze vnitřnosti store.

## Co se naučíte

- Přesnou sekvenci kroků při insertu, od BucketHandle po uložený záznam
- Jak update slučuje změny, zvyšuje verzi a znovu validuje
- Jak delete čistí indexy a emituje události
- Jak dotazy rozhodují mezi vyhledáním v indexu a plným skenem tabulky
- Jak transakce dávkují operace napříč více buckety
- Jak události tečou z BucketServeru přes EventBus do reaktivních dotazů

## Insert: Kompletní cesta

Insert je nejkomplexnější operace, protože zahrnuje každou komponentu. Zde je kompletní cesta:

```text
  Aplikační kód
        │
        │  users.insert({ name: 'Alice', email: 'alice@example.com' })
        │
        ▼
  BucketHandle
        │
        │  GenServer.call(ref, { type: 'insert', data: { name: 'Alice', ... } })
        │
        ▼
  BucketServer (GenServer mailbox)
        │
        ├── 1. Inkrementace autoincrement čítače
        │
        ├── 2. SchemaValidator.prepareInsert(data, counter)
        │       │
        │       ├── Kopírování vstupních dat
        │       ├── Generování hodnot (uuid, cuid, autoincrement, timestamp)
        │       ├── Aplikace výchozích hodnot (statických nebo funkčních)
        │       ├── Připojení metadat:
        │       │     _version = 1
        │       │     _createdAt = Date.now()
        │       │     _updatedAt = Date.now()
        │       ├── Validace všech polí proti schématu
        │       │     → Při selhání: throw ValidationError (záznam NENÍ uložen)
        │       └── Vrácení připraveného StoreRecord
        │
        ├── 3. Extrakce primárního klíče z připraveného záznamu
        │
        ├── 4. TTL kontrola: pokud bucket má ttl A záznam nemá _expiresAt
        │       → Nastavení _expiresAt = _createdAt + ttlMs
        │
        ├── 5. MaxSize kontrola: pokud table.size >= maxSize
        │       → Evikce nejstarších záznamů (podle _createdAt) dokud není pod limitem
        │       → Každá evikce: odstranění z indexů, smazání z tabulky, emitování události
        │
        ├── 6. IndexManager.addRecord(key, record)
        │       │
        │       ├── Fáze 1: Validace VŠECH unikátních omezení
        │       │     → Při konfliktu: throw UniqueConstraintError (žádné částečné zápisy)
        │       │
        │       └── Fáze 2: Zápis do všech indexů
        │             Unikátní:     valueToKey.set(value, primaryKey)
        │             Neunikátní:   valueToKeys.get(value).add(primaryKey)
        │
        ├── 7. table.set(key, record)
        │
        └── 8. EventBus.publish('bucket.users.inserted', event)
                │
                └── Payload události:
                    { type: 'inserted', bucket: 'users', key, record }
```

### Krok za krokem

**Krok 1 — Inkrementace čítače**: Autoincrement čítač se bezpodmínečně zvýší při každém insertu, i když žádné pole nepoužívá `generated: 'autoincrement'`. To udržuje čítač monotónně rostoucí napříč všemi inserty, takže autoincrement hodnoty nikdy nekolidují.

**Krok 2 — Validace schématu a příprava**: `SchemaValidator` je strážce. Generuje hodnoty pro automaticky generovaná pole (`uuid`, `cuid`, `autoincrement`, `timestamp`), doplňuje výchozí hodnoty a připojuje metadata (`_version`, `_createdAt`, `_updatedAt`). Poté validuje každé pole proti schématu — typ, required, enum, min/max, pattern, format. Pokud jakékoliv pole selže při validaci, je vyhozen `ValidationError` s polem problémů a záznam není nikdy uložen.

```typescript
// ValidationError obsahuje strukturované problémy:
// {
//   field: 'email',
//   message: 'Invalid email format',
//   code: 'format'
// }
```

**Krok 3 — Extrakce klíče**: Hodnota primárního klíče se přečte z připraveného záznamu pomocí `definition.key`. Například pokud `key: 'id'` a záznam má `id: 'abc-123'`, klíč je `'abc-123'`.

**Krok 4 — TTL**: Pokud má bucket nakonfigurované `ttl` a záznam ještě nemá `_expiresAt` (žádné per-záznam přepsání), store vypočítá `_expiresAt = _createdAt + ttlMs`.

**Krok 5 — Evikce**: Pokud má bucket `maxSize` a tabulka je na kapacitě, nejstarší záznamy (řazené podle `_createdAt`) jsou evikčně odstraněny. Každá evikce odstraní záznam z indexů, smaže ho z tabulky a publikuje `deleted` událost — takže odběratelé vidí evikce jako normální smazání.

**Krok 6 — Indexování**: `IndexManager` používá dvoufázový přístup. Nejprve validuje všechna unikátní omezení bez modifikace jakéhokoliv indexu. Pokud je nalezeno porušení unikátnosti, okamžitě vyhodí `UniqueConstraintError` — žádné částečné zápisy do indexů. Teprve po úspěšném projití všech omezení zapíše do indexů.

**Krok 7 — Uložení**: Záznam se přidá do tabulkové Mapy s primárním klíčem.

**Krok 8 — Událost**: Událost insertu se publikuje na EventBus. To spustí event handlery (`store.on()`), přehodnocení reaktivních dotazů a persistence snapshoty (debounced).

### Když věci selžou

| Krok | Chyba | Záznam uložen? | Indexy modifikovány? | Událost publikována? |
|------|-------|----------------|---------------------|---------------------|
| 2 | `ValidationError` | Ne | Ne | Ne |
| 6 | `UniqueConstraintError` | Ne | Ne | Ne |
| 1-7 | Neočekávaná chyba | Ne | Záleží | Ne |

Validace a kontroly unikátních omezení probíhají **před** uložením záznamu nebo modifikací indexů. Operace je atomická v rámci GenServeru — buď vše uspěje, nebo se nic nezmění.

## Update: Sloučení, validace, uložení

Update vezme existující záznam, sloučí změny, zvýší verzi a znovu validuje:

```text
  users.update('abc-123', { name: 'Alice Smith' })
        │
        ▼
  BucketServer
        │
        ├── 1. Načtení existujícího záznamu: table.get('abc-123')
        │       → Nenalezen? Throw error
        │
        ├── 2. SchemaValidator.prepareUpdate(existing, changes)
        │       │
        │       ├── Sanitizace změn:
        │       │     Smazání _version, _createdAt, _updatedAt (neměnná metadata)
        │       │     Smazání pole primárního klíče (neměnné)
        │       │     Smazání generovaných polí (neměnné)
        │       │
        │       ├── Sloučení: { ...existing, ...sanitizedChanges }
        │       │
        │       ├── Zvýšení verze: _version = existing._version + 1
        │       │
        │       ├── Aktualizace časové značky: _updatedAt = Date.now()
        │       │
        │       └── Validace sloučeného záznamu proti schématu
        │             → Při selhání: throw ValidationError
        │
        ├── 3. IndexManager.updateRecord(key, oldRecord, newRecord)
        │       │
        │       ├── Fáze 1: Pro každý unikátní index se ZMĚNĚNOU hodnotou:
        │       │     Kontrola, zda nová hodnota již existuje (přeskočit pokud stejný klíč)
        │       │     → Při konfliktu: throw UniqueConstraintError
        │       │
        │       └── Fáze 2: Aktualizace indexů pouze pro změněná pole
        │             Odstranění starého záznamu, přidání nového záznamu
        │
        ├── 4. table.set(key, updatedRecord)
        │
        └── 5. EventBus.publish('bucket.users.updated', {
                  type: 'updated',
                  bucket: 'users',
                  key: 'abc-123',
                  oldRecord: { ... },
                  newRecord: { ... }
                })
```

### Co nemůžete změnit

Sanitizér update operace odstraní určitá pole z objektu změn před sloučením:

| Pole | Proč je neměnné |
|------|-----------------|
| Primární klíč | Změna klíče by rozbila reference a záznamy v indexech |
| `generated` pole | Automaticky generované hodnoty se nastavují jednou při insertu |
| `_version` | Spravován storem pro optimistické zamykání |
| `_createdAt` | Zaznamenává čas původního vložení |
| `_updatedAt` | Spravován storem při každém updatu |

Pokud tato pole předáte v objektu změn, jsou tiše ignorována — žádná chyba se nevyhodí.

### Optimalizace indexů

IndexManager aktualizuje indexy pouze pro pole, jejichž hodnoty se skutečně změnily. Pokud aktualizujete `{ name: 'Alice Smith' }` a `name` není indexované, žádné indexové operace neproběhnou. Pokud je `email` indexovaný, ale nezměnili jste ho, jeho záznam v indexu zůstane nedotčen. To předchází zbytečnému přetěžování indexů.

## Delete: Vyčistit a notifikovat

Delete je nejjednodušší mutace — odstranění z indexů, odstranění z tabulky, publikování události:

```text
  users.delete('abc-123')
        │
        ▼
  BucketServer
        │
        ├── 1. Načtení záznamu: table.get('abc-123')
        │       → Nenalezen? Vrátit tiše (idempotentní)
        │
        ├── 2. IndexManager.removeRecord(key, record)
        │       → Odstranění ze všech indexů (unikátních i neunikátních)
        │
        ├── 3. table.delete(key)
        │
        └── 4. EventBus.publish('bucket.users.deleted', {
                  type: 'deleted',
                  bucket: 'users',
                  key: 'abc-123',
                  record: { ... }  // Smazaný záznam
                })
```

Delete je **idempotentní**. Smazání klíče, který neexistuje, je no-op — žádná chyba, žádná událost. To umožňuje bezpečné opakování delete operací bez obav z dvojitého zpracování.

## Dotaz: Vyhledání v indexu vs plný sken

Když zavoláte `where()`, BucketServer rozhodne, zda použít index nebo skenovat celou tabulku:

```text
  users.where({ email: 'alice@example.com', role: 'admin' })
        │
        ▼
  BucketServer
        │
        ├── 1. Kontrola filtrovaných polí proti IndexManageru
        │       │
        │       ├── Je 'email' indexovaný? → ANO (unikátní index)
        │       │     indexManager.lookup('email', 'alice@example.com')
        │       │     → Vrací [primaryKey] (0 nebo 1 klíč pro unikátní)
        │       │
        │       └── Použít 'email' jako indexové pole
        │
        ├── 2. Načtení kandidátních záznamů z tabulky pomocí vrácených klíčů
        │       → table.get(primaryKey) pro každý klíč
        │
        ├── 3. Aplikace zbývajícího filtru: kontrola { role: 'admin' } na kandidátech
        │       → Ponechat záznamy kde record.role === 'admin'
        │
        └── 4. Vrácení odpovídajících záznamů
```

### Rozhodovací logika

```text
  Filtr: { email: 'alice@example.com', role: 'admin' }
        │
        ├── Kontrola každého pole v pořadí filtru:
        │     email → indexovaný? ANO → použít jako indexové pole, stop
        │
        │   (Pokud by 'email' nebyl indexovaný:)
        │     role → indexovaný? ANO → použít jako indexové pole
        │
        │   (Pokud by ani jeden nebyl indexovaný:)
        │     → Plný sken tabulky: iterace VŠECH záznamů, test VŠECH polí
        │
        └── Aplikace zbývajících (neindexových) filtrovaných polí na kandidátech
```

| Scénář | Použit index | Skenovaných záznamů | Výkon |
|--------|-------------|--------------------|----- |
| Indexované pole ve filtru | Ano | Pouze odpovídající z indexu | O(1) lookup + O(k) filtr, k = shody |
| Žádné indexované pole | Ne | Celá tabulka | O(n) sken, n = celkový počet záznamů |
| Více indexovaných polí | První shoda | Odpovídající z indexu pro první pole | Zbývající pole aplikována jako post-filtr |

Index manager kontroluje pole v pořadí, v jakém se objevují v objektu filtru. První nalezené indexované pole se použije pro počáteční zúžení. Všechna zbývající pole se aplikují jako post-filtry na kandidátní sadu.

### Vyhledání v unikátním vs neunikátním indexu

```text
  Unikátní index na 'email':
    lookup('email', 'alice@example.com')
    → valueToKey.get('alice@example.com')
    → Vrací: ['abc-123']  (nejvýše 1 klíč)

  Neunikátní index na 'role':
    lookup('role', 'admin')
    → valueToKeys.get('admin')
    → Vrací: ['abc-123', 'def-456', 'ghi-789']  (0 až N klíčů)
```

Unikátní indexy vrací 0 nebo 1 klíč. Neunikátní indexy vrací 0 až N klíčů. Oba se vyhýbají plnému skenu tabulky.

## Propagace událostí

Každá mutace publikuje událost. Takto události tečou systémem:

```text
  BucketServer publikuje událost
        │
        │  EventBus.publish('bucket.users.inserted', payload)
        │
        ▼
  EventBus
        │
        ├────────────────────┬─────────────────────┐
        │                    │                      │
        ▼                    ▼                      ▼
  store.on() handlery   QueryManager          StorePersistence
        │               .onBucketChange()     .onBucketChange()
        │                    │                      │
        │                    │                      │
  Uživatelské callbacky Přehodnocení          Označení bucketu dirty,
  (auditní log,          dotčených             naplánování debounced
   notifikace,           odběrů                snapshotu
   kaskádové mazání)
```

### Zpracování událostí v QueryManageru

Když přijde událost změny bucketu, QueryManager identifikuje dotčené odběry přes své indexy závislostí:

```text
  onBucketChange('users', 'abc-123')
        │
        ├── Index na úrovni bucketu: "users" → {sub-1, sub-3, sub-5}
        │     Všechny odběry, které použily all(), where(), count() atd. na 'users'
        │
        ├── Index na úrovni záznamu: "users"/"abc-123" → {sub-2}
        │     Odběry, které zavolaly get('abc-123') na 'users'
        │
        └── Sloučení: {sub-1, sub-2, sub-3, sub-5}
              │
              └── Pro každý odběr:
                    1. Znovu vykonat dotaz s čerstvým QueryContextem
                    2. Porovnat výsledek s předchozím (deepEqual)
                    3. Pokud se liší → zavolat callback odběratele
                    4. Pokud je stejný → přeskočit (žádné zbytečné re-rendery)
```

Dvouúrovňové sledování závislostí znamená, že dotaz, který pouze volá `get('abc-123')` na bucket users, se nepřehodnocuje, když se změní úplně jiný záznam uživatele. Pouze operace na úrovni bucketu (`all`, `where`, `count` atd.) se spouštějí při jakékoliv změně v bucketu.

### Zpracování událostí v StorePersistence

```text
  onBucketChange('users')
        │
        ├── Přidání 'users' do sady dirtyBuckets
        │
        ├── Pokud neběží debounce timer:
        │     → Spuštění timeru (výchozí: 100ms)
        │
        └── Když timer vyprší:
              │
              ├── Pro každý dirty bucket:
              │     GenServer.call(ref, { type: 'getSnapshot' })
              │     → Vrací { records: [...], autoincrementCounter }
              │     adapter.save(key, snapshot)
              │
              └── Vyčištění sady dirtyBuckets
```

Persistence je **debounced** — více rychlých změn stejného bucketu vyústí v jediný zápis snapshotu po uplynutí debounce periody. To předchází I/O bouřím během hromadných operací.

## Transakce: Atomické zápisy napříč buckety

Transakce následují vzor s bufferovanými zápisy. Všechny zápisy jsou bufferovány lokálně, poté commitnuty do každého bucketu atomicky:

```text
  store.transaction(async (tx) => {
    const users = await tx.bucket('users');
    const orders = await tx.bucket('orders');
    await users.insert({ name: 'Alice' });
    await orders.insert({ userId: 'alice-id', amount: 99 });
  })
        │
        ▼
  TransactionContext
        │
        │  Fáze 1: Vykonání callbacku
        │
        ├── tx.bucket('users') → TransactionBucketHandle
        │     │
        │     └── users.insert({ name: 'Alice' })
        │           │
        │           ├── SchemaValidator.prepareInsert() (lokální validace)
        │           ├── Přidání do WriteBuffer: inserts.set(key, record)
        │           └── Vrácení záznamu (optimisticky, ještě není commitnutý)
        │
        ├── tx.bucket('orders') → TransactionBucketHandle
        │     │
        │     └── orders.insert({ userId: 'alice-id', amount: 99 })
        │           │
        │           ├── SchemaValidator.prepareInsert() (lokální validace)
        │           ├── Přidání do WriteBuffer: inserts.set(key, record)
        │           └── Vrácení záznamu (optimisticky, ještě není commitnutý)
        │
        │  Fáze 2: Commit (po dokončení callbacku)
        │
        ├── Pro každý bucket s bufferovanými zápisy (sekvenčně):
        │     │
        │     ├── Sestavení commit operací z bufferu
        │     │
        │     ├── GenServer.call(ref, { type: 'commitBatch', operations })
        │     │     │
        │     │     ├── Validace VŠECH operací (žádné mutace zatím):
        │     │     │     Kontrola unikátních omezení
        │     │     │     Kontrola shody verzí (pro updaty/delete)
        │     │     │     Kontrola, že klíč neexistuje (pro inserty)
        │     │     │     → Při selhání: throw TransactionConflictError
        │     │     │
        │     │     ├── Aplikace VŠECH operací:
        │     │     │     Aktualizace indexů, uložení záznamů, sběr událostí
        │     │     │
        │     │     └── Vrácení { events, undoOps }
        │     │
        │     └── Zaznamenání undo operací pro rollback
        │
        ├── Pokud VŠECHNY buckety commitnuty úspěšně:
        │     → Publikování všech nasbíraných událostí
        │
        └── Pokud JAKÝKOLIV bucket selhal:
              → Rollback dříve commitnutých bucketů (v opačném pořadí)
              → GenServer.call(ref, { type: 'rollbackBatch', undoOps })
              → Znovu vyhození původní chyby
```

### Čtení vlastních zápisů

Uvnitř transakce čtení vidí necommitnuté zápisy ze stejné transakce:

```text
  TransactionBucketHandle.get(key)
        │
        ├── Kontrola překryvné vrstvy WriteBuffer:
        │     │
        │     ├── Klíč v deletes → vrátit undefined
        │     ├── Klíč v inserts → vrátit bufferovaný záznam
        │     ├── Klíč v updates → vrátit bufferovaný záznam
        │     └── Klíč není v bufferu → projít dál
        │
        └── GenServer.call(ref, { type: 'get', key })
              → Čtení z reálného BucketServeru
```

Překryvná vrstva se aplikuje na všechny operace čtení (`get`, `all`, `where`, `findOne`, `count`). To znamená, že můžete vložit záznam a okamžitě na něj dotazovat v rámci stejné transakce — i když ještě nebyl commitnut do BucketServeru.

### Rollback při selhání

Pokud commit druhého bucketu selže, změny prvního bucketu jsou vráceny zpět:

```text
  Bucket 1 (users):  commitBatch → ÚSPĚCH → undo operace uloženy
  Bucket 2 (orders): commitBatch → SELHÁNÍ → TransactionConflictError
        │
        └── Rollback:
              Bucket 1: rollbackBatch(undoOps)
                → Pro každou undo operaci:
                    'undoInsert': smazání záznamu, odstranění z indexů
                    'undoUpdate': obnovení starého záznamu, vrácení indexů
                    'undoDelete': znovu vložení záznamu, přidání do indexů
```

Rollback je **best-effort** — pokud volání rollbacku selže (např. bucket spadl), chyba je pohlcena a rollback pokračuje pro zbývající buckety. To znamená, že existuje teoretické okno, kdy pád během rollbacku může zanechat částečná data, ale v praxi jsou pády BucketServeru vzácné a data jsou v paměti (ztracena při pádu tak jako tak).

## Kompletní diagram životního cyklu požadavku

Vše dohromady — od uživatelského volání `insert()` přes každou komponentu a zpět:

```text
  ┌──────────────┐
  │  Aplikační   │
  │     kód      │
  └──────┬───────┘
         │ users.insert({ name: 'Alice', email: 'alice@ex.com' })
         ▼
  ┌──────────────┐
  │ BucketHandle │  Bezstavový proxy
  │              │  Posílá GenServer.call()
  └──────┬───────┘
         │
         ▼
  ┌──────────────────────────────────────────────┐
  │              BucketServer (GenServer)          │
  │                                                │
  │  ┌─────────────────┐                          │
  │  │ SchemaValidator  │  Validace, generování,   │
  │  │                  │  připojení metadat        │
  │  └────────┬────────┘                          │
  │           │                                    │
  │  ┌────────▼────────┐                          │
  │  │  IndexManager   │  Dvoufázový: validace     │
  │  │                 │  unikátnosti, pak zápis   │
  │  └────────┬────────┘                          │
  │           │                                    │
  │  ┌────────▼────────┐                          │
  │  │   table (Map)   │  Uložení záznamu          │
  │  └────────┬────────┘                          │
  │           │                                    │
  └───────────┼────────────────────────────────────┘
              │
              │ EventBus.publish('bucket.users.inserted', ...)
              ▼
  ┌──────────────────────────────────────────────┐
  │                 EventBus                       │
  │                                                │
  │  Odběratelé:                                   │
  │    ├── store.on('bucket.users.*') handlery    │
  │    ├── QueryManager.onBucketChange()          │
  │    └── StorePersistence.onBucketChange()      │
  │                                                │
  └──────────────────────────────────────────────┘
              │
      ┌───────┼───────┐
      ▼       ▼       ▼
  Callbacky  Reaktivní  Persistence
             dotazy     snapshot
             přehodn.   (debounced)
```

## Kompletní funkční příklad

Krok za krokem trasování operací systémem:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'trace' });

  await store.defineBucket('products', {
    key: 'sku',
    schema: {
      sku:      { type: 'string', required: true },
      name:     { type: 'string', required: true },
      price:    { type: 'number', min: 0, required: true },
      category: { type: 'string', enum: ['electronics', 'clothing', 'food'] },
      stock:    { type: 'number', min: 0, default: 0 },
    },
    indexes: ['category'],
  });

  const products = store.bucket('products');

  // --- INSERT ---
  // Cesta: BucketHandle → GenServer.call → prepareInsert → addRecord → table.set → publish
  const laptop = await products.insert({
    sku: 'LAPTOP-001',
    name: 'Pro Laptop',
    price: 1299,
    category: 'electronics',
    stock: 50,
  });
  // laptop._version === 1, laptop._createdAt === Date.now()

  // --- DOTAZ (indexovaný) ---
  // Cesta: BucketHandle → GenServer.call → lookup('category', 'electronics') → post-filtr → vrácení
  const electronics = await products.where({ category: 'electronics' });
  console.log(electronics.length); // 1

  // --- DOTAZ (plný sken) ---
  // 'name' není indexovaný → plný sken tabulky, kontrola každého záznamu
  const byName = await products.where({ name: 'Pro Laptop' });
  console.log(byName.length); // 1

  // --- UPDATE ---
  // Cesta: BucketHandle → GenServer.call → prepareUpdate (sloučení + validace) → updateRecord → table.set → publish
  const updated = await products.update('LAPTOP-001', { price: 1199, stock: 45 });
  console.log(updated._version); // 2
  console.log(updated.price);    // 1199
  // name, sku, category nezměněny — indexy pro 'category' nedotčeny

  // --- DELETE ---
  // Cesta: BucketHandle → GenServer.call → removeRecord → table.delete → publish
  await products.delete('LAPTOP-001');

  // Idempotentní: opětovné smazání je no-op
  await products.delete('LAPTOP-001');

  // --- AGREGACE ---
  await products.insert({ sku: 'A', name: 'Položka A', price: 100, category: 'food', stock: 10 });
  await products.insert({ sku: 'B', name: 'Položka B', price: 200, category: 'food', stock: 20 });
  await products.insert({ sku: 'C', name: 'Položka C', price: 300, category: 'clothing', stock: 5 });

  // Cesta: GenServer.call → selectWhere (index na 'category') → sum 'price' přes výsledky
  const foodTotal = await products.sum('price', { category: 'food' });
  console.log(foodTotal); // 300

  // Cesta: GenServer.call → všechny záznamy → výpočet průměru
  const avgPrice = await products.avg('price');
  console.log(avgPrice); // 200

  await store.stop();
}

main();
```

## Cvičení

Vyšetřujete problém s výkonem. Bucket se 100 000 záznamy je pomalý při dotazu `where({ status: 'active', region: 'EU' })`. Žádné pole není indexované.

1. Trasujte dotaz tokem dat. Kolik záznamů BucketServer skenuje?
2. Přidáte `indexes: ['status']` do definice bucketu. Trasujte dotaz znovu. Kolik záznamů se nyní skenuje?
3. Pole `status` má 3 možné hodnoty: `'active'`, `'inactive'`, `'pending'`. Přibližně kolik záznamů index vrátí pro `status: 'active'`? Je to dobrý index?
4. Místo toho přidáte `indexes: ['region']` (10 možných regionů, přibližně rovnoměrné rozložení). Trasujte dotaz. Je to lepší volba indexu?
5. Co když přidáte oba `indexes: ['status', 'region']`? Použije dotaz oba indexy?

<details>
<summary>Řešení</summary>

**1. Žádný index — plný sken tabulky:**

BucketServer iteruje všech 100 000 záznamů a na každém kontroluje `record.status === 'active' && record.region === 'EU'`. Celkem skenovaných záznamů: 100 000.

**2. Index na `status`:**

```text
  lookup('status', 'active')
    → Vrací ~33 333 primárních klíčů (1/3 ze 100k, za předpokladu rovnoměrného rozložení)
    → Načtení těchto záznamů z tabulky
    → Post-filtr: kontrola record.region === 'EU' na každém
    → Vrácení shod
```

Skenovaných záznamů: ~33 333 (aktivní). Lepší než 100k, ale stále skenuje třetinu tabulky.

**3. Je `status` dobrý index?**

S pouhými 3 možnými hodnotami každá hodnota odpovídá přibližně 33 % záznamů. Toto je **nízká selektivita** — index eliminuje pouze 2/3 záznamů. Není to skvělý index pro velké tabulky.

**4. Index na `region`:**

```text
  lookup('region', 'EU')
    → Vrací ~10 000 primárních klíčů (1/10 ze 100k)
    → Post-filtr: kontrola record.status === 'active' na každém
    → Vrácení shod
```

Skenovaných záznamů: ~10 000. Mnohem lepší. S 10 regiony každý odpovídá ~10 % záznamů — **vyšší selektivita** než status.

**5. Oba indexy:**

Dotaz NEpoužije oba indexy. BucketServer použije **první** indexované pole, které najde v objektu filtru. Pokud je filtr `{ status: 'active', region: 'EU' }`, použije nejprve `status` (protože se v filtru objevuje první). Pokud prohodíte pořadí na `{ region: 'EU', status: 'active' }`, použije nejprve `region`.

Store neprovádí průnik indexů (kombinování výsledků z více indexů). Pro optimalizaci tohoto dotazu umístěte selektivnější pole na první místo ve filtru, nebo navrhněte schéma tak, aby první indexované pole ve filtru bylo nejselektivnější.

</details>

## Shrnutí

- **Cesta insertu**: BucketHandle → GenServer.call → inkrementace čítače → SchemaValidator.prepareInsert (generování, výchozí hodnoty, metadata, validace) → TTL kontrola → maxSize evikce → IndexManager.addRecord (dvoufázový: validace unikátnosti, pak zápis) → table.set → EventBus.publish
- **Cesta updatu**: načtení existujícího → SchemaValidator.prepareUpdate (sanitizace, sloučení, zvýšení verze, validace) → IndexManager.updateRecord (pouze změněná pole) → table.set → EventBus.publish
- **Cesta delete**: načtení záznamu → IndexManager.removeRecord → table.delete → EventBus.publish; delete je idempotentní
- **Cesta dotazu**: kontrola polí filtru proti IndexManageru → pokud indexované: vyhledání klíčů, načtení záznamů, post-filtr zbývajících polí; pokud žádný index: plný sken tabulky
- Indexy používají **první indexované pole** nalezené ve filtru — žádný průnik indexů; umístěte nejselektivnější pole na první místo
- **Události** tečou z BucketServeru přes EventBus ke třem odběratelům: uživatelské handlery (`store.on`), QueryManager (přehodnocení reaktivních dotazů) a StorePersistence (debounced snapshoty)
- **Transakce** bufferují zápisy lokálně, pak commitují bucket po bucketu; čtení vlastních zápisů přes překryvnou vrstvu na write bufferu; rollback při selhání přes undo operace
- IndexManager používá **dvoufázový přístup** pro všechny zápisy: nejprve validace všech omezení, pak zápis — prevence částečné korupce indexů
- **Chyby validace** a **porušení unikátních omezení** selžou rychle před jakoukoli modifikací stavu

---

Další: [Nastavení Bridge](../11-propojeni-s-pravidly/01-nastaveni-bridge.md)
