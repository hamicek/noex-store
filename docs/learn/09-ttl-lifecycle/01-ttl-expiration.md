# TTL Expiration

Your cache bucket grows without bound. Session tokens from yesterday sit next to tokens from last month. API response caches from endpoints that no longer exist occupy memory alongside fresh data. You write cleanup scripts that run on cron, manually iterate every record, check timestamps, and delete — but they race with inserts, miss edge cases, and add operational burden that scales with the number of buckets.

noex-store provides built-in TTL (Time-To-Live) support. Define a duration on the bucket, and every inserted record gets an expiration timestamp. A background `TtlManager` periodically scans registered buckets and purges expired records — emitting delete events, triggering reactive query updates, and keeping memory bounded. You can also override the expiration per record or trigger a manual purge at any time.

## What You'll Learn

- How to configure TTL on a bucket using human-readable duration strings
- How `_expiresAt` is computed and stored on each record
- How the `TtlManager` schedules and executes purge cycles
- How to override TTL per record at insert time
- How to trigger manual purge with `store.purgeTtl()`
- How TTL interacts with events, reactive queries, and persistence

## Duration Syntax

TTL accepts either a number (milliseconds) or a human-readable string with a unit suffix:

| Format | Unit | Example | Milliseconds |
|--------|------|---------|-------------|
| `number` | milliseconds | `5000` | `5000` |
| `"Ns"` | seconds | `"30s"` | `30,000` |
| `"Nm"` | minutes | `"5m"` | `300,000` |
| `"Nh"` | hours | `"1h"` | `3,600,000` |
| `"Nd"` | days | `"7d"` | `604,800,000` |

Fractional values are supported: `"1.5h"` = 5,400,000ms, `"0.5d"` = 43,200,000ms.

The value must be positive and finite. Zero, negative, and `Infinity` values throw an error.

```typescript
// All equivalent — 5-minute TTL
await store.defineBucket('cache', { ...def, ttl: 300_000 });
await store.defineBucket('cache', { ...def, ttl: '5m' });
await store.defineBucket('cache', { ...def, ttl: '300s' });
```

## Configuring a TTL Bucket

Add the `ttl` property to any bucket definition:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start();

await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token:  { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
    ip:     { type: 'string' },
  },
  ttl: '30m', // Sessions expire after 30 minutes
});

const session = await store.bucket('sessions').insert({
  userId: 'user-42',
  ip: '192.168.1.1',
});

console.log(session._expiresAt);
// session._createdAt + 1_800_000 (30 minutes in ms)
```

When a record is inserted into a TTL-enabled bucket, the store computes `_expiresAt = _createdAt + ttlMs` and attaches it to the record metadata. The `_expiresAt` field is a Unix millisecond timestamp — the same format as `Date.now()`.

### How `_expiresAt` Is Set

```text
  insert({ userId: 'user-42' })
      |
      v
  SchemaValidator.prepareInsert()
      |  - generates key (uuid)
      |  - sets _createdAt = Date.now()
      |  - sets _version = 1
      |
      v
  TTL check: bucket has ttl AND record has no _expiresAt?
      |
      yes -> _expiresAt = _createdAt + ttlMs
      |
      v
  Record stored in bucket Map
```

The TTL is applied **after** validation and auto-generation but **before** the record is stored. If the record already has an `_expiresAt` value (per-record override), the bucket TTL is skipped.

## Per-Record TTL Override

You can override the bucket's default TTL for individual records by passing `_expiresAt` directly in the insert data:

```typescript
await store.defineBucket('cache', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    url:   { type: 'string', required: true },
    body:  { type: 'string', required: true },
  },
  ttl: '1h', // Default: 1-hour TTL
});

const cache = store.bucket('cache');

// Uses the default 1-hour TTL
const normal = await cache.insert({
  url: '/api/users',
  body: '{"users": [...]}',
});
console.log(normal._expiresAt); // _createdAt + 3_600_000

// Override: this response is only valid for 30 seconds
const shortLived = await cache.insert({
  url: '/api/health',
  body: '{"status": "ok"}',
  _expiresAt: Date.now() + 30_000,
});
console.log(shortLived._expiresAt); // ~30 seconds from now

