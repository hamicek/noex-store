# Size Limits and Eviction

Your cache bucket keeps every record ever inserted. A hundred records become a thousand, then ten thousand. Memory grows proportionally, and eventually the process hits its limit. You could track the count yourself, decide which records to delete, handle the edge cases — but every bucket with a size constraint would need the same boilerplate.

noex-store provides `maxSize` — a per-bucket cap on the number of records. When an insert would push the bucket over the limit, the oldest records (by `_createdAt`) are automatically evicted before the new record is stored. Evictions emit standard delete events, trigger reactive query updates, and maintain index consistency.

## What You'll Learn

- How to configure `maxSize` on a bucket
- How the eviction algorithm selects records to remove
- How eviction interacts with events, reactive queries, and indexes
- How to combine `maxSize` with TTL for dual-bounded buckets
- How to reason about eviction ordering and edge cases

## Configuring maxSize

Add the `maxSize` property to any bucket definition:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start();

await store.defineBucket('recentLogs', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    level:   { type: 'string', enum: ['info', 'warn', 'error'], required: true },
    message: { type: 'string', required: true },
  },
  maxSize: 1000, // Keep only the latest 1000 log entries
});
```

`maxSize` must be a positive integer. There is no default — buckets without `maxSize` grow without bound.

## How Eviction Works

When an insert would cause the bucket to exceed `maxSize`, the store evicts the oldest records before storing the new one:

```text
  insert(newRecord)
      |
      v
  Is table.size >= maxSize?
      |
      no -> Store newRecord normally
      |
      yes -> Calculate evictCount = table.size - maxSize + 1
      |
      v
  Sort all records by _createdAt (ascending)
      |
      v
  Take the first `evictCount` records (oldest)
      |
      v
  For each record to evict:
      |
      +-- Remove from IndexManager
      +-- Remove from in-memory Map
      +-- Emit bucket.<name>.deleted event
      |
      v
  Store newRecord normally
```

### Eviction Properties

| Property | Behavior |
|----------|----------|
| **Sort key** | `_createdAt` (ascending) — oldest records evicted first |
| **Eviction count** | `table.size - maxSize + 1` — makes room for exactly one new record |
| **Atomic per insert** | Eviction and insert happen within the same GenServer message — no concurrent mutations interleave |
| **Index consistency** | Evicted records are removed from all secondary and unique indexes before the new record is added |
| **Event emission** | Each evicted record emits a standard `bucket.<name>.deleted` event |

### Eviction Example

```typescript
const store = await Store.start();

await store.defineBucket('buffer', {
  key: 'id',
  schema: {
    id:   { type: 'number', generated: 'autoincrement' },
    data: { type: 'string', required: true },
  },
  maxSize: 3,
});

const buf = store.bucket('buffer');

const r1 = await buf.insert({ data: 'first' });   // size: 1
const r2 = await buf.insert({ data: 'second' });  // size: 2
const r3 = await buf.insert({ data: 'third' });   // size: 3

// At capacity. Next insert evicts the oldest record (r1).
const r4 = await buf.insert({ data: 'fourth' });  // size: 3

console.log(await buf.get(r1.id)); // undefined — evicted
console.log(await buf.get(r2.id)); // { id: 2, data: 'second', ... }
console.log(await buf.get(r3.id)); // { id: 3, data: 'third', ... }
console.log(await buf.get(r4.id)); // { id: 4, data: 'fourth', ... }
console.log(await buf.count());    // 3
```

The bucket never exceeds 3 records. Each new insert beyond capacity pushes out the oldest.

## Eviction and Events

Every evicted record emits a `bucket.<name>.deleted` event — identical to a manual `delete()` call:

```typescript
const store = await Store.start();

await store.defineBucket('ring', {
  key: 'id',
  schema: {
    id:    { type: 'number', generated: 'autoincrement' },
    value: { type: 'string', required: true },
  },
  maxSize: 2,
});

const evicted: unknown[] = [];
await store.on('bucket.ring.deleted', (event) => {
  evicted.push(event.record);
});

await store.bucket('ring').insert({ value: 'a' });
await store.bucket('ring').insert({ value: 'b' });

// This insert evicts 'a'
await store.bucket('ring').insert({ value: 'c' });
await store.settle();

