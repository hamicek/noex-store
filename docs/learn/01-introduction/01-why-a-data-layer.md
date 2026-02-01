# Why a Reactive Data Layer?

Every application needs to store and retrieve data. Most start with a plain `Map` or an object, and that works — until it doesn't. When multiple parts of the application read and write the same data without coordination, state becomes inconsistent, UIs go stale, and validation is duplicated everywhere.

A reactive data layer gives your application a single, schema-enforced source of truth that notifies subscribers when data changes.

## What You'll Learn

- Why a plain `Map` breaks down as applications grow
- How scattered state leads to stale UIs and duplicated validation
- What a schema-enforced, reactive store offers instead
- How `@hamicek/noex-store` compares to manual state management

## The Problems

### A Map Seems Fine — At First

Consider a session manager that tracks connected users:

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

Three functions, one Map, zero problems. But requirements grow:

### Validation Is Scattered or Missing

A new developer adds a bulk import feature in another module:

```typescript
// In another file, months later…
function importSessions(data: unknown[]) {
  for (const entry of data) {
    // Oops: no validation — userId could be empty, connectedAt could be negative
    sessions.set((entry as any).userId, entry as any);
  }
}
```

There is no schema. Nothing prevents malformed records from entering the Map. The original `connect()` function implicitly validates by constructing the object, but every other write path has to re-implement that logic — or, more likely, skip it.

### The UI Doesn't Know Data Changed

A dashboard component renders the session count. It reads `sessions.size` at mount time, but has no way to know when it changes:

```typescript
// Dashboard component
function renderSessionCount() {
  const count = sessions.size;
  document.getElementById('count')!.textContent = String(count);
}

// Called once at startup
renderSessionCount();

// A user connects… the dashboard still shows the old count.
connect('user-42');
// Dashboard is now stale. Nobody called renderSessionCount() again.
```

The usual fix is polling (wasteful) or manually calling update functions after every write (fragile and easy to forget).

### Multiple Collections, No Coordination

Now add a second Map for messages:

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
  // Oops: if this crashes midway, the session is gone but orphaned messages remain.
  for (const [id, msg] of messages) {
    if (msg.from === userId) {
      messages.delete(id);
    }
  }
}
```

There's no transaction boundary. If the cleanup loop throws, the data is in an inconsistent state: the session is deleted but messages from that user still exist. With two Maps this is manageable; with ten, it becomes a source of subtle bugs.

### The Consequences

| Problem | Effect |
|---------|--------|
| No schema | Malformed data enters the system silently |
| No validation at the boundary | Every write path must duplicate checks |
| No change notifications | UIs go stale, polling wastes resources |
| No transactions | Cross-collection writes can leave inconsistent state |
| No indexes | Lookups by non-key fields require full scans |
| No TTL / lifecycle | Expired data accumulates until someone remembers to clean it |
| No audit trail | No way to know what changed or when |

## The Solution: A Schema-Enforced Reactive Store

`@hamicek/noex-store` replaces scattered Maps with a centralized store where every collection (called a **bucket**) has a schema, validation, indexes, change events, and optional persistence — all configured declaratively.

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

Here's the session manager rewritten with the store:

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

// Insert — validated automatically, connectedAt generated
await sessions.insert({ userId: 'user-42' });

// Read
const session = await sessions.get('user-42');
// { userId: 'user-42', connectedAt: 1706745600000,
//   _version: 1, _createdAt: …, _updatedAt: … }

// Invalid data is rejected — no empty userId allowed
try {
  await sessions.insert({ userId: '' });
} catch (err) {
  // ValidationError: field "userId" fails minLength constraint
}

// The session expires automatically after 24 hours — no cleanup code needed.

await store.stop();
```

Every write is validated against the schema. Generated fields like `connectedAt` are filled automatically. The TTL ensures stale sessions are purged without manual cleanup.

## Manual Map vs Store

| Dimension | Manual `Map` | `@hamicek/noex-store` |
|-----------|-------------|----------------------|
| **Schema** | None — any shape goes in | Declarative schema per bucket |
| **Validation** | Developer must add it everywhere | Automatic on every insert and update |
| **ID generation** | Manual `crypto.randomUUID()` | Built-in: uuid, cuid, autoincrement, timestamp |
| **Change tracking** | None | Events on every insert, update, delete |
| **Reactive UI** | Polling or manual refresh | Subscribe to queries that re-evaluate on change |
| **Indexes** | Full scan for non-key lookups | Declare indexes, get O(1) lookups |
| **Unique constraints** | Check-then-insert (race-prone) | Enforced atomically by the store |
| **Transactions** | None — partial writes on failure | Atomic multi-bucket transactions with rollback |
| **TTL / eviction** | Manual `setTimeout` per record | Declarative `ttl: '1h'` and `maxSize: 10_000` |
| **Persistence** | Serialize manually | Adapter-based persistence with debounced writes |
| **Metadata** | None | Automatic `_version`, `_createdAt`, `_updatedAt` |

