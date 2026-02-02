# Proč reaktivní datová vrstva?

Každá aplikace potřebuje ukládat a načítat data. Většina začne s obyčejnou `Map` nebo objektem, a to funguje -- dokud to nestačí. Když více částí aplikace čte a zapisuje stejná data bez koordinace, stav se stává nekonzistentním, uživatelské rozhraní zobrazuje zastaralé údaje a validace se opakuje na každém místě.

Reaktivní datová vrstva poskytuje vaší aplikaci jediný, schématem vynucený zdroj pravdy, který informuje odběratele o změnách dat.

## Co se naučíte

- Proč prostá `Map` přestává stačit s růstem aplikace
- Jak rozptýlený stav vede k zastaralému UI a duplicitní validaci
- Co nabízí reaktivní Store se schématem
- Jak se `@hamicek/noex-store` porovnává s ruční správou stavu

## Problémy

### Map vypadá v pořádku -- zpočátku

Představte si správce relací, který sleduje připojené uživatele:

```typescript
const sessions = new Map<string, { userId: string; connectedAt: number }>();

function connect(userId: string) {
  sessions.set(userId, { userId, connectedAt: Date.now() });
}

function disconnect(userId: string) {
  sessions.delete(userId);
}

function getSession(userId: string) {
  return sessions.get(userId);
}
```

Tři funkce, jedna Map, žádný problém. Ale požadavky rostou:

### Validace je rozptýlená nebo chybí

Nový vývojář přidá funkci hromadného importu v jiném modulu:

```typescript
// V jiném souboru, o několik měsíců později…
function importSessions(data: unknown[]) {
  for (const entry of data) {
    // Ouha: žádná validace — userId může být prázdné, connectedAt může být záporné
    sessions.set((entry as any).userId, entry as any);
  }
}
```

Neexistuje žádné schéma. Nic nebrání tomu, aby se do Map dostaly chybně strukturované záznamy. Původní funkce `connect()` implicitně validuje data tím, že objekt konstruuje, ale každá další zapisovací cesta musí tuto logiku znovu implementovat -- nebo ji, což je pravděpodobnější, přeskočí.

### UI neví, že se data změnila

Komponenta dashboardu vykresluje počet relací. Přečte `sessions.size` při připojení, ale nemá jak zjistit, kdy se změní:

```typescript
// Komponenta dashboardu
function renderSessionCount() {
  const count = sessions.size;
  document.getElementById('count')!.textContent = String(count);
}

// Zavoláno jednou při startu
renderSessionCount();

// Uživatel se připojí… dashboard stále ukazuje starý počet.
connect('user-42');
// Dashboard je nyní zastaralý. Nikdo znovu nezavolal renderSessionCount().
```

Obvyklé řešení je polling (plýtvání) nebo ruční volání aktualizačních funkcí po každém zápisu (křehké a snadno se na to zapomene).

### Více kolekcí, žádná koordinace

Nyní přidejte druhou Map pro zprávy:

```typescript
const sessions = new Map<string, { userId: string; connectedAt: number }>();
const messages = new Map<string, { id: string; from: string; text: string; sentAt: number }>();

function sendMessage(from: string, text: string) {
  if (!sessions.has(from)) {
    throw new Error('User not connected');
  }
  const id = crypto.randomUUID();
  messages.set(id, { id, from, text, sentAt: Date.now() });
}

function disconnectAndCleanup(userId: string) {
  sessions.delete(userId);
  // Ouha: pokud to uprostřed selže, relace je pryč, ale osiřelé zprávy zůstávají.
  for (const [id, msg] of messages) {
    if (msg.from === userId) {
      messages.delete(id);
    }
  }
}
```

Neexistuje žádná transakční hranice. Pokud úklidová smyčka vyhodí výjimku, data jsou v nekonzistentním stavu: relace je smazaná, ale zprávy od daného uživatele stále existují. Se dvěma Map je to zvládnutelné; s deseti se to stává zdrojem záludných chyb.

