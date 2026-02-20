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

// ── Bulk operations in transactions ──────────────────────────────

describe('transaction: insertMany', () => {
  it('commits multiple inserts atomically', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const records = await b.insertMany([
        { name: 'Alice', email: 'alice@x.cz' },
        { name: 'Bob', email: 'bob@x.cz' },
        { name: 'Charlie', email: 'charlie@x.cz' },
      ]);
      expect(records).toHaveLength(3);
      expect(records[0]!.name).toBe('Alice');
      expect(records[1]!.name).toBe('Bob');
      expect(records[2]!.name).toBe('Charlie');
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(3);
  });

  it('supports read-your-own-writes after insertMany', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      await b.insertMany([
        { name: 'Alice', tier: 'vip', email: 'alice@x.cz' },
        { name: 'Bob', tier: 'basic', email: 'bob@x.cz' },
      ]);

      const vips = await b.where({ tier: 'vip' });
      expect(vips).toHaveLength(1);
      expect(vips[0]!.name).toBe('Alice');

      expect(await b.count()).toBe(2);
    });
  });

  it('continues autoincrement correctly', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const orders = await tx.bucket('orders');
      const records = await orders.insertMany([
        { customerId: 'c1', amount: 100, items: ['a'] },
        { customerId: 'c2', amount: 200, items: ['b'] },
        { customerId: 'c3', amount: 300, items: ['c'] },
      ]);

      expect(records[0]!.id).toBe(1);
      expect(records[1]!.id).toBe(2);
      expect(records[2]!.id).toBe(3);
    });

    // Counter persists after commit
    const next = await s.bucket('orders').insert({ customerId: 'c4', amount: 400, items: ['d'] });
    expect(next.id).toBe(4);
  });

  it('rolls back all inserts on user error', async () => {
    const s = await createStore();

    await expect(
      s.transaction(async (tx) => {
        const b = await tx.bucket('customers');
        await b.insertMany([
          { name: 'Alice', email: 'alice@x.cz' },
          { name: 'Bob', email: 'bob@x.cz' },
        ]);
        throw new Error('Simulated failure');
      }),
    ).rejects.toThrow('Simulated failure');

    expect(await s.bucket('customers').count()).toBe(0);
  });
});

describe('transaction: updateMany', () => {
  it('updates matching records with overlay', async () => {
    const s = await createStore();
    await s.bucket('customers').insert({ name: 'Alice', tier: 'basic', score: 10, email: 'alice@x.cz' });
    await s.bucket('customers').insert({ name: 'Bob', tier: 'basic', score: 20, email: 'bob@x.cz' });
    await s.bucket('customers').insert({ name: 'Charlie', tier: 'vip', score: 30, email: 'charlie@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const count = await b.updateMany({ tier: 'basic' }, { score: 99 });
      expect(count).toBe(2);

      // Read-your-own-writes: updated records visible within tx
      const basics = await b.where({ tier: 'basic' });
      for (const r of basics) {
        expect(r.score).toBe(99);
      }
    });

    const all = await s.bucket('customers').all();
    const updated = all.filter(r => r.score === 99);
    expect(updated).toHaveLength(2);

    // Untouched record
    const charlie = all.find(r => r.name === 'Charlie')!;
    expect(charlie.score).toBe(30);
  });

  it('returns 0 when no records match', async () => {
    const s = await createStore();
    await s.bucket('customers').insert({ name: 'Alice', email: 'alice@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const count = await b.updateMany({ name: 'NonExistent' }, { score: 99 });
      expect(count).toBe(0);
    });
  });

  it('rolls back on user error', async () => {
    const s = await createStore();
    const alice = await s.bucket('customers').insert({ name: 'Alice', score: 0, email: 'alice@x.cz' });

    await expect(
      s.transaction(async (tx) => {
        const b = await tx.bucket('customers');
        await b.updateMany({}, { score: 999 });
        throw new Error('Boom');
      }),
    ).rejects.toThrow('Boom');

    const found = await s.bucket('customers').get(alice.id);
    expect(found!.score).toBe(0);
  });
});