## Complete Working Example

A minimal but complete example: a session store with schema validation, automatic timestamps, TTL expiration, and a reactive query that tracks the active session count.

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'demo' });

  // Define a bucket with schema, indexes, and TTL
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

  // Define a reactive query: count active sessions
  store.defineQuery('activeCount', async (ctx) => {
    const all = await ctx.bucket('sessions').all();
    return all.length;
  });

  // Subscribe — callback fires immediately and on every change
  const unsubscribe = await store.subscribe<number>('activeCount', (count) => {
    console.log(`Active sessions: ${count}`);
  });
  // Output: Active sessions: 0

  // Insert sessions — each triggers the reactive query
  await sessions.insert({ userId: 'alice', displayName: 'Alice', role: 'admin' });
  // Output: Active sessions: 1

  await sessions.insert({ userId: 'bob', displayName: 'Bob' });
  // Output: Active sessions: 2

  // Query by index — no full scan
  const admins = await sessions.where({ role: 'admin' });
  console.log('Admins:', admins.map((s) => s.userId));
  // Output: Admins: [ 'alice' ]

  // Listen to events
  const unsub = await store.on('bucket.sessions.*', (event, topic) => {
    console.log(`Event: ${topic}`);
  });

  await sessions.delete('bob');
  // Output: Event: bucket.sessions.deleted
  // Output: Active sessions: 1

  // Invalid data is rejected
  try {
    await sessions.insert({ userId: 'x', displayName: 'X', role: 'superadmin' });
  } catch (err) {
    console.log(err.message);
    // ValidationError: field "role" must be one of [admin, user, guest]
  }

  // Cleanup
  unsubscribe();
  await unsub();
  await store.stop();
}

main();
```

## What Changed?

Compare the two approaches:

**Before** (manual Maps):
- No schema — invalid data enters silently
- No change notifications — UIs poll or go stale
- No transactions — cross-Map writes risk inconsistency
- Cleanup code for every collection, duplicated validation at every entry point

**After** (noex-store):
- Schema enforced on every write — invalid data is rejected with a descriptive error
- Reactive queries fire callbacks automatically when underlying data changes
- Events published on every mutation for audit, logging, or downstream systems
- TTL and lifecycle managed declaratively — no manual cleanup code

## Exercise

Below is a manual data management module for a task tracker. Identify all the problems and describe how you would solve each one using noex-store concepts (plain text, not code).

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
<summary>Solution</summary>

**Problem 1: No schema — `status` accepts any string**
- Solution: Define a bucket with `status: { type: 'string', enum: ['open', 'in_progress', 'done'] }`. Any invalid status is rejected on insert or update.

**Problem 2: No ID generation guarantee — `nextId` is a plain counter that resets on restart**
- Solution: Use `generated: 'uuid'` or `generated: 'autoincrement'` on the key field. The store manages counters and persists them.

**Problem 3: Mutable records — `completeTask` mutates the Map value directly**
- Solution: Use `bucket.update(id, { status: 'done' })`. The store validates the change, bumps `_version`, and publishes an `updated` event.

**Problem 4: No change notifications — the UI doesn't know when tasks change**
- Solution: Define a reactive query (e.g., `tasksByAssignee`) and subscribe. The callback re-fires whenever a matching task is inserted, updated, or deleted.

**Problem 5: Full scan on `getTasksByAssignee` — O(n) every time**
- Solution: Declare `indexes: ['assignee']` in the bucket definition. The store uses a secondary index for O(1) lookups by assignee.

**Problem 6: Manual cleanup with `deleteCompletedTasks` — must be called explicitly**
- Solution: Use TTL (`ttl: '7d'`) to automatically expire completed tasks, or listen for the `updated` event and delete completed tasks via the event handler.

**Problem 7: No metadata — no way to know when a task was created or last modified**
- Solution: Every store record automatically gets `_version`, `_createdAt`, and `_updatedAt` metadata fields.

**Problem 8: No validation — empty titles and empty assignees are accepted**
- Solution: Add `required: true` and `minLength: 1` constraints to the `title` and `assignee` fields.

</details>

## Summary

- A plain `Map` works for trivial cases but offers no schema, validation, change tracking, or coordination
- As applications grow, lack of structure leads to stale UIs, invalid data, duplicated validation, and inconsistent state
- A reactive data layer centralizes data management with declarative schemas, automatic validation, and change notifications
- `@hamicek/noex-store` provides schema-enforced buckets, secondary indexes, reactive queries, transactions, events, TTL, and persistence — all configured declaratively
- The application code shrinks to declaring what the data looks like and subscribing to changes — the store handles the rest

---

Next: [Key Concepts](./02-key-concepts.md)
