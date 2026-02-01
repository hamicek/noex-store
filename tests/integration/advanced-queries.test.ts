import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store } from '../../src/core/store.js';
import type { BucketDefinition, StoreRecord, PaginatedResult } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
    score: { type: 'number', default: 0 },
    tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
  },
  indexes: ['tier'],
  etsType: 'ordered_set',
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    customerId: { type: 'number', required: true },
    amount: { type: 'number', required: true },
  },
  indexes: ['customerId'],
};

// ── Helpers ──────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

async function createStore(): Promise<Store> {
  store = await Store.start();
  await store.defineBucket('customers', customersDef);
  await store.defineBucket('orders', ordersDef);
  return store;
}

async function seedCustomers(s: Store, count: number): Promise<StoreRecord[]> {
  const records: StoreRecord[] = [];
  for (let i = 0; i < count; i++) {
    const record = await s.bucket('customers').insert({
      name: `User ${i}`,
      score: i * 10,
      tier: i % 2 === 0 ? 'vip' : 'basic',
    });
    records.push(record);
  }
  return records;
}

// ── Pagination ───────────────────────────────────────────────────

describe('advanced queries: pagination', () => {
  it('cursor-based traversal iterates all records in pages', async () => {
    const s = await createStore();
    await seedCustomers(s, 10);

    const allRecords: StoreRecord[] = [];
    let cursor: unknown | undefined;
    let pageCount = 0;

    // Walk through all pages with limit=3
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page: PaginatedResult = cursor === undefined
        ? await s.bucket('customers').paginate({ limit: 3 })
        : await s.bucket('customers').paginate({ after: cursor, limit: 3 });

      allRecords.push(...page.records);
      pageCount++;

      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }

    // 10 records / 3 per page = 4 pages (3+3+3+1)
    expect(pageCount).toBe(4);
    expect(allRecords).toHaveLength(10);

    // Verify records are in key order (ordered_set with autoincrement)
    for (let i = 0; i < allRecords.length; i++) {
      expect(allRecords[i]!.id).toBe(i + 1);
    }
  });

  it('ordered_set returns records sorted by key', async () => {
    const s = await createStore();
    await seedCustomers(s, 5);

    const page = await s.bucket('customers').paginate({ limit: 10 });

    expect(page.records).toHaveLength(5);
    expect(page.hasMore).toBe(false);

    // Autoincrement keys in ordered_set: 1, 2, 3, 4, 5
    const ids = page.records.map((r) => r.id);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it('paginate and where are independent operations on the same bucket', async () => {
    const s = await createStore();
    await seedCustomers(s, 6);

    const [page, vips] = await Promise.all([
      s.bucket('customers').paginate({ limit: 3 }),
      s.bucket('customers').where({ tier: 'vip' }),
    ]);

    expect(page.records).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    // VIPs: indices 0, 2, 4 → ids 1, 3, 5
    expect(vips).toHaveLength(3);
  });

  it('first(n) returns first n records in key order', async () => {
    const s = await createStore();
    await seedCustomers(s, 5);

    const first3 = await s.bucket('customers').first(3);

    expect(first3).toHaveLength(3);
    expect(first3[0]!.id).toBe(1);
    expect(first3[2]!.id).toBe(3);
  });

  it('last(n) returns last n records in key order', async () => {
    const s = await createStore();
    await seedCustomers(s, 5);

    const last2 = await s.bucket('customers').last(2);

    expect(last2).toHaveLength(2);
    expect(last2[0]!.id).toBe(4);
    expect(last2[1]!.id).toBe(5);
  });

  it('paginate returns empty result for empty bucket', async () => {
    const s = await createStore();

    const page = await s.bucket('customers').paginate({ limit: 10 });

    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it('paginate with cursor past the end returns empty result', async () => {
    const s = await createStore();
    await seedCustomers(s, 3);

    // Cursor at last record
    const page = await s.bucket('customers').paginate({ after: 3, limit: 10 });

    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('paginate with non-existent cursor returns empty result', async () => {
    const s = await createStore();
    await seedCustomers(s, 3);

    const page = await s.bucket('customers').paginate({ after: 999, limit: 10 });

    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

// ── Aggregations ─────────────────────────────────────────────────

describe('advanced queries: aggregations', () => {
  it('sum/avg/min/max return correct results end-to-end', async () => {
    const s = await createStore();
    // Scores: 0, 10, 20, 30, 40, 50, 60, 70, 80, 90
    await seedCustomers(s, 10);

    const total = await s.bucket('customers').sum('score');
    const average = await s.bucket('customers').avg('score');
    const minimum = await s.bucket('customers').min('score');
    const maximum = await s.bucket('customers').max('score');

    expect(total).toBe(450);     // 0+10+20+...+90
    expect(average).toBe(45);    // 450/10
    expect(minimum).toBe(0);
    expect(maximum).toBe(90);
  });

  it('aggregations respect filter parameter', async () => {
    const s = await createStore();
    // VIP (even indices): scores 0, 20, 40, 60, 80 → sum=200, avg=40
    // Basic (odd indices): scores 10, 30, 50, 70, 90 → sum=250, avg=50
    await seedCustomers(s, 10);

    const vipSum = await s.bucket('customers').sum('score', { tier: 'vip' });
    const vipAvg = await s.bucket('customers').avg('score', { tier: 'vip' });
    const basicMin = await s.bucket('customers').min('score', { tier: 'basic' });
    const basicMax = await s.bucket('customers').max('score', { tier: 'basic' });

    expect(vipSum).toBe(200);
    expect(vipAvg).toBe(40);
    expect(basicMin).toBe(10);
    expect(basicMax).toBe(90);
  });

  it('aggregations on empty bucket return identity values', async () => {
    const s = await createStore();

    const total = await s.bucket('customers').sum('score');
    const average = await s.bucket('customers').avg('score');
    const minimum = await s.bucket('customers').min('score');
    const maximum = await s.bucket('customers').max('score');

    expect(total).toBe(0);
    expect(average).toBe(0);
    expect(minimum).toBeUndefined();
    expect(maximum).toBeUndefined();
  });
});

// ── Record-level reactivity ──────────────────────────────────────

describe('advanced queries: record-level reactivity', () => {
  it('get-based query skips callback for irrelevant record changes', async () => {
    const s = await createStore();

    const c1 = await s.bucket('customers').insert({ name: 'Alice', score: 10 });
    await s.bucket('customers').insert({ name: 'Bob', score: 20 });

    s.defineQuery('oneCustomer', async (ctx, params: { id: number }) =>
      ctx.bucket('customers').get(params.id),
    );

    const callback = vi.fn();
    await s.subscribe('oneCustomer', { id: c1.id as number }, callback);

    // Insert a new record — should NOT trigger callback (record-level dep)
    await s.bucket('customers').insert({ name: 'Charlie', score: 30 });
    await s.settle();
    expect(callback).not.toHaveBeenCalled();

    // Update a different record — should NOT trigger callback
    await s.bucket('customers').update(2, { score: 999 });
    await s.settle();
    expect(callback).not.toHaveBeenCalled();
  });

  it('get-based query fires callback for relevant record change', async () => {
    const s = await createStore();

    const c1 = await s.bucket('customers').insert({ name: 'Alice', score: 10 });
    await s.bucket('customers').insert({ name: 'Bob', score: 20 });

    s.defineQuery('oneCustomer', async (ctx, params: { id: number }) =>
      ctx.bucket('customers').get(params.id),
    );

    const callback = vi.fn();
    await s.subscribe('oneCustomer', { id: c1.id as number }, callback);

    // Update the tracked record — SHOULD trigger callback
    await s.bucket('customers').update(c1.id, { score: 555 });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as StoreRecord;
    expect(result.score).toBe(555);
  });

  it('where-based query always re-evaluates on any bucket change', async () => {
    const s = await createStore();

    s.defineQuery('allCustomers', async (ctx) =>
      ctx.bucket('customers').all(),
    );

    const callback = vi.fn();
    await s.subscribe('allCustomers', callback);

    // Any insert triggers re-evaluation (bucket-level dep)
    await s.bucket('customers').insert({ name: 'Alice' });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(1);

    await s.bucket('customers').insert({ name: 'Bob' });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(2);

    // Update also triggers re-evaluation
    await s.bucket('customers').update(1, { name: 'Alice Updated' });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(3);

    // Delete triggers re-evaluation
    await s.bucket('customers').delete(1);
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it('mixed deps: get from bucket A + where from bucket B', async () => {
    const s = await createStore();

    const c1 = await s.bucket('customers').insert({ name: 'Alice', score: 10 });

    s.defineQuery(
      'customerOrders',
      async (ctx, params: { customerId: number }) => {
        const customer = await ctx.bucket('customers').get(params.customerId);
        const orders = await ctx.bucket('orders').where({
          customerId: params.customerId,
        });
        return { customer, orders };
      },
    );

    const callback = vi.fn();
    await s.subscribe('customerOrders', { customerId: c1.id as number }, callback);

    // Change in orders (bucket-level dep) — always re-evaluates
    await s.bucket('orders').insert({ customerId: c1.id as number, amount: 100 });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(1);

    // Change in customers for a DIFFERENT key — should NOT trigger (record-level)
    await s.bucket('customers').insert({ name: 'Bob', score: 20 });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(1);

    // Change in customers for the TRACKED key — should trigger (record-level match)
    await s.bucket('customers').update(c1.id, { name: 'Alice Updated' });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('verification from main plan: get(id) skips unrelated changes', async () => {
    const s = await createStore();

    const c1 = await s.bucket('customers').insert({ name: 'Alice', score: 10 });
    const c2 = await s.bucket('customers').insert({ name: 'Bob', score: 20 });

    s.defineQuery('single', async (ctx, params: { id: number }) =>
      ctx.bucket('customers').get(params.id),
    );

    const calls: unknown[] = [];
    await s.subscribe('single', { id: c1.id as number }, (r) => {
      calls.push(r);
    });

    // Change another record
    await s.bucket('customers').update(c2.id, { score: 999 });
    await s.settle();
    expect(calls).toHaveLength(0); // Not affected

    // Change the tracked record
    await s.bucket('customers').update(c1.id, { score: 100 });
    await s.settle();
    expect(calls).toHaveLength(1);
    expect((calls[0] as StoreRecord).score).toBe(100);
  });
});

// ── Pagination in reactive queries ───────────────────────────────

describe('advanced queries: pagination in reactive queries', () => {
  it('first(n) in reactive query re-evaluates on bucket changes', async () => {
    const s = await createStore();

    s.defineQuery('top3', async (ctx) =>
      ctx.bucket('customers').first(3),
    );

    const callback = vi.fn();
    await s.subscribe('top3', callback);

    // Insert first customer — query returns [customer1]
    await s.bucket('customers').insert({ name: 'Alice', score: 10 });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toHaveLength(1);

    // Insert second — query returns [c1, c2]
    await s.bucket('customers').insert({ name: 'Bob', score: 20 });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1]![0]).toHaveLength(2);

    // Insert third — query returns [c1, c2, c3]
    await s.bucket('customers').insert({ name: 'Charlie', score: 30 });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback.mock.calls[2]![0]).toHaveLength(3);

    // Insert fourth — first(3) still returns 3, but re-evaluates.
    // If result is structurally equal (same 3 records), no callback.
    // Since first(3) returns records 1,2,3 which haven't changed, no callback.
    await s.bucket('customers').insert({ name: 'Dave', score: 40 });
    await s.settle();
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('paginate in reactive query uses bucket-level deps', async () => {
    const s = await createStore();

    s.defineQuery('page1', async (ctx) =>
      ctx.bucket('customers').paginate({ limit: 2 }),
    );

    const callback = vi.fn();
    await s.subscribe('page1', callback);

    await s.bucket('customers').insert({ name: 'Alice', score: 10 });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as PaginatedResult;
    expect(result.records).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });
});

// ── Aggregations in reactive queries ─────────────────────────────

describe('advanced queries: aggregations in reactive queries', () => {
  it('sum in reactive query re-evaluates after insert', async () => {
    const s = await createStore();

    s.defineQuery('totalScore', async (ctx) =>
      ctx.bucket('customers').sum('score'),
    );

    const callback = vi.fn();
    await s.subscribe('totalScore', callback);

    await s.bucket('customers').insert({ name: 'Alice', score: 100 });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toBe(100);

    await s.bucket('customers').insert({ name: 'Bob', score: 200 });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1]![0]).toBe(300);
  });

  it('avg in reactive query updates after mutations', async () => {
    const s = await createStore();

    await s.bucket('customers').insert({ name: 'Alice', score: 100 });
    await s.bucket('customers').insert({ name: 'Bob', score: 200 });

    s.defineQuery('avgScore', async (ctx) =>
      ctx.bucket('customers').avg('score'),
    );

    const callback = vi.fn();
    await s.subscribe('avgScore', callback);

    // Update Bob's score — average changes from 150 to 200
    await s.bucket('customers').update(2, { score: 300 });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toBe(200); // (100 + 300) / 2
  });

  it('min/max in reactive query respond to changes', async () => {
    const s = await createStore();

    await s.bucket('customers').insert({ name: 'Alice', score: 50 });
    await s.bucket('customers').insert({ name: 'Bob', score: 100 });

    s.defineQuery('scoreRange', async (ctx) => ({
      min: await ctx.bucket('customers').min('score'),
      max: await ctx.bucket('customers').max('score'),
    }));

    const callback = vi.fn();
    await s.subscribe('scoreRange', callback);

    // Insert a new extreme value
    await s.bucket('customers').insert({ name: 'Charlie', score: 200 });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toEqual({ min: 50, max: 200 });
  });
});
