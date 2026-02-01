import { describe, it, expect, afterEach } from 'vitest';
import { Store, TransactionConflictError } from '../../src/core/store.js';
import type { BucketDefinition, BucketEvent, StoreRecord } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 1 },
    tier:  { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
    score: { type: 'number', default: 0 },
    email: { type: 'string', format: 'email', unique: true },
  },
  indexes: ['email', 'tier'],
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    customerId: { type: 'string', required: true },
    amount:     { type: 'number', required: true, min: 0 },
    items:      { type: 'array', required: true },
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

// ── Basic transactions ──────────────────────────────────────────

describe('transaction: basic', () => {
  it('single-bucket insert', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insert({ name: 'Jan', email: 'jan@x.cz' });
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Jan');
  });

  it('multi-bucket transaction', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const customers = await tx.bucket('customers');
      const orders = await tx.bucket('orders');
      const c = await customers.insert({ name: 'Jan', email: 'jan@x.cz' });
      await orders.insert({ customerId: c.id as string, amount: 100, items: ['x'] });
    });

    expect(await s.bucket('customers').count()).toBe(1);
    expect(await s.bucket('orders').count()).toBe(1);
  });

  it('return value from transaction', async () => {
    const s = await createStore();

    const result = await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const c = await b.insert({ name: 'Jan', email: 'jan@x.cz' });
      return c.id;
    });

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(await s.bucket('customers').get(result)).toBeDefined();
  });
});

// ── Read-your-own-writes ────────────────────────────────────────

describe('transaction: read-your-own-writes', () => {
  it('get sees buffered insert', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const c = await b.insert({ name: 'Jan', email: 'jan@x.cz' });
      const found = await b.get(c.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Jan');
    });
  });

  it('where sees buffered insert', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insert({ name: 'Jan', tier: 'vip', email: 'jan@x.cz' });
      const vips = await b.where({ tier: 'vip' });
      expect(vips).toHaveLength(1);
    });
  });

  it('get sees buffered update', async () => {
    const s = await createStore();
    const c = await s.bucket('customers').insert({ name: 'Jan', tier: 'basic', email: 'jan@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.update(c.id, { tier: 'vip' });
      const found = await b.get(c.id);
      expect(found!.tier).toBe('vip');
    });

    expect((await s.bucket('customers').get(c.id))!.tier).toBe('vip');
  });

  it('get returns undefined for buffered delete', async () => {
    const s = await createStore();
    const c = await s.bucket('customers').insert({ name: 'Jan', email: 'jan@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.delete(c.id);
      const found = await b.get(c.id);
      expect(found).toBeUndefined();
    });

    expect(await s.bucket('customers').get(c.id)).toBeUndefined();
  });

  it('all includes inserts and excludes deletes', async () => {
    const s = await createStore();
    const existing = await s.bucket('customers').insert({ name: 'Alice', email: 'alice@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insert({ name: 'Bob', email: 'bob@x.cz' });
      await b.delete(existing.id);

      const all = await b.all();
      expect(all).toHaveLength(1);
      expect(all[0]!.name).toBe('Bob');
    });
  });

  it('count reflects buffered writes', async () => {
    const s = await createStore();
    await s.bucket('customers').insert({ name: 'Alice', email: 'alice@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insert({ name: 'Bob', email: 'bob@x.cz' });
      await b.insert({ name: 'Charlie', email: 'charlie@x.cz' });
      expect(await b.count()).toBe(3);
    });
  });

  it('findOne returns buffered insert', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insert({ name: 'Jan', tier: 'vip', email: 'jan@x.cz' });
      const found = await b.findOne({ tier: 'vip' });
      expect(found).toBeDefined();
      expect(found!.name).toBe('Jan');
    });
  });
});

// ── Rollback: user error ────────────────────────────────────────