// Override: this response should live for 24 hours
const longLived = await cache.insert({
  url: '/api/config',
  body: '{"theme": "dark"}',
  _expiresAt: Date.now() + 86_400_000,
});
```

This is useful when different records in the same bucket have different freshness requirements — health check responses expire in seconds, while configuration responses can live for hours.

## The TtlManager

The `TtlManager` is a background scheduler that periodically scans all TTL-enabled buckets and purges expired records. It's created automatically when the store starts.

### Architecture

```text
  Store.start()
      |
      v
  Create TtlManager(checkIntervalMs)
      |
      v
  For each defineBucket() with ttl:
      |
      +-- ttlManager.registerBucket(name, ref, ttlMs)
      |
      v
  ttlManager.start()
      |
      v
  Schedule tick (setTimeout)
      |
      +-- tick() -> for each bucket: GenServer.call({ type: 'purgeExpired' })
      |                  |
      |                  v
      |            BucketServer scans all records:
      |              if record._expiresAt <= Date.now() -> delete + emit event
      |                  |
      |                  v
      |            Return count of purged records
      |
      +-- Schedule next tick (setTimeout)
      |
      (repeats until stop())
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `setTimeout` chaining, not `setInterval` | Prevents overlapping ticks when a purge cycle runs longer than the check interval |
| Skips stopped buckets | A bucket may be dropped between ticks — `TtlManager` checks `GenServer.isRunning()` before each call |
| Swallows per-bucket errors | One failing bucket doesn't prevent other buckets from being purged |
| Runs in the same event loop | No worker threads — purge is a series of async GenServer calls |

### Configuring the Check Interval

The default check interval is 1000ms (1 second). Configure it via `ttlCheckIntervalMs` in store options:

```typescript
// Default: check every 1 second
const store = await Store.start();

// Aggressive: check every 100ms (higher CPU, lower expiration latency)
const store = await Store.start({ ttlCheckIntervalMs: 100 });

// Relaxed: check every 10 seconds (lower CPU, records may live up to 10s past expiration)
const store = await Store.start({ ttlCheckIntervalMs: 10_000 });

// Disabled: no automatic checks (manual purge only)
const store = await Store.start({ ttlCheckIntervalMs: 0 });
```

| Interval | Expiration Latency | CPU Overhead | Use Case |
|----------|-------------------|--------------|----------|
| `100` | ~100ms | Higher | Real-time systems, short TTLs |
| `1000` (default) | ~1s | Low | General-purpose caching |
| `10000` | ~10s | Minimal | Long TTLs (hours/days), low traffic |
| `0` | Manual only | None | Tests, full control |

Expiration latency is the worst-case delay between a record's `_expiresAt` and its actual removal. A record with `_expiresAt = 1000` and a check interval of 5000ms could live until `t = 5999`.

## Manual Purge

Call `store.purgeTtl()` to trigger an immediate expiration check across all TTL-enabled buckets:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 }); // Automatic checks disabled

await store.defineBucket('tokens', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: '1h',
});

await store.bucket('tokens').insert({ userId: 'user-1' });
await store.bucket('tokens').insert({ userId: 'user-2' });

// Later, when you know tokens should be expired...
const purged = await store.purgeTtl();
console.log(`Purged ${purged} expired records`);
```

`purgeTtl()` returns the total number of purged records across all buckets. It's useful in tests where you want deterministic expiration without waiting for the automatic scheduler, or in applications that prefer explicit control.

## TTL and Events

Expired records are deleted through the same path as manual deletes. Each purged record emits a `bucket.<name>.deleted` event:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('cache', {
  key: 'id',
  schema: {
    id:  { type: 'string', generated: 'uuid' },
    url: { type: 'string', required: true },
  },
  ttl: 100, // 100ms for demonstration
});

// Listen for deletions (both manual and TTL-driven)
await store.on('bucket.cache.deleted', (event) => {
  console.log(`Record expired: key=${event.key}`);
});

await store.bucket('cache').insert({ url: '/api/data' });

// Wait for expiration, then purge
await new Promise((r) => setTimeout(r, 150));
await store.purgeTtl();
// Console: "Record expired: key=<uuid>"
```

There is no separate "expired" event type. Consumers see a standard `deleted` event — they don't need to know whether the deletion was manual or TTL-driven. If you need to distinguish, check `record._expiresAt` in the event payload: if it exists and is less than or equal to `Date.now()`, the deletion was likely triggered by TTL expiration.

## TTL and Reactive Queries