### Důsledky

| Problém | Dopad |
|---------|-------|
| Žádné schéma | Chybně strukturovaná data vstupují do systému bez povšimnutí |
| Žádná validace na hranici | Každá zapisovací cesta musí duplikovat kontroly |
| Žádné notifikace o změnách | UI zobrazuje zastaralé údaje, polling plýtvá prostředky |
| Žádné transakce | Zápisy napříč kolekcemi mohou zanechat nekonzistentní stav |
| Žádné indexy | Vyhledávání podle neklíčových polí vyžaduje úplný průchod |
| Žádné TTL / životní cyklus | Expirovaná data se hromadí, dokud si někdo nevzpomene na úklid |
| Žádný audit trail | Nelze zjistit, co se změnilo a kdy |

## Řešení: Reaktivní Store se schématem

`@hamicek/noex-store` nahrazuje rozptýlené Map centralizovaným Store, kde každá kolekce (nazývaná **Bucket**) má schéma, validaci, indexy, události změn a volitelnou perzistenci -- vše konfigurováno deklarativně.

```text
┌───────────────────────────────────────────────────────────┐
│                          STORE                             │
│                                                            │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│   │   sessions   │  │   messages   │  │    rooms     │   │
│   │   (Bucket)   │  │   (Bucket)   │  │   (Bucket)   │   │
│   │              │  │              │  │              │   │
│   │  schema ✓    │  │  schema ✓    │  │  schema ✓    │   │
│   │  indexes ✓   │  │  indexes ✓   │  │  indexes ✓   │   │
│   │  events ✓    │  │  events ✓    │  │  events ✓    │   │
│   │  TTL ✓       │  │  validation ✓│  │  persistence ✓   │
│   └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                            │
│   Reactive Queries ──── Transactions ──── Event Bus        │
└───────────────────────────────────────────────────────────┘
```

Takto vypadá správce relací přepsaný pomocí Store:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'app' });

await store.defineBucket('sessions', {
  key: 'userId',
  schema: {
    userId:      { type: 'string', required: true, minLength: 1 },
    connectedAt: { type: 'number', generated: 'timestamp' },
  },
  ttl: '24h',
});

const sessions = store.bucket('sessions');

// Vložení — validace probíhá automaticky, connectedAt se vygeneruje
await sessions.insert({ userId: 'user-42' });

// Čtení
const session = await sessions.get('user-42');
// { userId: 'user-42', connectedAt: 1706745600000,
//   _version: 1, _createdAt: …, _updatedAt: … }

// Neplatná data jsou odmítnuta — prázdné userId není povoleno
try {
  await sessions.insert({ userId: '' });
} catch (err) {
  // ValidationError: field "userId" fails minLength constraint
}

// Relace automaticky vyprší po 24 hodinách — žádný úklidový kód není potřeba.