describe('transaction: rollback on user error', () => {
  it('discards writes when callback throws', async () => {
    const s = await createStore();
    const c = await s.bucket('customers').insert({ name: 'Jan', score: 0, email: 'jan@x.cz' });

    await expect(
      s.transaction(async (tx) => {
        const b = await tx.bucket('customers');
        await b.update(c.id, { score: 999 });
        throw new Error('Simulated failure');
      }),
    ).rejects.toThrow('Simulated failure');

    const found = await s.bucket('customers').get(c.id);
    expect(found!.score).toBe(0);
  });

  it('preserves inserts from before the transaction', async () => {
    const s = await createStore();
    const c = await s.bucket('customers').insert({ name: 'Jan', email: 'jan@x.cz' });

    try {
      await s.transaction(async (tx) => {
        const b = await tx.bucket('customers');
        await b.delete(c.id);
        throw new Error('Oops');
      });
    } catch { /* expected */ }

    expect(await s.bucket('customers').get(c.id)).toBeDefined();
  });
});

// ── Rollback: version conflict ──────────────────────────────────

describe('transaction: version conflict', () => {
  it('throws TransactionConflictError on concurrent update', async () => {
    const s = await createStore();
    const c = await s.bucket('customers').insert({ name: 'Jan', score: 0, email: 'jan@x.cz' });

    await expect(
      s.transaction(async (tx) => {
        const b = await tx.bucket('customers');
        // Reads version 1, captures expectedVersion=1
        await b.update(c.id, { score: 100 });

        // External update bumps version to 2 before commit
        await s.bucket('customers').update(c.id, { score: 50 });
      }),
    ).rejects.toThrow(TransactionConflictError);

    // External update preserved
    const found = await s.bucket('customers').get(c.id);
    expect(found!.score).toBe(50);
    expect(found!._version).toBe(2);
  });
});

// ── Rollback: cross-bucket ──────────────────────────────────────

describe('transaction: cross-bucket rollback', () => {
  it('rolls back bucket A when bucket B fails', async () => {
    const s = await createStore();
    const c = await s.bucket('customers').insert({ name: 'Jan', score: 0, email: 'jan@x.cz' });

    // Pre-insert an order so we can cause a conflict on orders bucket
    await s.bucket('orders').insert({ customerId: 'x', amount: 1, items: ['a'] });

    await expect(
      s.transaction(async (tx) => {
        const customers = await tx.bucket('customers');
        const orders = await tx.bucket('orders');

        // This will commit first (customers bucket)
        await customers.update(c.id, { score: 999 });

        // Read the order, then externally update it to create version conflict
        const allOrders = await orders.all();
        const order = allOrders[0]!;
        await orders.update(order.id, { amount: 200 });

        // External update on the order → version conflict at commit time
        await s.bucket('orders').update(order.id, { amount: 300 });
      }),
    ).rejects.toThrow();

    // Customers bucket should be rolled back
    const found = await s.bucket('customers').get(c.id);
    expect(found!.score).toBe(0);
    expect(found!._version).toBe(1);
  });
});

// ── Events ──────────────────────────────────────────────────────

describe('transaction: events', () => {
  it('emits events only after successful commit', async () => {
    const s = await createStore();
    const events: BucketEvent[] = [];
    await s.on('bucket.*.*', (event: BucketEvent) => { events.push(event); });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insert({ name: 'Jan', email: 'jan@x.cz' });
      // Mid-transaction: no events yet
      expect(events.filter((e) => e.type === 'inserted' && e.bucket === 'customers')).toHaveLength(0);
    });

    // After commit: events emitted
    await new Promise((r) => { setTimeout(r, 20); });
    const inserts = events.filter((e) => e.type === 'inserted' && e.bucket === 'customers');
    expect(inserts).toHaveLength(1);
  });

  it('emits no events on rollback', async () => {
    const s = await createStore();
    const events: BucketEvent[] = [];
    await s.on('bucket.*.*', (event: BucketEvent) => { events.push(event); });

    try {
      await s.transaction(async (tx) => {
        const b = await tx.bucket('customers');
        await b.insert({ name: 'Jan', email: 'jan@x.cz' });
        throw new Error('Boom');
      });
    } catch { /* expected */ }

    await new Promise((r) => { setTimeout(r, 20); });
    expect(events.filter((e) => e.bucket === 'customers')).toHaveLength(0);
  });

  it('batches events from multi-bucket transaction', async () => {
    const s = await createStore();
    const events: BucketEvent[] = [];
    await s.on('bucket.*.*', (event: BucketEvent) => { events.push(event); });

    await s.transaction(async (tx) => {
      const customers = await tx.bucket('customers');
      const orders = await tx.bucket('orders');
      await customers.insert({ name: 'Jan', email: 'jan@x.cz' });
      await orders.insert({ customerId: 'c1', amount: 100, items: ['x'] });
    });

    await new Promise((r) => { setTimeout(r, 20); });
    const inserts = events.filter((e) => e.type === 'inserted');
    expect(inserts).toHaveLength(2);
    expect(inserts.map((e) => e.bucket).sort()).toEqual(['customers', 'orders']);
  });
});