When expired records are purged, any reactive query that depends on the affected bucket is automatically re-evaluated:

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('sessions', {
  key: 'token',
  schema: {
    token:  { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
  ttl: 100,
});

store.defineQuery('activeSessions', async (ctx) => {
  return ctx.bucket('sessions').all();
});

const snapshots: unknown[][] = [];
await store.subscribe('activeSessions', (result) => {
  snapshots.push(result);
});

// Insert a session
await store.bucket('sessions').insert({ userId: 'user-1' });
await store.settle();
console.log(snapshots.length);    // 1
console.log(snapshots[0].length); // 1 session

// Wait for expiration, then purge
await new Promise((r) => setTimeout(r, 150));
await store.purgeTtl();
await store.settle();
console.log(snapshots.length);    // 2
console.log(snapshots[1].length); // 0 sessions — reactive query updated automatically
```

The reactive query sees the empty bucket after purge — no manual re-subscription or polling required. This is the same mechanism that handles manual deletes and updates.

## TTL and Persistence

TTL and persistence work independently. A TTL-enabled bucket can be persistent — the `_expiresAt` field is part of the record and survives restart:

```typescript
import { MemoryAdapter } from '@hamicek/noex';

const adapter = new MemoryAdapter();

// First run: insert a record with 1-hour TTL
const store1 = await Store.start({
  name: 'app',
  persistence: { adapter },
  ttlCheckIntervalMs: 0,
});

await store1.defineBucket('cache', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    data: { type: 'string', required: true },
  },
  ttl: '1h',
});

const record = await store1.bucket('cache').insert({ data: 'cached response' });
console.log(record._expiresAt); // 1 hour from now

await store1.stop();

// Second run: record is restored with its _expiresAt intact
const store2 = await Store.start({
  name: 'app',
  persistence: { adapter },
  ttlCheckIntervalMs: 0,
});

await store2.defineBucket('cache', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    data: { type: 'string', required: true },
  },
  ttl: '1h',
});

const restored = await store2.bucket('cache').get(record.id);
console.log(restored?._expiresAt === record._expiresAt); // true

// If the TTL expired during downtime, the next purge removes it
await store2.purgeTtl();

await store2.stop();
```

If the process was down longer than the TTL, the record's `_expiresAt` will be in the past after restart. The first purge cycle (automatic or manual) removes it.

## Bucket Stats

TTL-related information is available through bucket stats:

```typescript
const stats = await store.bucket('sessions').stats();

console.log(stats.hasTtl);   // true — bucket has TTL configured
console.log(stats.hasMaxSize); // false — no maxSize on this bucket
```

And at the store level:

```typescript
const storeStats = await store.stats();

console.log(storeStats.ttl.enabled);        // true — TtlManager is running
console.log(storeStats.ttl.checkIntervalMs); // 1000
```

## Complete Working Example

A URL shortener with cached redirect lookups that expire after 15 minutes:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ ttlCheckIntervalMs: 0 });

  // Permanent bucket for short URL definitions
  await store.defineBucket('urls', {
    key: 'slug',
    schema: {
      slug:      { type: 'string', required: true },
      targetUrl: { type: 'string', required: true },
      createdBy: { type: 'string', required: true },
      clicks:    { type: 'number', default: 0 },
    },
    indexes: ['createdBy'],
  });

  // Cache bucket for resolved redirects (TTL: 15 minutes)
  await store.defineBucket('redirectCache', {
    key: 'slug',
    schema: {
      slug:      { type: 'string', required: true },
      targetUrl: { type: 'string', required: true },
    },
    ttl: '15m',
  });

  // Listen for cache expirations
  await store.on('bucket.redirectCache.deleted', (event) => {
    console.log(`Cache expired for slug: ${event.key}`);
  });

  // Reactive query: count active cache entries
  store.defineQuery('cacheSize', async (ctx) => {
    return ctx.bucket('redirectCache').count();
  });

  await store.subscribe('cacheSize', (count) => {
    console.log(`Active cache entries: ${count}`);
  });

  // Create URL mappings
  const urls = store.bucket('urls');
  const cache = store.bucket('redirectCache');

  await urls.insert({ slug: 'docs', targetUrl: 'https://docs.example.com', createdBy: 'admin' });
  await urls.insert({ slug: 'blog', targetUrl: 'https://blog.example.com', createdBy: 'admin' });
  await urls.insert({ slug: 'gh', targetUrl: 'https://github.com/example', createdBy: 'dev' });

  // Simulate resolving redirects (populates cache)
  async function resolve(slug: string): Promise<string | undefined> {
    // Check cache first
    const cached = await cache.get(slug);
    if (cached) return cached.targetUrl as string;

    // Cache miss: look up and cache
    const url = await urls.get(slug);
    if (!url) return undefined;

    await cache.insert({ slug, targetUrl: url.targetUrl as string });
    await urls.update(slug, { clicks: (url.clicks as number) + 1 });
    return url.targetUrl as string;
  }

  console.log(await resolve('docs'));  // https://docs.example.com (cache miss)
  console.log(await resolve('docs'));  // https://docs.example.com (cache hit)
  console.log(await resolve('blog')); // https://blog.example.com (cache miss)

  await store.settle();
  // Console: "Active cache entries: 2"

  console.log(`Cache records: ${await cache.count()}`); // 2
  console.log(`URL clicks:`, (await urls.get('docs'))?.clicks); // 1

  // Simulate time passing — in production, TtlManager handles this automatically
  // For this example, we manually expire by inserting with short TTL
  console.log('\n--- Simulating expiration ---');

  // In a real app, after 15 minutes the automatic purge would remove these.
  // Here we demonstrate manual purge:
  await store.purgeTtl();
  await store.settle();

  console.log(`Cache records after purge: ${await cache.count()}`);

  await store.stop();
}

main();
```

