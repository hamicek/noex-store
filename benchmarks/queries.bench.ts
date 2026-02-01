import { Store } from '../src/index.js';

const SEED_COUNT = 1_000;
const QUERY_ITERATIONS = 1_000;

function report(label: string, ops: number, ms: number): void {
  const opsPerSec = Math.round((ops / ms) * 1_000);
  const avgUs = ((ms / ops) * 1_000).toFixed(2);
  console.log(
    `  ${label.padEnd(24)} ${opsPerSec.toLocaleString().padStart(10)} ops/sec   ${avgUs.padStart(8)} \u00b5s/op   (${ms.toFixed(1)}ms total)`,
  );
}

async function bench(
  label: string,
  iterations: number,
  fn: () => Promise<unknown>,
): Promise<void> {
  // Warmup: 10 iterations to stabilise JIT
  for (let i = 0; i < 10; i++) {
    await fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  const ms = performance.now() - start;
  report(label, iterations, ms);
}

async function main(): Promise<void> {
  console.log(
    `\n\u2550\u2550\u2550 Query Benchmark (${SEED_COUNT.toLocaleString()} records, ${QUERY_ITERATIONS.toLocaleString()} iterations each) \u2550\u2550\u2550\n`,
  );

  const store = await Store.start({ name: 'bench-queries', ttlCheckIntervalMs: 0 });

  await store.defineBucket('customers', {
    key: 'id',
    schema: {
      id:   { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
      tier: { type: 'string', default: 'basic' },
      age:  { type: 'number', default: 25 },
    },
    indexes: ['tier'],
  });

  const bucket = store.bucket('customers');

  // Seed data
  const tiers = ['vip', 'silver', 'basic'] as const;
  const insertedIds: string[] = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    const record = await bucket.insert({
      name: `customer-${i}`,
      tier: tiers[i % 3],
      age: 20 + (i % 50),
    });
    insertedIds.push(record.id as string);
  }

  // Pick a known key for get() bench
  const sampleKey = insertedIds[Math.floor(insertedIds.length / 2)]!;

  // ── Indexed queries ────────────────────────────────────────────
  await bench('where (indexed)',      QUERY_ITERATIONS, () => bucket.where({ tier: 'vip' }));
  await bench('findOne (indexed)',    QUERY_ITERATIONS, () => bucket.findOne({ tier: 'vip' }));
  await bench('count (indexed)',      QUERY_ITERATIONS, () => bucket.count({ tier: 'silver' }));

  // ── Non-indexed queries ────────────────────────────────────────
  await bench('where (no index)',     QUERY_ITERATIONS, () => bucket.where({ age: 30 }));
  await bench('findOne (no index)',   QUERY_ITERATIONS, () => bucket.findOne({ age: 30 }));
  await bench('count (no index)',     QUERY_ITERATIONS, () => bucket.count({ age: 30 }));

  // ── Full-scan operations ───────────────────────────────────────
  await bench('all()',                QUERY_ITERATIONS, () => bucket.all());
  await bench('get (by key)',         QUERY_ITERATIONS, () => bucket.get(sampleKey));
  await bench('first(10)',            QUERY_ITERATIONS, () => bucket.first(10));
  await bench('last(10)',             QUERY_ITERATIONS, () => bucket.last(10));
  await bench('count (all)',          QUERY_ITERATIONS, () => bucket.count());

  // ── Aggregations ───────────────────────────────────────────────
  await bench('sum (age)',            QUERY_ITERATIONS, () => bucket.sum('age'));
  await bench('avg (age)',            QUERY_ITERATIONS, () => bucket.avg('age'));
  await bench('min (age)',            QUERY_ITERATIONS, () => bucket.min('age'));
  await bench('max (age)',            QUERY_ITERATIONS, () => bucket.max('age'));

  await store.stop();
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