// ── Reactive queries ────────────────────────────────────────────

describe('transaction: reactive queries', () => {
  it('single callback after multi-insert commit', async () => {
    const s = await createStore();

    s.defineQuery('all-customers', async (ctx) =>
      ctx.bucket('customers').all(),
    );

    const results: StoreRecord[][] = [];
    await s.subscribe<StoreRecord[]>('all-customers', (r) => { results.push(r); });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insert({ name: 'A', email: 'a@x.cz' });
      await b.insert({ name: 'B', email: 'b@x.cz' });
    });

    await s.settle();

    // Expect at least one callback with both records
    const last = results[results.length - 1]!;
    expect(last).toHaveLength(2);
  });
});

// ── Edge cases ──────────────────────────────────────────────────

describe('transaction: edge cases', () => {
  it('empty transaction is a no-op', async () => {
    const s = await createStore();

    await s.transaction(async () => {
      // Nothing
    });

    expect(await s.bucket('customers').count()).toBe(0);
  });

  it('read-only transaction is a no-op', async () => {
    const s = await createStore();
    const c = await s.bucket('customers').insert({ name: 'Jan', email: 'jan@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const found = await b.get(c.id);
      expect(found!.name).toBe('Jan');
    });

    // Store unchanged
    expect(await s.bucket('customers').count()).toBe(1);
  });

  it('insert then delete in same transaction is net-zero', async () => {
    const s = await createStore();
    const beforeCount = await s.bucket('customers').count();

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const c = await b.insert({ name: 'Temp', email: 'temp@x.cz' });
      await b.delete(c.id);
    });

    expect(await s.bucket('customers').count()).toBe(beforeCount);
  });

  it('multiple updates to the same record in one transaction', async () => {
    const s = await createStore();
    const c = await s.bucket('customers').insert({ name: 'Jan', score: 0, email: 'jan@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.update(c.id, { score: 10 });
      await b.update(c.id, { score: 20 });
      await b.update(c.id, { score: 30 });

      const found = await b.get(c.id);
      expect(found!.score).toBe(30);
    });

    const found = await s.bucket('customers').get(c.id);
    expect(found!.score).toBe(30);
  });

  it('transaction with autoincrement keys', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const orders = await tx.bucket('orders');
      const o1 = await orders.insert({ customerId: 'c1', amount: 100, items: ['a'] });
      const o2 = await orders.insert({ customerId: 'c2', amount: 200, items: ['b'] });
      expect(o1.id).toBe(1);
      expect(o2.id).toBe(2);
    });

    const all = await s.bucket('orders').all();
    expect(all).toHaveLength(2);

    // Next insert outside transaction should continue the counter
    const o3 = await s.bucket('orders').insert({ customerId: 'c3', amount: 300, items: ['c'] });
    expect(o3.id).toBe(3);
  });

  it('throws for undefined bucket in transaction', async () => {
    const s = await createStore();

    await expect(
      s.transaction(async (tx) => {
        await tx.bucket('nonexistent');
      }),
    ).rejects.toThrow('Bucket "nonexistent" is not defined');
  });
});
