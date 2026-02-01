import { Store } from '../src/index.js';

const ITERATIONS = 500;

function report(label: string, ops: number, ms: number): void {
  const opsPerSec = Math.round((ops / ms) * 1_000);
  const avgUs = ((ms / ops) * 1_000).toFixed(2);
  console.log(
    `  ${label.padEnd(36)} ${opsPerSec.toLocaleString().padStart(10)} ops/sec   ${avgUs.padStart(8)} \u00b5s/op   (${ms.toFixed(1)}ms total)`,
  );
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function reportLatency(label: string, latencies: number[]): void {
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  console.log(
    `  ${label.padEnd(36)}   avg ${avg.toFixed(1)}\u00b5s   p50 ${percentile(sorted, 50).toFixed(1)}\u00b5s   p95 ${percentile(sorted, 95).toFixed(1)}\u00b5s   p99 ${percentile(sorted, 99).toFixed(1)}\u00b5s`,
  );
}

async function benchInsertLatency(): Promise<void> {
  console.log('  -- Insert-to-callback latency --');

  const store = await Store.start({ name: 'bench-reactive-latency', ttlCheckIntervalMs: 0 });

  await store.defineBucket('items', {
    key: 'id',
    schema: {
      id:   { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
    },
  });

  store.defineQuery('all-items', async (ctx) => {
    const items = ctx.bucket('items');
    return items.all();
  });

  const latencies: number[] = [];
  let callbackTs = 0;

  await store.subscribe('all-items', () => {
    callbackTs = performance.now();
  });

  // Warmup: let the initial subscription callback fire
  await store.settle();

  for (let i = 0; i < ITERATIONS; i++) {
    callbackTs = 0;
    const before = performance.now();
    await store.bucket('items').insert({ name: `item-${i}` });
    await store.settle();
    if (callbackTs > 0) {
      latencies.push((callbackTs - before) * 1_000); // convert ms → µs
    }
  }

  reportLatency('insert \u2192 subscriber', latencies);

  await store.stop();
}

async function benchSubscriptionOverhead(): Promise<void> {
  console.log('\n  -- Subscription overhead (insert throughput) --');

  // Baseline: no subscriptions
  {
    const store = await Store.start({ name: 'bench-reactive-baseline', ttlCheckIntervalMs: 0 });
    await store.defineBucket('items', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    const bucket = store.bucket('items');
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await bucket.insert({ name: `item-${i}` });
    }
    const ms = performance.now() - start;
    report('insert (0 subscriptions)', ITERATIONS, ms);

    await store.stop();
  }

  // With 1 subscription
  {
    const store = await Store.start({ name: 'bench-reactive-1sub', ttlCheckIntervalMs: 0 });
    await store.defineBucket('items', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    store.defineQuery('q1', async (ctx) => ctx.bucket('items').all());
    await store.subscribe('q1', () => {});
    await store.settle();

    const bucket = store.bucket('items');
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await bucket.insert({ name: `item-${i}` });
      await store.settle();
    }
    const ms = performance.now() - start;
    report('insert + settle (1 subscription)', ITERATIONS, ms);

    await store.stop();
  }

  // With 10 subscriptions
  {
    const store = await Store.start({ name: 'bench-reactive-10sub', ttlCheckIntervalMs: 0 });
    await store.defineBucket('items', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    for (let q = 0; q < 10; q++) {
      store.defineQuery(`q${q}`, async (ctx) => ctx.bucket('items').all());
      await store.subscribe(`q${q}`, () => {});
    }
    await store.settle();

    const bucket = store.bucket('items');
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await bucket.insert({ name: `item-${i}` });
      await store.settle();
    }
    const ms = performance.now() - start;
    report('insert + settle (10 subscriptions)', ITERATIONS, ms);

    await store.stop();
  }
}

async function main(): Promise<void> {
  console.log(`\n\u2550\u2550\u2550 Reactive Benchmark (${ITERATIONS} ops) \u2550\u2550\u2550\n`);

  await benchInsertLatency();
  await benchSubscriptionOverhead();

  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
