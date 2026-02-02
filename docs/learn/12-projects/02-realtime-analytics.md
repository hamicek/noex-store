# Real-Time Analytics

You have learned aggregation methods, TTL expiration, size-limited buckets, and reactive queries as separate features. Now you will combine them into a single application — a real-time analytics dashboard that tracks page views, computes KPIs on the fly, automatically expires stale data, and pushes live updates to subscribers without polling.

By the end, you will have a runnable project that exercises aggregation, TTL, maxSize, and reactive queries in a realistic monitoring scenario.

## What You'll Learn

- How to model time-series event data with TTL-enabled buckets
- How to use `maxSize` to create bounded buffers that evict oldest entries
- How to compute KPIs with `sum`, `avg`, `min`, and `max` inside reactive queries
- How to build a live dashboard that updates automatically on every data change
- How to combine TTL expiration and eviction with reactive re-evaluation
- How to structure an analytics pipeline from ingestion to real-time display

## Schema Design

An analytics system needs three buckets: raw page view events with automatic expiration, a bounded buffer of recent errors for quick inspection, and persistent daily summary records for historical reporting.

### Page Views

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({
  name: 'realtime-analytics',
  ttlCheckIntervalMs: 5_000,
});

await store.defineBucket('pageViews', {
  key: 'id',
  schema: {
    id:          { type: 'string', generated: 'cuid' },
    path:        { type: 'string', required: true },
    statusCode:  { type: 'number', required: true, min: 100, max: 599 },
    responseMs:  { type: 'number', required: true, min: 0 },
    userId:      { type: 'string', default: '' },
    referrer:    { type: 'string', default: '' },
    createdAt:   { type: 'date', generated: 'timestamp' },
  },
  indexes: ['path', 'statusCode', 'userId'],
  ttl: '1h',
});
```

Key decisions:

- **`ttl: '1h'`** means each page view automatically expires after one hour. The dashboard only shows the last hour of data — no manual cleanup needed.
- **`responseMs`** is the HTTP response time in milliseconds. This field drives the `avg`, `min`, and `max` aggregations.
- **`statusCode` index** enables fast filtering by HTTP status (200, 404, 500, etc.).
- **`path` index** supports per-page breakdowns without scanning every record.
- **`min: 0`** on `responseMs` prevents negative response times at the schema level.

### Error Log

```typescript
await store.defineBucket('errorLog', {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'cuid' },
    path:      { type: 'string', required: true },
    status:    { type: 'number', required: true, min: 400, max: 599 },
    message:   { type: 'string', required: true },
    createdAt: { type: 'date', generated: 'timestamp' },
  },
  indexes: ['status'],
  maxSize: 50,
});
```

Key decisions:

- **`maxSize: 50`** keeps only the 50 most recent errors. Oldest entries are evicted automatically when the 51st error arrives — a bounded buffer with zero maintenance.
- **`min: 400`** enforces that only 4xx/5xx responses enter this bucket.
- No TTL here — the size limit alone controls memory usage.

### Daily Summaries

```typescript
await store.defineBucket('dailySummaries', {
  key: 'date',
  schema: {
    date:           { type: 'string', required: true, pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    totalViews:     { type: 'number', default: 0, min: 0 },
    totalErrors:    { type: 'number', default: 0, min: 0 },
    avgResponseMs:  { type: 'number', default: 0, min: 0 },
    peakResponseMs: { type: 'number', default: 0, min: 0 },
  },
});
```

Key decisions:

- **`date` as natural key** (e.g., `"2025-01-15"`) — one record per day, upserted on each flush.
- **`pattern`** enforces ISO date format at the schema level.
- No TTL or maxSize — summaries are permanent historical records.

### Data Flow

```text
  HTTP Request
       |
       v
  +------------+     evict after 1h     +------------------+
  | pageViews  |  ----- TTL ----------> |   (purged)       |
  | (ttl: 1h)  |                        +------------------+
  +------------+
       |
       |--- status >= 400 ---> +-----------+    evict oldest
       |                       | errorLog  | -- maxSize: 50 -->  (evicted)
       |                       +-----------+
       |
       v
  +------------------+       +-------------------+
  | Reactive Queries | ----> | Live KPI Dashboard|
  | (sum/avg/min/max)|       | (auto-updates)    |
  +------------------+       +-------------------+
       |
       v
  +-----------------+
  | dailySummaries  |  (periodic flush)
  | (permanent)     |
  +-----------------+
```

## Bucket Handles

After defining all buckets, grab handles:

```typescript
const pageViews = store.bucket('pageViews');
const errorLog = store.bucket('errorLog');
const dailySummaries = store.bucket('dailySummaries');
```

## Ingestion

Every HTTP response feeds the analytics pipeline. If the response is an error, it goes into both buckets:

```typescript
async function recordPageView(data: {
  path: string;
  statusCode: number;
  responseMs: number;
  userId?: string;
  referrer?: string;
}) {
  const view = await pageViews.insert(data);

  if (data.statusCode >= 400) {
    await errorLog.insert({
      path: data.path,
      status: data.statusCode,
      message: `HTTP ${data.statusCode} on ${data.path}`,
    });
  }

  return view;
}
```

No transaction needed here — a page view and its error log entry are independent. If the error insert fails (e.g., validation), the page view still persists.

## Seeding Data

Populate the store with sample traffic to work with:

```typescript
await recordPageView({ path: '/', statusCode: 200, responseMs: 45, userId: 'u1' });
await recordPageView({ path: '/', statusCode: 200, responseMs: 52, userId: 'u2' });
await recordPageView({ path: '/api/users', statusCode: 200, responseMs: 120 });
await recordPageView({ path: '/api/orders', statusCode: 500, responseMs: 1500 });
await recordPageView({ path: '/api/orders', statusCode: 500, responseMs: 2100 });
await recordPageView({ path: '/dashboard', statusCode: 200, responseMs: 60 });
await recordPageView({ path: '/missing', statusCode: 404, responseMs: 12 });
await recordPageView({ path: '/', statusCode: 200, responseMs: 38, userId: 'u3' });
```

Eight page views: five successful, three errors. The error log contains three entries (two 500s and one 404).

## Aggregation Queries

The aggregation methods — `sum`, `avg`, `min`, `max` — turn raw events into KPIs. Each accepts an optional filter to narrow the computation.

### Basic Aggregations

```typescript
const totalViews = await pageViews.count();
console.log(`Total views: ${totalViews}`);
// Total views: 8

const avgResponse = await pageViews.avg('responseMs');
console.log(`Avg response: ${avgResponse.toFixed(1)}ms`);
// Avg response: 490.9ms

const maxResponse = await pageViews.max('responseMs');
console.log(`Slowest response: ${maxResponse}ms`);
// Slowest response: 2100ms

const minResponse = await pageViews.min('responseMs');
console.log(`Fastest response: ${minResponse}ms`);
// Fastest response: 12ms
```

### Filtered Aggregations

Filter before aggregating to compute KPIs for specific segments:

```typescript
const avgOk = await pageViews.avg('responseMs', { statusCode: 200 });
console.log(`Avg OK response: ${avgOk.toFixed(1)}ms`);
// Avg OK response: 63.0ms

const avgError = await pageViews.avg('responseMs', { statusCode: 500 });
console.log(`Avg 500 response: ${avgError.toFixed(1)}ms`);
// Avg 500 response: 1800.0ms

const errorCount = await pageViews.count({ statusCode: 500 });
const totalCount = await pageViews.count();
const errorRate = ((errorCount / totalCount) * 100).toFixed(1);
console.log(`Error rate: ${errorRate}%`);
// Error rate: 25.0%
```

### Per-Path Breakdown

Combine `where()` and aggregation for per-endpoint analysis:

```typescript
const apiViews = await pageViews.where({ path: '/api/orders' });
const apiAvg = await pageViews.avg('responseMs', { path: '/api/orders' });
const apiMax = await pageViews.max('responseMs', { path: '/api/orders' });
console.log(`/api/orders: ${apiViews.length} hits, avg ${apiAvg.toFixed(0)}ms, max ${apiMax}ms`);
// /api/orders: 2 hits, avg 1800ms, max 2100ms
```

## Reactive KPI Dashboard

Aggregations become powerful when wrapped in reactive queries. The dashboard recomputes automatically whenever data changes — no polling, no manual refresh.

### Define Dashboard Queries

```typescript
// Overall traffic KPIs
store.defineQuery('trafficKpi', async (ctx) => {
  const pv = ctx.bucket('pageViews');

  const total = await pv.count();
  const avgMs = await pv.avg('responseMs');
  const maxMs = await pv.max('responseMs');
  const minMs = await pv.min('responseMs');
  const errors = await pv.count({ statusCode: 500 });
  const errorRate = total > 0 ? (errors / total) * 100 : 0;

  return {
    totalViews: total,
    avgResponseMs: Math.round(avgMs),
    maxResponseMs: maxMs ?? 0,
    minResponseMs: minMs ?? 0,
    errorRate: Math.round(errorRate * 10) / 10,
  };
});

// Per-path performance breakdown
store.defineQuery('pathStats', async (ctx, params: { path: string }) => {
  const pv = ctx.bucket('pageViews');

  const hits = await pv.count({ path: params.path });
  const avgMs = await pv.avg('responseMs', { path: params.path });
  const maxMs = await pv.max('responseMs', { path: params.path });

  return {
    path: params.path,
    hits,
    avgResponseMs: Math.round(avgMs),
    maxResponseMs: maxMs ?? 0,
  };
});

// Recent errors from the bounded buffer
store.defineQuery('recentErrors', async (ctx) => {
  const el = ctx.bucket('errorLog');
  const errors = await el.all();

  return errors.map((e) => ({
    path: e.path,
    status: e.status,
    message: e.message,
  }));
});
```

Every query reads through `ctx.bucket()`, which registers bucket-level dependencies. Any insert, update, delete, TTL purge, or maxSize eviction on `pageViews` or `errorLog` triggers automatic re-evaluation.

### Subscribe to Live Updates

```typescript
const initialKpi = await store.runQuery<{
  totalViews: number;
  avgResponseMs: number;
  maxResponseMs: number;
  minResponseMs: number;
  errorRate: number;
}>('trafficKpi');

console.log('Initial KPI:', initialKpi);
// Initial KPI: { totalViews: 8, avgResponseMs: 491, maxResponseMs: 2100, minResponseMs: 12, errorRate: 25 }

const unsubKpi = await store.subscribe<{
  totalViews: number;
  avgResponseMs: number;
  maxResponseMs: number;
  minResponseMs: number;
  errorRate: number;
}>('trafficKpi', (kpi) => {
  console.log(`[KPI] views=${kpi.totalViews} avg=${kpi.avgResponseMs}ms err=${kpi.errorRate}%`);
});

const unsubPath = await store.subscribe<{
  path: string;
  hits: number;
  avgResponseMs: number;
  maxResponseMs: number;
}>('pathStats', { path: '/api/orders' }, (stats) => {
  console.log(`[/api/orders] hits=${stats.hits} avg=${stats.avgResponseMs}ms`);
});

const unsubErrors = await store.subscribe<
  { path: string; status: number; message: string }[]
>('recentErrors', (errors) => {
  console.log(`[Errors] ${errors.length} recent errors`);
});
```

### Trigger Dashboard Updates

Any new page view automatically pushes fresh KPIs to all subscribers:

```typescript
// Fast successful request — improves the average
await recordPageView({ path: '/', statusCode: 200, responseMs: 30 });
await store.settle();
// [KPI] views=9 avg=440ms err=22.2%

// Slow error — worsens both error rate and response times
await recordPageView({ path: '/api/orders', statusCode: 500, responseMs: 3000 });
await store.settle();
// [KPI] views=10 avg=696ms err=30%
// [/api/orders] hits=3 avg=2200ms
// [Errors] 4 recent errors
```

Each `recordPageView` call inserts into the `pageViews` bucket (and possibly `errorLog`). The reactive system detects the change, re-runs affected queries, compares results via deep equality, and fires callbacks only when values actually differ.

## TTL in Action

The TTL manager periodically purges expired records. When records expire, reactive queries re-evaluate and the dashboard adjusts automatically.

```typescript
// Simulate passage of time by manually setting _expiresAt on some records
const oldViews = await pageViews.where({ path: '/missing' });
for (const view of oldViews) {
  await pageViews.update(view.id as string, {
    _expiresAt: Date.now() - 1000,  // Already expired
  });
}

// Trigger manual purge (normally runs on the interval)
const purged = await store.purgeTtl();
console.log(`Purged ${purged} expired records`);
// Purged 1 expired records

await store.settle();
// [KPI] views=11 avg=... err=...
// Dashboard automatically reflects the reduced dataset
```

In production, the TTL manager runs on an interval (configured via `ttlCheckIntervalMs`). You never call `purgeTtl()` manually — expired records disappear and reactive queries adjust on their own.

## maxSize Eviction

The error log is capped at 50 entries. When a new error arrives and the bucket is full, the oldest error is evicted. This eviction triggers a reactive update:

```typescript
// Fill the error log to capacity
for (let i = 0; i < 48; i++) {
  await errorLog.insert({
    path: `/stress/${i}`,
    status: 500,
    message: `Stress test error ${i}`,
  });
}

const errorCount = await errorLog.count();
console.log(`Error log size: ${errorCount}`);
// Error log size: 50 (capped — oldest entries were evicted)

// The next insert evicts the oldest error
await errorLog.insert({
  path: '/overflow',
  status: 500,
  message: 'This evicts the oldest entry',
});

const afterInsert = await errorLog.count();
console.log(`Error log size after overflow: ${afterInsert}`);
// Error log size after overflow: 50 (still capped)

await store.settle();
// [Errors] 50 recent errors (content changed — oldest swapped for newest)
```

The bounded buffer pattern is ideal for dashboards that show "last N errors" — no cleanup jobs, no memory growth, no TTL tuning.

## Daily Summary Flush

Periodically snapshot the current aggregations into a permanent daily summary:

```typescript
async function flushDailySummary() {
  const today = new Date().toISOString().slice(0, 10);

  const totalViews = await pageViews.count();
  const totalErrors = await pageViews.count({ statusCode: 500 });
  const avgMs = await pageViews.avg('responseMs');
  const peakMs = await pageViews.max('responseMs');

  const existing = await dailySummaries.get(today);

  if (existing !== undefined) {
    await dailySummaries.update(today, {
      totalViews,
      totalErrors,
      avgResponseMs: Math.round(avgMs),
      peakResponseMs: peakMs ?? 0,
    });
  } else {
    await dailySummaries.insert({
      date: today,
      totalViews,
      totalErrors,
      avgResponseMs: Math.round(avgMs),
      peakResponseMs: peakMs ?? 0,
    });
  }

  return await dailySummaries.get(today);
}

const summary = await flushDailySummary();
console.log('Daily summary:', summary?.date, '- views:', summary?.totalViews);
```

Call `flushDailySummary()` on a timer (e.g., every 5 minutes) to maintain a historical record. The page views bucket handles short-term data with TTL; the daily summaries bucket stores the long-term aggregate.

## Complete Working Example

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({
    name: 'analytics-demo',
    ttlCheckIntervalMs: 5_000,
  });

  // --- Schema definitions ---

  await store.defineBucket('pageViews', {
    key: 'id',
    schema: {
      id:          { type: 'string', generated: 'cuid' },
      path:        { type: 'string', required: true },
      statusCode:  { type: 'number', required: true, min: 100, max: 599 },
      responseMs:  { type: 'number', required: true, min: 0 },
      userId:      { type: 'string', default: '' },
      referrer:    { type: 'string', default: '' },
      createdAt:   { type: 'date', generated: 'timestamp' },
    },
    indexes: ['path', 'statusCode', 'userId'],
    ttl: '1h',
  });

  await store.defineBucket('errorLog', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'cuid' },
      path:      { type: 'string', required: true },
      status:    { type: 'number', required: true, min: 400, max: 599 },
      message:   { type: 'string', required: true },
      createdAt: { type: 'date', generated: 'timestamp' },
    },
    indexes: ['status'],
    maxSize: 50,
  });

  await store.defineBucket('dailySummaries', {
    key: 'date',
    schema: {
      date:           { type: 'string', required: true, pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      totalViews:     { type: 'number', default: 0, min: 0 },
      totalErrors:    { type: 'number', default: 0, min: 0 },
      avgResponseMs:  { type: 'number', default: 0, min: 0 },
      peakResponseMs: { type: 'number', default: 0, min: 0 },
    },
  });

  const pageViewsBucket = store.bucket('pageViews');
  const errorLogBucket = store.bucket('errorLog');
  const dailySummariesBucket = store.bucket('dailySummaries');

  // --- Ingestion helper ---

  async function recordPageView(data: {
    path: string;
    statusCode: number;
    responseMs: number;
    userId?: string;
    referrer?: string;
  }) {
    const view = await pageViewsBucket.insert(data);

    if (data.statusCode >= 400) {
      await errorLogBucket.insert({
        path: data.path,
        status: data.statusCode,
        message: `HTTP ${data.statusCode} on ${data.path}`,
      });
    }

    return view;
  }

  // --- Reactive queries ---

  store.defineQuery('trafficKpi', async (ctx) => {
    const pv = ctx.bucket('pageViews');

    const total = await pv.count();
    const avgMs = await pv.avg('responseMs');
    const maxMs = await pv.max('responseMs');
    const minMs = await pv.min('responseMs');
    const errors = await pv.count({ statusCode: 500 });
    const errorRate = total > 0 ? (errors / total) * 100 : 0;

    return {
      totalViews: total,
      avgResponseMs: Math.round(avgMs),
      maxResponseMs: maxMs ?? 0,
      minResponseMs: minMs ?? 0,
      errorRate: Math.round(errorRate * 10) / 10,
    };
  });

  store.defineQuery('recentErrors', async (ctx) => {
    const el = ctx.bucket('errorLog');
    const errors = await el.all();
    return errors.map((e) => ({
      path: e.path,
      status: e.status,
      message: e.message,
    }));
  });

  // --- Seed data ---

  await recordPageView({ path: '/', statusCode: 200, responseMs: 45, userId: 'u1' });
  await recordPageView({ path: '/', statusCode: 200, responseMs: 52, userId: 'u2' });
  await recordPageView({ path: '/api/users', statusCode: 200, responseMs: 120 });
  await recordPageView({ path: '/api/orders', statusCode: 500, responseMs: 1500 });
  await recordPageView({ path: '/api/orders', statusCode: 500, responseMs: 2100 });
  await recordPageView({ path: '/dashboard', statusCode: 200, responseMs: 60 });
  await recordPageView({ path: '/missing', statusCode: 404, responseMs: 12 });
  await recordPageView({ path: '/', statusCode: 200, responseMs: 38, userId: 'u3' });

  // --- Read initial KPIs ---

  const kpi = await store.runQuery<{
    totalViews: number;
    avgResponseMs: number;
    maxResponseMs: number;
    minResponseMs: number;
    errorRate: number;
  }>('trafficKpi');

  console.log(`Views: ${kpi.totalViews}`);
  // Views: 8
  console.log(`Avg response: ${kpi.avgResponseMs}ms`);
  console.log(`Error rate: ${kpi.errorRate}%`);

  // --- Subscribe to live updates ---

  const unsubKpi = await store.subscribe<{
    totalViews: number;
    avgResponseMs: number;
    maxResponseMs: number;
    minResponseMs: number;
    errorRate: number;
  }>('trafficKpi', (k) => {
    console.log(`[KPI] views=${k.totalViews} avg=${k.avgResponseMs}ms err=${k.errorRate}%`);
  });

  const unsubErrors = await store.subscribe<
    { path: string; status: number; message: string }[]
  >('recentErrors', (errors) => {
    console.log(`[Errors] ${errors.length} recent`);
  });

  // --- New traffic arrives ---

  await recordPageView({ path: '/', statusCode: 200, responseMs: 30 });
  await store.settle();
  // [KPI] views=9 avg=...ms err=...%

  await recordPageView({ path: '/api/orders', statusCode: 500, responseMs: 3000 });
  await store.settle();
  // [KPI] views=10 avg=...ms err=...%
  // [Errors] 4 recent

  // --- Aggregation queries ---

  const avgOk = await pageViewsBucket.avg('responseMs', { statusCode: 200 });
  console.log(`\nAvg OK response: ${avgOk.toFixed(1)}ms`);

  const peakAll = await pageViewsBucket.max('responseMs');
  console.log(`Peak response: ${peakAll}ms`);

  const fastestAll = await pageViewsBucket.min('responseMs');
  console.log(`Fastest response: ${fastestAll}ms`);

  // --- Daily summary flush ---

  const today = new Date().toISOString().slice(0, 10);

  const totalViews = await pageViewsBucket.count();
  const totalErrors = await pageViewsBucket.count({ statusCode: 500 });
  const avgMs = await pageViewsBucket.avg('responseMs');
  const peakMs = await pageViewsBucket.max('responseMs');

  await dailySummariesBucket.insert({
    date: today,
    totalViews,
    totalErrors,
    avgResponseMs: Math.round(avgMs),
    peakResponseMs: peakMs ?? 0,
  });

  const summary = await dailySummariesBucket.get(today);
  console.log(`\nDaily summary (${today}): ${summary?.totalViews} views, ${summary?.totalErrors} errors`);

  // --- Error log maxSize demo ---

  const errorSize = await errorLogBucket.count();
  console.log(`\nError log size: ${errorSize}`);

  // --- Cleanup ---

  await unsubKpi();
  await unsubErrors();
  await store.stop();
}

main();
```

## Exercise

Build an "endpoint health monitor" that tracks per-endpoint latency percentiles. Given the following store:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('requests', {
  key: 'id',
  schema: {
    id:         { type: 'string', generated: 'cuid' },
    endpoint:   { type: 'string', required: true },
    responseMs: { type: 'number', required: true, min: 0 },
    success:    { type: 'boolean', default: true },
    createdAt:  { type: 'date', generated: 'timestamp' },
  },
  indexes: ['endpoint'],
  ttl: '30m',
  maxSize: 1000,
});

const requests = store.bucket('requests');

// Seed data
const endpoints = ['/api/users', '/api/orders', '/api/auth'];
for (const ep of endpoints) {
  for (let i = 0; i < 10; i++) {
    await requests.insert({
      endpoint: ep,
      responseMs: Math.floor(Math.random() * 500) + 10,
      success: Math.random() > 0.1,
    });
  }
}
```

Write the following:

1. A reactive query `'endpointHealth'` that takes `{ endpoint: string }` and returns `{ endpoint: string, hits: number, avgMs: number, maxMs: number, successRate: number }`. Use `count()`, `avg()`, and `max()` from the query context. Compute `successRate` by filtering `where({ endpoint, success: true })` against the total count.
2. A reactive query `'globalHealth'` (no parameters) that returns `{ totalRequests: number, avgMs: number, maxMs: number }` across all endpoints.
3. Subscribe to both queries. Insert a very slow failing request on `/api/orders` and verify both callbacks fire with updated values.

<details>
<summary>Solution</summary>

```typescript
// 1. Per-endpoint health query
store.defineQuery('endpointHealth', async (ctx, params: { endpoint: string }) => {
  const req = ctx.bucket('requests');

  const hits = await req.count({ endpoint: params.endpoint });
  const avgMs = await req.avg('responseMs', { endpoint: params.endpoint });
  const maxMs = await req.max('responseMs', { endpoint: params.endpoint });
  const successCount = (await req.where({ endpoint: params.endpoint, success: true })).length;
  const successRate = hits > 0 ? Math.round((successCount / hits) * 100) : 0;

  return {
    endpoint: params.endpoint,
    hits,
    avgMs: Math.round(avgMs),
    maxMs: maxMs ?? 0,
    successRate,
  };
});

// 2. Global health query
store.defineQuery('globalHealth', async (ctx) => {
  const req = ctx.bucket('requests');

  const totalRequests = await req.count();
  const avgMs = await req.avg('responseMs');
  const maxMs = await req.max('responseMs');

  return {
    totalRequests,
    avgMs: Math.round(avgMs),
    maxMs: maxMs ?? 0,
  };
});

// 3. Subscribe and test
const initialEndpoint = await store.runQuery<{
  endpoint: string; hits: number; avgMs: number; maxMs: number; successRate: number;
}>('endpointHealth', { endpoint: '/api/orders' });

console.log('Before:', initialEndpoint);
// Before: { endpoint: '/api/orders', hits: 10, avgMs: ..., maxMs: ..., successRate: ... }

const initialGlobal = await store.runQuery<{
  totalRequests: number; avgMs: number; maxMs: number;
}>('globalHealth');

console.log('Global before:', initialGlobal);
// Global before: { totalRequests: 30, avgMs: ..., maxMs: ... }

const unsubEndpoint = await store.subscribe<{
  endpoint: string; hits: number; avgMs: number; maxMs: number; successRate: number;
}>('endpointHealth', { endpoint: '/api/orders' }, (health) => {
  console.log('Endpoint update:', health);
});

const unsubGlobal = await store.subscribe<{
  totalRequests: number; avgMs: number; maxMs: number;
}>('globalHealth', (health) => {
  console.log('Global update:', health);
});

// Insert a slow failing request
await requests.insert({
  endpoint: '/api/orders',
  responseMs: 5000,
  success: false,
});

await store.settle();
// Endpoint update: { endpoint: '/api/orders', hits: 11, avgMs: ..., maxMs: 5000, successRate: ... }
// Global update: { totalRequests: 31, avgMs: ..., maxMs: 5000 }

await unsubEndpoint();
await unsubGlobal();
await store.stop();
```

</details>

## Summary

- **`ttl: '1h'`** on page views creates a self-cleaning sliding window — only the last hour of data exists, no manual purge needed
- **`maxSize: 50`** on the error log creates a bounded buffer — newest errors push out oldest, zero memory growth
- **`sum()`, `avg()`, `min()`, `max()`** compute KPIs directly on bucket data with optional equality filters
- **Reactive queries** wrapping aggregations create a live dashboard — every insert, delete, TTL purge, or eviction triggers automatic re-evaluation
- **`store.settle()`** ensures all reactive callbacks have fired before reading results — essential for deterministic output
- **Deep equality comparison** prevents unnecessary callback invocations — if the aggregated result hasn't changed, the subscriber is not notified
- **Daily summary flush** combines short-term TTL data with permanent historical records — the sliding window handles recency, summaries handle history
- **No transactions** for independent writes (page view + error log) — transactions are only necessary when consistency between buckets matters
- **Schema-level validation** (`min`, `max`, `pattern`, `enum`) catches bad data at the boundary, before it corrupts aggregations

---

Next: [Inventory with Rules](./03-inventory-with-rules.md)
