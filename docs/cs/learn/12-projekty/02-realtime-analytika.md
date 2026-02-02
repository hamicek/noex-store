# Real-Time analytika

Naučili jste se agregační metody, TTL expiraci, buckety s omezenou velikostí a reaktivní dotazy jako samostatné funkce. Nyní je všechny zkombinujete do jedné aplikace — real-time analytický dashboard, který sleduje zobrazení stránek, průběžně počítá KPI, automaticky odstraňuje zastaralá data a odesílá živé aktualizace odběratelům bez pollingu.

Na konci budete mít spustitelný projekt, který využívá agregace, TTL, maxSize a reaktivní dotazy v realistickém monitorovacím scénáři.

## Co se naučíte

- Jak modelovat časově řazená data událostí pomocí bucketů s TTL
- Jak využít `maxSize` k vytvoření ohraničených bufferů, které automaticky odstraňují nejstarší záznamy
- Jak počítat KPI pomocí `sum`, `avg`, `min` a `max` uvnitř reaktivních dotazů
- Jak vytvořit živý dashboard, který se automaticky aktualizuje při každé změně dat
- Jak kombinovat TTL expiraci a evikci s reaktivním přepočítáváním
- Jak strukturovat analytický pipeline od příjmu dat až po real-time zobrazení

## Návrh schémat

Analytický systém potřebuje tři buckety: surové události zobrazení stránek s automatickou expirací, ohraničený buffer posledních chyb pro rychlou kontrolu a trvalé záznamy denních souhrnů pro historický reporting.

### Zobrazení stránek

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

Klíčová rozhodnutí:

- **`ttl: '1h'`** znamená, že každé zobrazení stránky automaticky vyprší po jedné hodině. Dashboard zobrazuje pouze data za poslední hodinu — žádné ruční čištění není potřeba.
- **`responseMs`** je doba HTTP odpovědi v milisekundách. Toto pole slouží jako základ pro agregace `avg`, `min` a `max`.
- **Index na `statusCode`** umožňuje rychlé filtrování podle HTTP statusu (200, 404, 500 atd.).
- **Index na `path`** podporuje analýzu po jednotlivých stránkách bez nutnosti procházet všechny záznamy.
- **`min: 0`** na `responseMs` zabraňuje záporným časům odpovědi na úrovni Schema.

### Log chyb

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

Klíčová rozhodnutí:

- **`maxSize: 50`** uchovává pouze 50 nejnovějších chyb. Nejstarší záznamy se automaticky odstraní, když přijde 51. chyba — ohraničený buffer s nulovou údržbou.
- **`min: 400`** zajišťuje, že do tohoto bucketu vstupují pouze odpovědi 4xx/5xx.
- Žádné TTL — samotný limit velikosti řídí spotřebu paměti.

### Denní souhrny

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

Klíčová rozhodnutí:

- **`date` jako přirozený klíč** (např. `"2025-01-15"`) — jeden záznam za den, upsertovaný při každém flushu.
- **`pattern`** vynucuje ISO formát data na úrovni Schema.
- Žádné TTL ani maxSize — souhrny jsou trvalé historické záznamy.

### Tok dat

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

## Bucket Handle

Po definici všech bucketů si získejte handle:

```typescript
const pageViews = store.bucket('pageViews');
const errorLog = store.bucket('errorLog');
const dailySummaries = store.bucket('dailySummaries');
```

## Příjem dat

Každá HTTP odpověď napájí analytický pipeline. Pokud je odpověď chybová, záznam se zapíše do obou bucketů:

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

Transakce zde není potřeba — zobrazení stránky a jeho záznam v logu chyb jsou na sobě nezávislé. Pokud insert chyby selže (např. kvůli validaci), zobrazení stránky zůstane uloženo.

## Naplnění daty

Naplňte Store ukázkovým provozem, se kterým budete pracovat:

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

Osm zobrazení stránek: pět úspěšných, tři chybových. Log chyb obsahuje tři záznamy (dva 500 a jeden 404).

## Agregační dotazy

Agregační metody — `sum`, `avg`, `min`, `max` — přeměňují surové události na KPI. Každá z nich přijímá volitelný filtr pro zúžení výpočtu.

### Základní agregace

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

### Filtrované agregace

Filtrujte před agregací a počítejte KPI pro konkrétní segmenty:

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

### Analýza podle cesty

Zkombinujte `where()` a agregaci pro analýzu jednotlivých endpointů:

```typescript
const apiViews = await pageViews.where({ path: '/api/orders' });
const apiAvg = await pageViews.avg('responseMs', { path: '/api/orders' });
const apiMax = await pageViews.max('responseMs', { path: '/api/orders' });
console.log(`/api/orders: ${apiViews.length} hits, avg ${apiAvg.toFixed(0)}ms, max ${apiMax}ms`);
// /api/orders: 2 hits, avg 1800ms, max 2100ms
```