await store.stop();
```

Každý zápis je validován oproti schématu. Generovaná pole jako `connectedAt` se vyplní automaticky. TTL zajistí, že zastaralé relace jsou odstraněny bez ručního úklidu.

## Ruční Map vs Store

| Dimenze | Ruční `Map` | `@hamicek/noex-store` |
|---------|-------------|----------------------|
| **Schéma** | Žádné — vejde se cokoliv | Deklarativní schéma pro každý Bucket |
| **Validace** | Vývojář ji musí přidat všude | Automatická při každém vložení a aktualizaci |
| **Generování ID** | Ruční `crypto.randomUUID()` | Vestavěné: uuid, cuid, autoincrement, timestamp |
| **Sledování změn** | Žádné | Události při každém vložení, aktualizaci, smazání |
| **Reaktivní UI** | Polling nebo ruční obnovení | Odběr dotazů, které se přehodnotí při změně |
| **Indexy** | Úplný průchod pro neklíčové vyhledávání | Deklarace indexů, O(1) vyhledávání |
| **Unikátní omezení** | Kontrola-pak-vložení (náchylné k race condition) | Atomicky vynuceno Store |
| **Transakce** | Žádné — částečné zápisy při selhání | Atomické transakce napříč Bucket s rollbackem |
| **TTL / evikce** | Ruční `setTimeout` pro každý záznam | Deklarativní `ttl: '1h'` a `maxSize: 10_000` |
| **Perzistence** | Ruční serializace | Perzistence přes adaptéry s debounced zápisy |
| **Metadata** | Žádná | Automatické `_version`, `_createdAt`, `_updatedAt` |

## Kompletní funkční příklad

Minimální, ale kompletní příklad: Store relací se schématem, automatickými časovými razítky, TTL expirací a reaktivním dotazem, který sleduje počet aktivních relací.

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'demo' });

  // Definice Bucket se schématem, indexy a TTL
  await store.defineBucket('sessions', {
    key: 'userId',
    schema: {
      userId:      { type: 'string', required: true, minLength: 1 },
      displayName: { type: 'string', required: true },
      role:        { type: 'string', enum: ['admin', 'user', 'guest'], default: 'user' },
      connectedAt: { type: 'number', generated: 'timestamp' },
    },
    indexes: ['role'],
    ttl: '1h',
  });

  const sessions = store.bucket('sessions');

  // Definice reaktivního dotazu: počet aktivních relací
  store.defineQuery('activeCount', async (ctx) => {
    const all = await ctx.bucket('sessions').all();
    return all.length;
  });

  // Odběr — callback se spustí okamžitě a při každé změně
  const unsubscribe = await store.subscribe<number>('activeCount', (count) => {
    console.log(`Active sessions: ${count}`);
  });
  // Výstup: Active sessions: 0

  // Vložení relací — každá spustí reaktivní dotaz
  await sessions.insert({ userId: 'alice', displayName: 'Alice', role: 'admin' });
  // Výstup: Active sessions: 1

  await sessions.insert({ userId: 'bob', displayName: 'Bob' });
  // Výstup: Active sessions: 2

  // Dotaz podle indexu — žádný úplný průchod
  const admins = await sessions.where({ role: 'admin' });
  console.log('Admins:', admins.map((s) => s.userId));
  // Výstup: Admins: [ 'alice' ]

  // Naslouchání událostem
  const unsub = await store.on('bucket.sessions.*', (event, topic) => {
    console.log(`Event: ${topic}`);
  });

  await sessions.delete('bob');
  // Výstup: Event: bucket.sessions.deleted
  // Výstup: Active sessions: 1

  // Neplatná data jsou odmítnuta
  try {
    await sessions.insert({ userId: 'x', displayName: 'X', role: 'superadmin' });
  } catch (err) {
    console.log(err.message);
    // ValidationError: field "role" must be one of [admin, user, guest]
  }

  // Úklid
  unsubscribe();
  await unsub();
  await store.stop();
}

main();
```

## Co se změnilo?

Porovnejte oba přístupy:

**Předtím** (ruční Map):
- Žádné schéma — neplatná data vstupují bez povšimnutí
- Žádné notifikace o změnách — UI používá polling nebo zobrazuje zastaralé údaje
- Žádné transakce — zápisy napříč Map riskují nekonzistenci
- Úklidový kód pro každou kolekci, duplicitní validace na každém vstupním bodě

**Potom** (noex-store):
- Schéma vynucené při každém zápisu — neplatná data jsou odmítnuta s popisnou chybou
- Reaktivní dotazy automaticky spouštějí callbacky, když se podkladová data změní
- Události publikované při každé mutaci pro audit, logování nebo navazující systémy
- TTL a životní cyklus spravovány deklarativně — žádný ruční úklidový kód

## Cvičení

