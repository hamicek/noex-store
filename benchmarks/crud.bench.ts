import { Store } from '../src/index.js';

const ITERATIONS = 10_000;

function report(label: string, ops: number, ms: number): void {
  const opsPerSec = Math.round((ops / ms) * 1_000);
  const avgUs = ((ms / ops) * 1_000).toFixed(2);
  console.log(
    `  ${label.padEnd(12)} ${opsPerSec.toLocaleString().padStart(10)} ops/sec   ${avgUs.padStart(8)} \u00b5s/op   (${ms.toFixed(1)}ms total)`,
  );
}

async function main(): Promise<void> {
  console.log(`\n\u2550\u2550\u2550 CRUD Benchmark (${ITERATIONS.toLocaleString()} ops each) \u2550\u2550\u2550\n`);

  const store = await Store.start({ name: 'bench-crud', ttlCheckIntervalMs: 0 });

  await store.defineBucket('items', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      value: { type: 'number', default: 0 },
    },
  });

  const bucket = store.bucket('items');

  // ── INSERT ──────────────────────────────────────────────────────
  const ids: string[] = [];
  const insertStart = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const record = await bucket.insert({ name: `item-${i}`, value: i });
    ids.push(record.id as string);
  }
  const insertMs = performance.now() - insertStart;
  report('Insert', ITERATIONS, insertMs);

  // ── GET (by key) ───────────────────────────────────────────────
  const getStart = performance.now();
  for (const id of ids) {
    await bucket.get(id);
  }
  const getMs = performance.now() - getStart;
  report('Get', ITERATIONS, getMs);

  // ── UPDATE ─────────────────────────────────────────────────────
  const updateStart = performance.now();
  for (const id of ids) {
    await bucket.update(id, { value: 999 });
  }
  const updateMs = performance.now() - updateStart;
  report('Update', ITERATIONS, updateMs);

  // ── DELETE ─────────────────────────────────────────────────────
  const deleteStart = performance.now();
  for (const id of ids) {
    await bucket.delete(id);
  }
  const deleteMs = performance.now() - deleteStart;
  report('Delete', ITERATIONS, deleteMs);

  await store.stop();
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