## Reaktivní KPI dashboard

Agregace se stávají skutečně silným nástrojem, když je zabalíte do reaktivních dotazů. Dashboard se automaticky přepočítává při každé změně dat — žádný polling, žádné ruční obnovování.

### Definice dotazů pro dashboard

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

Každý dotaz čte přes `ctx.bucket()`, čímž registruje závislosti na úrovni bucketu. Jakýkoli insert, update, delete, TTL purge nebo maxSize evikce na `pageViews` nebo `errorLog` spustí automatické přepočítání.

### Odběr živých aktualizací

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

### Spuštění aktualizací dashboardu

Jakékoli nové zobrazení stránky automaticky odešle čerstvé KPI všem odběratelům:

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

Každé volání `recordPageView` vloží záznam do bucketu `pageViews` (a případně do `errorLog`). Reaktivní systém detekuje změnu, znovu spustí dotčené dotazy, porovná výsledky pomocí hluboké rovnosti a zavolá callbacky pouze tehdy, když se hodnoty skutečně liší.

## TTL v akci

TTL manager periodicky odstraňuje prošlé záznamy. Když záznamy vyprší, reaktivní dotazy se přepočítají a dashboard se automaticky přizpůsobí.

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

V produkci TTL manager běží na intervalu (nakonfigurovaném přes `ttlCheckIntervalMs`). `purgeTtl()` ručně nikdy nevoláte — prošlé záznamy zmizí samy a reaktivní dotazy se přizpůsobí automaticky.

## maxSize evikce

Log chyb je omezen na 50 záznamů. Když přijde nová chyba a bucket je plný, nejstarší chyba se odstraní. Tato evikce spustí reaktivní aktualizaci:

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

Vzor ohraničeného bufferu je ideální pro dashboardy zobrazující "posledních N chyb" — žádné úklidové úlohy, žádný nárůst paměti, žádné ladění TTL.

## Flush denního souhrnu

Periodicky uložte aktuální agregace do trvalého denního souhrnu:

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

Volejte `flushDailySummary()` na časovači (např. každých 5 minut) pro udržování historického záznamu. Bucket zobrazení stránek spravuje krátkodobá data pomocí TTL; bucket denních souhrnů uchovává dlouhodobé agregáty.

## Kompletní funkční příklad

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

## Cvičení

Vytvořte "monitor zdraví endpointů", který sleduje percentily latence jednotlivých endpointů. Máte k dispozici následující Store:

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

Napište následující:

1. Reaktivní dotaz `'endpointHealth'`, který přijímá `{ endpoint: string }` a vrací `{ endpoint: string, hits: number, avgMs: number, maxMs: number, successRate: number }`. Použijte `count()`, `avg()` a `max()` z kontextu dotazu. `successRate` spočítejte filtrováním `where({ endpoint, success: true })` vůči celkovému počtu.
2. Reaktivní dotaz `'globalHealth'` (bez parametrů), který vrací `{ totalRequests: number, avgMs: number, maxMs: number }` napříč všemi endpointy.
3. Přihlaste se k odběru obou dotazů. Vložte velmi pomalý neúspěšný požadavek na `/api/orders` a ověřte, že se oba callbacky spustí s aktualizovanými hodnotami.

<details>
<summary>Řešení</summary>

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

## Shrnutí

- **`ttl: '1h'`** na zobrazení stránek vytváří samovolně se čistící posuvné okno — existují pouze data za poslední hodinu, žádné ruční mazání není potřeba
- **`maxSize: 50`** na logu chyb vytváří ohraničený buffer — nejnovější chyby vytlačují nejstarší, nulový nárůst paměti
- **`sum()`, `avg()`, `min()`, `max()`** počítají KPI přímo nad daty bucketu s volitelnými filtry rovnosti
- **Reaktivní dotazy** obalující agregace vytvářejí živý dashboard — každý insert, delete, TTL purge nebo evikce spustí automatické přepočítání
- **`store.settle()`** zajišťuje, že všechny reaktivní callbacky proběhly, než začnete číst výsledky — nezbytné pro deterministický výstup
- **Porovnání hlubokou rovností** zabraňuje zbytečným voláním callbacků — pokud se agregovaný výsledek nezměnil, odběratel není notifikován
- **Flush denního souhrnu** kombinuje krátkodobá TTL data s trvalými historickými záznamy — posuvné okno zajišťuje aktuálnost, souhrny zajišťují historii
- **Žádné transakce** pro nezávislé zápisy (zobrazení stránky + log chyb) — transakce jsou nutné pouze tehdy, když záleží na konzistenci mezi buckety
- **Validace na úrovni Schema** (`min`, `max`, `pattern`, `enum`) zachytí špatná data na vstupu, dříve než poškodí agregace

---

Další: [Inventář s pravidly](./03-inventar-s-pravidly.md)