Níže je modul pro ruční správu dat v task trackeru. Identifikujte všechny problémy a popište, jak byste každý z nich vyřešili pomocí konceptů noex-store (prostý text, ne kód).

```typescript
const tasks = new Map<string, { id: string; title: string; status: string; assignee: string }>();
let nextId = 1;

function addTask(title: string, assignee: string) {
  const id = String(nextId++);
  tasks.set(id, { id, title, status: 'open', assignee });
}

function completeTask(id: string) {
  const task = tasks.get(id);
  if (task) {
    task.status = 'done';
  }
}

function getTasksByAssignee(assignee: string): Array<{ id: string; title: string; status: string }> {
  const result = [];
  for (const task of tasks.values()) {
    if (task.assignee === assignee) {
      result.push(task);
    }
  }
  return result;
}

function deleteCompletedTasks() {
  for (const [id, task] of tasks) {
    if (task.status === 'done') {
      tasks.delete(id);
    }
  }
}
```

<details>
<summary>Řešení</summary>

**Problém 1: Žádné schéma — `status` přijímá jakýkoliv řetězec**
- Řešení: Definujte Bucket s `status: { type: 'string', enum: ['open', 'in_progress', 'done'] }`. Jakýkoliv neplatný status je odmítnut při vložení nebo aktualizaci.

**Problém 2: Žádná záruka generování ID — `nextId` je prostý čítač, který se při restartu resetuje**
- Řešení: Použijte `generated: 'uuid'` nebo `generated: 'autoincrement'` na klíčovém poli. Store spravuje čítače a zajišťuje jejich perzistenci.

**Problém 3: Mutable záznamy — `completeTask` přímo mutuje hodnotu v Map**
- Řešení: Použijte `bucket.update(id, { status: 'done' })`. Store validuje změnu, zvýší `_version` a publikuje událost `updated`.

**Problém 4: Žádné notifikace o změnách — UI neví, kdy se úkoly změní**
- Řešení: Definujte reaktivní dotaz (např. `tasksByAssignee`) a přihlaste se k odběru. Callback se znovu spustí při každém vložení, aktualizaci nebo smazání odpovídajícího úkolu.

**Problém 5: Úplný průchod v `getTasksByAssignee` — O(n) pokaždé**
- Řešení: Deklarujte `indexes: ['assignee']` v definici Bucket. Store použije sekundární index pro O(1) vyhledávání podle assignee.

**Problém 6: Ruční úklid pomocí `deleteCompletedTasks` — musí se volat explicitně**
- Řešení: Použijte TTL (`ttl: '7d'`) pro automatickou expiraci dokončených úkolů, nebo naslouchejte události `updated` a mažte dokončené úkoly přes event handler.

**Problém 7: Žádná metadata — nelze zjistit, kdy byl úkol vytvořen nebo naposledy upraven**
- Řešení: Každý záznam ve Store automaticky získává metadata pole `_version`, `_createdAt` a `_updatedAt`.

**Problém 8: Žádná validace — prázdné titulky a prázdní assignees jsou akceptováni**
- Řešení: Přidejte omezení `required: true` a `minLength: 1` na pole `title` a `assignee`.

</details>

## Shrnutí

- Prostá `Map` funguje pro triviální případy, ale nenabízí schéma, validaci, sledování změn ani koordinaci
- S růstem aplikace vede nedostatek struktury k zastaralému UI, neplatným datům, duplicitní validaci a nekonzistentnímu stavu
- Reaktivní datová vrstva centralizuje správu dat s deklarativními schématy, automatickou validací a notifikacemi o změnách
- `@hamicek/noex-store` poskytuje Bucket se schématem, sekundární indexy, reaktivní dotazy, transakce, události, TTL a perzistenci -- vše konfigurováno deklarativně
- Aplikační kód se zmenší na deklaraci toho, jak data vypadají, a odběr změn -- o zbytek se postará Store

---

Další: [Klíčové koncepty](./02-klicove-koncepty.md)