console.log(evicted.length); // 1
console.log((evicted[0] as Record<string, unknown>).value); // 'a'
```

Event consumers don't need to know whether a deletion was manual, TTL-driven, or caused by eviction — they all produce the same event shape. If you need to distinguish, check `record._expiresAt` for TTL (present on TTL-enabled buckets) or track the source in your event handler logic.

## Eviction and Reactive Queries

Reactive queries that depend on a size-limited bucket see updates whenever eviction occurs:

```typescript
const store = await Store.start();

await store.defineBucket('latest', {
  key: 'id',
  schema: {
    id:   { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
  maxSize: 2,
});

store.defineQuery('allLatest', async (ctx) => {
  return ctx.bucket('latest').all();
});

const snapshots: Array<Array<Record<string, unknown>>> = [];
await store.subscribe('allLatest', (result) => {
  snapshots.push(result);
});

await store.bucket('latest').insert({ name: 'Alice' });
await store.settle();
// snapshots[0]: [Alice]

await store.bucket('latest').insert({ name: 'Bob' });
await store.settle();
// snapshots[1]: [Alice, Bob]

await store.bucket('latest').insert({ name: 'Carol' });
await store.settle();
// snapshots[2]: [Bob, Carol] — Alice evicted, Carol added

const names = snapshots[2].map((r) => r.name);
console.log(names); // ['Bob', 'Carol']
```

The reactive query automatically reflects the eviction — consumers always see the current state of the bounded bucket.

## Eviction and Indexes

Evicted records are removed from all secondary and unique indexes before the new record is added. Index consistency is maintained within the same GenServer message:

```text
  insert(newRecord) — bucket at maxSize
      |
      v
  evictOldest():
      |
      +-- indexManager.removeRecord(oldKey, oldRecord)
      +-- table.delete(oldKey)
      +-- emit deleted event
      |
      v
  indexManager.addRecord(newKey, newRecord)
  table.set(newKey, newRecord)
  emit inserted event
```

This means queries using indexed fields always return correct results, even when eviction and insertion happen in the same operation:

```typescript
const store = await Store.start();

await store.defineBucket('taggedItems', {
  key: 'id',
  schema: {
    id:  { type: 'number', generated: 'autoincrement' },
    tag: { type: 'string', required: true },
  },
  indexes: ['tag'],
  maxSize: 3,
});

const items = store.bucket('taggedItems');

await items.insert({ tag: 'urgent' });   // id: 1
await items.insert({ tag: 'normal' });   // id: 2
await items.insert({ tag: 'urgent' });   // id: 3

// At capacity. Next insert evicts id:1 (tag: 'urgent'), then adds id:4.
await items.insert({ tag: 'low' });      // id: 4

const urgent = await items.where({ tag: 'urgent' });
console.log(urgent.length); // 1 (only id:3 — id:1 was evicted and removed from the index)
```

## Combining maxSize and TTL

A bucket can have both `maxSize` and `ttl`. They operate independently — `maxSize` evicts on insert when at capacity, and TTL purges expired records on a schedule:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('sessionCache', {
  key: 'token',
  schema: {
    token:  { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '30m',   // Records expire after 30 minutes
  maxSize: 1000, // Never more than 1000 records in memory
});
```

### How They Interact

```text
  Timeline:
  ──────────────────────────────────────────────────────>

  t=0     insert #1          size: 1
  t=1     insert #2          size: 2
  ...
  t=999   insert #1000       size: 1000 (at maxSize)
  t=1000  insert #1001       evicts #1 (oldest by _createdAt), size: 1000
  ...
  t=1800  TTL purge          removes all records with _expiresAt <= now
                             (records from t=0 to t=~800 expired)
                             size: ~200
  t=1801  insert #N          size: ~201 (well under maxSize, no eviction)
```

| Scenario | maxSize | TTL | What Happens |
|----------|---------|-----|------------|
| Low traffic, short TTL | 1000 | 5m | TTL does most cleanup; maxSize rarely triggers |
| High traffic, long TTL | 100 | 24h | maxSize does most cleanup; TTL catches stragglers |
| Burst traffic | 50 | 1h | maxSize limits memory during bursts; TTL cleans up after |

### Order of Operations on Insert

```text
  insert(data)
      |
      v
  1. Validate and prepare record (schema, auto-generation)
      |
      v
  2. Set _expiresAt if bucket has TTL and record doesn't have one
      |
      v
  3. If table.size >= maxSize: evict oldest records
      |
      v
  4. Add to index, store in Map, emit inserted event
```

TTL expiration is set on the record **before** the maxSize check. This means an evicted record that also has a TTL would have been purged eventually by the TtlManager — eviction just removes it sooner.

## Bucket Stats

Size-related information is available through bucket stats:

```typescript
const stats = await store.bucket('sessionCache').stats();

console.log(stats.hasMaxSize); // true
console.log(stats.maxSize);    // 1000
console.log(stats.recordCount); // current number of records
console.log(stats.hasTtl);     // true (if TTL is also configured)
```

## Complete Working Example

A notification system with a bounded inbox — each user sees only their last 50 notifications:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start();

  await store.defineBucket('notifications', {
    key: 'id',
    schema: {
      id:      { type: 'number', generated: 'autoincrement' },
      userId:  { type: 'string', required: true },
      type:    { type: 'string', enum: ['info', 'warning', 'error'], required: true },
      message: { type: 'string', required: true },
      read:    { type: 'boolean', default: false },
    },
    indexes: ['userId', 'type'],
    maxSize: 50, // Global cap: keep only 50 most recent notifications
  });

  // Track evictions for audit
  let evictedCount = 0;
  await store.on('bucket.notifications.deleted', () => {
    evictedCount++;
  });

  // Reactive query: unread count
  store.defineQuery('unreadCount', async (ctx) => {
    const all = await ctx.bucket('notifications').where({ read: false });
    return all.length;
  });

  await store.subscribe('unreadCount', (count) => {
    console.log(`Unread notifications: ${count}`);
  });

  const notif = store.bucket('notifications');

  // Simulate a flood of notifications
  for (let i = 1; i <= 60; i++) {
    await notif.insert({
      userId: i <= 40 ? 'alice' : 'bob',
      type: i % 10 === 0 ? 'error' : 'info',
      message: `Notification #${i}`,
    });
  }

  await store.settle();

  // Only 50 notifications remain (the first 10 were evicted)
  console.log(`\nTotal notifications: ${await notif.count()}`); // 50
  console.log(`Evicted: ${evictedCount}`); // 10

  // The oldest 10 (IDs 1-10) were evicted
  console.log(`ID 1 exists: ${(await notif.get(1)) !== undefined}`);  // false
  console.log(`ID 11 exists: ${(await notif.get(11)) !== undefined}`); // true
  console.log(`ID 60 exists: ${(await notif.get(60)) !== undefined}`); // true

  // Indexed queries work correctly post-eviction
  const aliceNotifs = await notif.where({ userId: 'alice' });
  console.log(`Alice's notifications: ${aliceNotifs.length}`); // 30 (40 inserted - 10 evicted)

  const errors = await notif.where({ type: 'error' });
  console.log(`Error notifications: ${errors.length}`);

  // Aggregations reflect the bounded state
  const total = await notif.count();
  const unread = (await notif.where({ read: false })).length;
  console.log(`${unread}/${total} unread`);

  await store.stop();
}

main();
```

## Exercise

You're building a leaderboard system. The `scores` bucket tracks player high scores, limited to the top 10. A `recentGames` bucket records the last 100 games with a 24-hour TTL.

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('scores', {
  key: 'playerId',
  schema: {
    playerId: { type: 'string', required: true },
    score:    { type: 'number', required: true, min: 0 },
    game:     { type: 'string', required: true },
  },
  maxSize: 10,
});
```

1. Define the `recentGames` bucket with fields `id` (number, autoincrement), `playerId` (string, required), `score` (number, required), `map` (string, required). It should have `maxSize: 100` and `ttl: '24h'`. Index by `playerId`.
2. Insert 12 scores into the `scores` bucket for different players. After all inserts, how many records exist? Which 2 players were evicted?
3. Define a reactive query `topScores` that returns all records from the `scores` bucket. Subscribe to it. Insert one more score — does the subscription fire? What does it contain?
4. Insert 5 games into `recentGames`. Verify that all 5 have `_expiresAt` set. What happens when you call `purgeTtl()` immediately (before the TTL expires)?

<details>
<summary>Solution</summary>

1. The `recentGames` bucket:

```typescript
await store.defineBucket('recentGames', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    playerId: { type: 'string', required: true },
    score:    { type: 'number', required: true },
    map:      { type: 'string', required: true },
  },
  indexes: ['playerId'],
  maxSize: 100,
  ttl: '24h',
});
```

2. Insert 12 scores — only 10 remain:

```typescript
const scores = store.bucket('scores');

const players = [
  { playerId: 'p1', score: 100, game: 'chess' },
  { playerId: 'p2', score: 250, game: 'chess' },
  { playerId: 'p3', score: 180, game: 'checkers' },
  { playerId: 'p4', score: 300, game: 'chess' },
  { playerId: 'p5', score: 90, game: 'checkers' },
  { playerId: 'p6', score: 420, game: 'chess' },
  { playerId: 'p7', score: 350, game: 'checkers' },
  { playerId: 'p8', score: 200, game: 'chess' },
  { playerId: 'p9', score: 275, game: 'checkers' },
  { playerId: 'p10', score: 310, game: 'chess' },
  { playerId: 'p11', score: 500, game: 'chess' },
  { playerId: 'p12', score: 150, game: 'checkers' },
];

for (const p of players) {
  await scores.insert(p);
}

console.log(await scores.count()); // 10
// p1 (first inserted, _createdAt is oldest) and p2 (second oldest) were evicted.
// Eviction is by _createdAt order, NOT by score value.
console.log(await scores.get('p1'));  // undefined
console.log(await scores.get('p2'));  // undefined
console.log(await scores.get('p3'));  // { playerId: 'p3', score: 180, ... }
console.log(await scores.get('p12')); // { playerId: 'p12', score: 150, ... }
```

3. Reactive query updates on eviction:

```typescript
store.defineQuery('topScores', async (ctx) => {
  return ctx.bucket('scores').all();
});

const snapshots: unknown[][] = [];
await store.subscribe('topScores', (result) => {
  snapshots.push(result);
});
await store.settle();

console.log(snapshots.length); // 1
console.log(snapshots[0].length); // 10

// Insert one more — evicts p3 (now the oldest)
await scores.insert({ playerId: 'p13', score: 600, game: 'chess' });
await store.settle();

console.log(snapshots.length); // 2
console.log(snapshots[1].length); // 10 (still 10 — one evicted, one added)
const ids = snapshots[1].map((r: Record<string, unknown>) => r.playerId);
console.log(ids.includes('p3'));  // false — evicted
console.log(ids.includes('p13')); // true — added
```

4. Games with TTL:

```typescript
const games = store.bucket('recentGames');

const g1 = await games.insert({ playerId: 'p1', score: 100, map: 'arena' });
const g2 = await games.insert({ playerId: 'p2', score: 250, map: 'forest' });
const g3 = await games.insert({ playerId: 'p1', score: 180, map: 'arena' });
const g4 = await games.insert({ playerId: 'p3', score: 300, map: 'desert' });
const g5 = await games.insert({ playerId: 'p2', score: 90, map: 'forest' });

// All have _expiresAt set (24 hours from _createdAt)
console.log(g1._expiresAt); // _createdAt + 86_400_000
console.log(g2._expiresAt); // _createdAt + 86_400_000
console.log(g3._expiresAt); // _createdAt + 86_400_000
console.log(g4._expiresAt); // _createdAt + 86_400_000
console.log(g5._expiresAt); // _createdAt + 86_400_000

// Purge immediately — nothing expires because _expiresAt is 24 hours away
const purged = await store.purgeTtl();
console.log(purged); // 0
console.log(await games.count()); // 5 — all records still present
```

</details>

## Summary

- **`maxSize`** sets a per-bucket cap on the number of records — the bucket never exceeds this count
- **Eviction order** is by `_createdAt` ascending — the oldest records are removed first to make room for new inserts
- Eviction count is `table.size - maxSize + 1` — exactly enough room for the new record
- Eviction is **atomic** within a single GenServer message — no concurrent mutations can interleave between eviction and insertion
- Evicted records are **removed from all indexes** (secondary and unique) before the new record is added
- Each evicted record emits a standard **`bucket.<name>.deleted` event** — indistinguishable from manual deletes
- **Reactive queries** that depend on size-limited buckets are automatically re-evaluated when eviction occurs
- **`maxSize` and `ttl` are independent**: maxSize evicts on insert when at capacity, TTL purges on a schedule when records expire — they complement each other for dual-bounded buckets
- On insert, the order is: validate, set `_expiresAt` (if TTL), evict (if at maxSize), store and index
- **Bucket stats** expose `hasMaxSize`, `maxSize`, and `recordCount` for monitoring

## API Reference

- [TTL and Lifecycle](../../reference/ttl-lifecycle.md) — `maxSize`, LRU eviction, record metadata

---

Next: [Supervision Tree](../10-architecture/01-supervision-tree.md)