describe('transaction: deleteMany', () => {
  it('deletes matching records with overlay', async () => {
    const s = await createStore();
    await s.bucket('customers').insert({ name: 'Alice', tier: 'basic', email: 'alice@x.cz' });
    await s.bucket('customers').insert({ name: 'Bob', tier: 'vip', email: 'bob@x.cz' });
    await s.bucket('customers').insert({ name: 'Charlie', tier: 'basic', email: 'charlie@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const count = await b.deleteMany({ tier: 'basic' });
      expect(count).toBe(2);

      // Read-your-own-writes: deleted records not visible
      const all = await b.all();
      expect(all).toHaveLength(1);
      expect(all[0]!.name).toBe('Bob');
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Bob');
  });

  it('returns 0 when no records match', async () => {
    const s = await createStore();
    await s.bucket('customers').insert({ name: 'Alice', email: 'alice@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const count = await b.deleteMany({ name: 'NonExistent' });
      expect(count).toBe(0);
    });

    expect(await s.bucket('customers').count()).toBe(1);
  });

  it('rolls back on user error', async () => {
    const s = await createStore();
    await s.bucket('customers').insert({ name: 'Alice', email: 'alice@x.cz' });
    await s.bucket('customers').insert({ name: 'Bob', email: 'bob@x.cz' });

    await expect(
      s.transaction(async (tx) => {
        const b = await tx.bucket('customers');
        await b.deleteMany({});
        throw new Error('Boom');
      }),
    ).rejects.toThrow('Boom');

    expect(await s.bucket('customers').count()).toBe(2);
  });
});

describe('transaction: upsert', () => {
  it('inserts when key does not exist', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const record = await b.upsert({ name: 'Alice', email: 'alice@x.cz' });
      expect(record._version).toBe(1);
      expect(record.name).toBe('Alice');
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Alice');
  });

  it('updates when key already exists in real store', async () => {
    const s = await createStore();
    const existing = await s.bucket('customers').insert({ name: 'Alice', score: 10, email: 'alice@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const record = await b.upsert({ id: existing.id, name: 'Alice Updated', score: 99 });
      expect(record._version).toBe(2);
      expect(record.name).toBe('Alice Updated');
      expect(record.score).toBe(99);
    });

    const found = await s.bucket('customers').get(existing.id);
    expect(found!.name).toBe('Alice Updated');
    expect(found!.score).toBe(99);
  });

  it('updates a record previously inserted in same transaction', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');
      const inserted = await b.insert({ name: 'Alice', score: 10, email: 'alice@x.cz' });
      const upserted = await b.upsert({ id: inserted.id, name: 'Alice Updated', score: 99 });

      expect(upserted._version).toBe(2);
      expect(upserted.name).toBe('Alice Updated');
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Alice Updated');
  });

  it('rolls back on user error', async () => {
    const s = await createStore();

    await expect(
      s.transaction(async (tx) => {
        const b = await tx.bucket('customers');
        await b.upsert({ name: 'Alice', email: 'alice@x.cz' });
        throw new Error('Boom');
      }),
    ).rejects.toThrow('Boom');

    expect(await s.bucket('customers').count()).toBe(0);
  });
});

describe('transaction: bulk operations multi-bucket', () => {
  it('commits bulk operations across multiple buckets atomically', async () => {
    const s = await createStore();

    await s.transaction(async (tx) => {
      const customers = await tx.bucket('customers');
      const orders = await tx.bucket('orders');

      const [alice, bob] = await customers.insertMany([
        { name: 'Alice', email: 'alice@x.cz' },
        { name: 'Bob', email: 'bob@x.cz' },
      ]);

      await orders.insertMany([
        { customerId: alice!.id as string, amount: 100, items: ['x'] },
        { customerId: bob!.id as string, amount: 200, items: ['y'] },
        { customerId: alice!.id as string, amount: 300, items: ['z'] },
      ]);
    });

    expect(await s.bucket('customers').count()).toBe(2);
    expect(await s.bucket('orders').count()).toBe(3);
  });

  it('rolls back all buckets on error', async () => {
    const s = await createStore();
    await s.bucket('customers').insert({ name: 'Existing', email: 'existing@x.cz' });

    await expect(
      s.transaction(async (tx) => {
        const customers = await tx.bucket('customers');
        const orders = await tx.bucket('orders');

        await customers.insertMany([
          { name: 'Alice', email: 'alice@x.cz' },
          { name: 'Bob', email: 'bob@x.cz' },
        ]);

        await orders.insertMany([
          { customerId: 'c1', amount: 100, items: ['a'] },
        ]);

        throw new Error('Multi-bucket failure');
      }),
    ).rejects.toThrow('Multi-bucket failure');

    expect(await s.bucket('customers').count()).toBe(1); // only the pre-existing one
    expect(await s.bucket('orders').count()).toBe(0);
  });

  it('combines insertMany, updateMany, deleteMany in single transaction', async () => {
    const s = await createStore();

    // Seed data
    await s.bucket('customers').insert({ name: 'Alice', tier: 'basic', score: 10, email: 'alice@x.cz' });
    await s.bucket('customers').insert({ name: 'Bob', tier: 'basic', score: 20, email: 'bob@x.cz' });
    await s.bucket('customers').insert({ name: 'Charlie', tier: 'vip', score: 30, email: 'charlie@x.cz' });

    await s.transaction(async (tx) => {
      const b = await tx.bucket('customers');

      // Insert new records
      await b.insertMany([
        { name: 'Dave', tier: 'vip', email: 'dave@x.cz' },
        { name: 'Eve', tier: 'basic', email: 'eve@x.cz' },
      ]);

      // Update all basic tier to vip
      const updateCount = await b.updateMany({ tier: 'basic' }, { tier: 'vip' });
      expect(updateCount).toBe(3); // Alice, Bob, Eve

      // Delete Charlie
      const deleteCount = await b.deleteMany({ name: 'Charlie' });
      expect(deleteCount).toBe(1);
    });

    const all = await s.bucket('customers').all();
    expect(all).toHaveLength(4); // Alice, Bob, Dave, Eve (Charlie deleted)
    for (const r of all) {
      expect(r.tier).toBe('vip');
    }
  });
});