## Exercise

You're building a rate limiter. Each API request creates a record in a `rateLimits` bucket with a 1-minute TTL. To check if a user is rate-limited, count their records — if the count exceeds the threshold, reject the request.

```typescript
const store = await Store.start({ ttlCheckIntervalMs: 0 });

await store.defineBucket('rateLimits', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
    path:   { type: 'string', required: true },
  },
  indexes: ['userId'],
  ttl: '1m',
});
```

1. Write a function `recordRequest(userId: string, path: string)` that inserts a rate limit record.
2. Write a function `isRateLimited(userId: string, limit: number): Promise<boolean>` that returns `true` if the user has `limit` or more active records.
3. Record 3 requests for user `"alice"` on path `"/api/data"`. Is Alice rate-limited with a limit of 5? With a limit of 3?
4. Wait for the TTL to expire, run `purgeTtl()`, and check if Alice is still rate-limited.
5. Bonus: Insert a request with a custom `_expiresAt` of 10 seconds instead of the default 1 minute. When does this record expire relative to the others?

<details>
<summary>Solution</summary>

```typescript
const rl = store.bucket('rateLimits');

// 1. Record a request
async function recordRequest(userId: string, path: string) {
  await rl.insert({ userId, path });
}

// 2. Check rate limit
async function isRateLimited(userId: string, limit: number): Promise<boolean> {
  const records = await rl.where({ userId });
  return records.length >= limit;
}

// 3. Record 3 requests for Alice
await recordRequest('alice', '/api/data');
await recordRequest('alice', '/api/data');
await recordRequest('alice', '/api/data');

console.log(await isRateLimited('alice', 5)); // false (3 < 5)
console.log(await isRateLimited('alice', 3)); // true  (3 >= 3)

// 4. Wait for TTL expiration and purge
await new Promise((r) => setTimeout(r, 61_000)); // Wait > 1 minute
const purged = await store.purgeTtl();
console.log(`Purged: ${purged}`); // 3

console.log(await isRateLimited('alice', 3)); // false (0 < 3)

// 5. Custom expiration
const shortLived = await rl.insert({
  userId: 'alice',
  path: '/api/health',
  _expiresAt: Date.now() + 10_000, // 10 seconds instead of 1 minute
});

const defaultLived = await rl.insert({
  userId: 'alice',
  path: '/api/data',
});

console.log(shortLived._expiresAt);  // ~10 seconds from now
console.log(defaultLived._expiresAt); // ~60 seconds from now
// The short-lived record expires 50 seconds earlier than the default one.
```

</details>

## Summary

- **TTL is per-bucket**: set `ttl` in the bucket definition using a number (ms) or a string with suffix (`"30s"`, `"5m"`, `"1h"`, `"7d"`)
- **`_expiresAt`** is a Unix millisecond timestamp automatically computed as `_createdAt + ttlMs` on insert
- **Per-record override**: pass `_expiresAt` in the insert data to override the bucket default — useful for records with different freshness requirements
- **`TtlManager`** runs a background loop using `setTimeout` chaining — it calls `purgeExpired` on each registered bucket at the configured interval (default: 1s)
- The check interval is configurable via `ttlCheckIntervalMs` in store options — set to `0` to disable automatic checks
- **`store.purgeTtl()`** triggers an immediate purge across all TTL-enabled buckets and returns the total count of purged records
- Expired records emit standard **`bucket.<name>.deleted` events** — no separate "expired" event type
- **Reactive queries** that depend on a TTL-enabled bucket are automatically re-evaluated when records are purged
- TTL records **survive persistence** — `_expiresAt` is part of the record and is restored on restart; the first purge cycle removes records that expired during downtime
- **Bucket stats** expose `hasTtl` and store stats expose `ttl.enabled` and `ttl.checkIntervalMs`

## API Reference

- [TTL and Lifecycle](../../reference/ttl-lifecycle.md) — `parseTtl()`, `TtlManager`, `_expiresAt`, `purgeTtl()`

---

Next: [Size Limits and Eviction](./02-size-limits-and-eviction.md)
