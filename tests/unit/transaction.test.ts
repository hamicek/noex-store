import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import {
  createBucketBehavior,
  type BucketRef,
  type CommitBatchResult,
} from '../../src/core/bucket-server.js';
import type { BucketDefinition, BucketEvent, StoreRecord } from '../../src/types/index.js';
import { TransactionContext } from '../../src/transaction/transaction.js';
import { TransactionConflictError } from '../../src/core/store.js';

// ── Fixtures ────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 1 },
    tier:  { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
    score: { type: 'number', default: 0 },
  },
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    customerId: { type: 'string', required: true },
    amount:     { type: 'number', required: true, min: 0 },
  },
};

const uniqueDef: BucketDefinition = {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    email: { type: 'string', required: true, unique: true },
    name:  { type: 'string', required: true },
  },
  indexes: ['email'],
};

let eventBusRef: EventBusRef;
let customersRef: BucketRef;
let ordersRef: BucketRef;

const definitions = new Map<string, BucketDefinition>();
const refs = new Map<string, BucketRef>();

// ── Setup / Teardown ──────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
  customersRef = await GenServer.start(
    createBucketBehavior('customers', customersDef, eventBusRef),
  ) as BucketRef;
  ordersRef = await GenServer.start(
    createBucketBehavior('orders', ordersDef, eventBusRef),
  ) as BucketRef;

  definitions.clear();
  refs.clear();
  definitions.set('customers', customersDef);
  definitions.set('orders', ordersDef);
  refs.set('customers', customersRef);
  refs.set('orders', ordersRef);
});

afterEach(async () => {
  for (const ref of [customersRef, ordersRef]) {
    if (ref !== undefined && GenServer.isRunning(ref)) {
      await GenServer.stop(ref);
    }
  }
  if (EventBus.isRunning(eventBusRef)) {
    await EventBus.stop(eventBusRef);
  }
});

// ── Helpers ──────────────────────────────────────────────────────

function createTx(): TransactionContext {
  return new TransactionContext(definitions, refs, eventBusRef);
}

async function insertCustomer(data: Record<string, unknown>): Promise<StoreRecord> {
  return await GenServer.call(customersRef, { type: 'insert', data }) as StoreRecord;
}

async function getCustomer(key: unknown): Promise<StoreRecord | undefined> {
  return await GenServer.call(customersRef, { type: 'get', key }) as StoreRecord | undefined;
}

async function allCustomers(): Promise<StoreRecord[]> {
  return await GenServer.call(customersRef, { type: 'all' }) as StoreRecord[];
}

async function allOrders(): Promise<StoreRecord[]> {
  return await GenServer.call(ordersRef, { type: 'all' }) as StoreRecord[];
}

// ── Tests ────────────────────────────────────────────────────────

describe('TransactionContext', () => {
  describe('bucket()', () => {
    it('returns a handle for a defined bucket', async () => {
      const tx = createTx();
      const handle = await tx.bucket('customers');
      expect(handle.name).toBe('customers');
    });

    it('returns the same handle for repeated calls', async () => {
      const tx = createTx();
      const a = await tx.bucket('customers');
      const b = await tx.bucket('customers');
      expect(a).toBe(b);
    });

    it('throws for an undefined bucket', async () => {
      const tx = createTx();
      await expect(tx.bucket('unknown')).rejects.toThrow('Bucket "unknown" is not defined');
    });
  });

  describe('commit — single bucket', () => {
    it('commits a single insert', async () => {
      const tx = createTx();
      const b = await tx.bucket('customers');
      const record = await b.insert({ name: 'Jan' });
      await tx.commit();

      const found = await getCustomer(record.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Jan');
    });

    it('commits multiple inserts', async () => {
      const tx = createTx();
      const b = await tx.bucket('customers');
      await b.insert({ name: 'Jan' });
      await b.insert({ name: 'Petr' });
      await tx.commit();

      const all = await allCustomers();
      expect(all).toHaveLength(2);
    });

    it('commits an update', async () => {
      const c = await insertCustomer({ name: 'Jan', score: 0 });

      const tx = createTx();
      const b = await tx.bucket('customers');
      await b.update(c.id, { score: 50 });
      await tx.commit();

      const found = await getCustomer(c.id);
      expect(found!.score).toBe(50);
      expect(found!._version).toBe(2);
    });

    it('commits a delete', async () => {
      const c = await insertCustomer({ name: 'Jan' });

      const tx = createTx();
      const b = await tx.bucket('customers');
      await b.delete(c.id);
      await tx.commit();

      const found = await getCustomer(c.id);
      expect(found).toBeUndefined();
    });

    it('commits mixed operations', async () => {
      const c = await insertCustomer({ name: 'Jan', score: 0 });

      const tx = createTx();
      const b = await tx.bucket('customers');
      await b.insert({ name: 'Petr' });
      await b.update(c.id, { score: 100 });
      await tx.commit();

      const all = await allCustomers();
      expect(all).toHaveLength(2);

      const jan = await getCustomer(c.id);
      expect(jan!.score).toBe(100);
    });
  });

  describe('commit — multi-bucket', () => {
    it('commits across two buckets', async () => {
      const tx = createTx();
      const customers = await tx.bucket('customers');
      const orders = await tx.bucket('orders');
      const c = await customers.insert({ name: 'Jan' });
      await orders.insert({ customerId: c.id, amount: 500 });
      await tx.commit();

      expect(await allCustomers()).toHaveLength(1);
      expect(await allOrders()).toHaveLength(1);
    });
  });

  describe('commit — empty transaction', () => {
    it('is a no-op when nothing was written', async () => {
      const tx = createTx();
      await tx.commit(); // No error
    });

    it('is a no-op when only reads were performed', async () => {
      const c = await insertCustomer({ name: 'Jan' });

      const tx = createTx();
      const b = await tx.bucket('customers');
      await b.get(c.id);
      await tx.commit(); // No error
    });
  });

  describe('commit — double commit guard', () => {
    it('throws if commit is called twice', async () => {
      const tx = createTx();
      await tx.commit();
      await expect(tx.commit()).rejects.toThrow('Transaction already committed');
    });
  });

  describe('events', () => {
    it('publishes events after all buckets committed', async () => {
      const events: BucketEvent[] = [];
      await EventBus.subscribe(eventBusRef, 'bucket.*.*', (e: BucketEvent) => {
        events.push(e);
      });

      const tx = createTx();
      const customers = await tx.bucket('customers');
      const orders = await tx.bucket('orders');
      await customers.insert({ name: 'Jan' });
      await orders.insert({ customerId: 'x', amount: 100 });

      // Before commit — no events from the tx (note: autoincrement counter fetch is a call, not cast)
      const eventsBefore = events.filter((e) => e.type === 'inserted');
      expect(eventsBefore).toHaveLength(0);

      await tx.commit();

      // After commit — events published
      // Allow micro-task flush
      await new Promise((r) => { setTimeout(r, 10); });
      const inserts = events.filter((e) => e.type === 'inserted');
      expect(inserts).toHaveLength(2);
      expect(inserts.map((e) => e.bucket).sort()).toEqual(['customers', 'orders']);
    });

    it('does not publish events on empty commit', async () => {
      const events: BucketEvent[] = [];
      await EventBus.subscribe(eventBusRef, 'bucket.*.*', (e: BucketEvent) => {
        events.push(e);
      });

      const tx = createTx();
      await tx.commit();

      await new Promise((r) => { setTimeout(r, 10); });
      expect(events).toHaveLength(0);
    });
  });

  describe('rollback — user error', () => {
    it('discards buffer when callback would throw (manual scenario)', async () => {
      const c = await insertCustomer({ name: 'Jan', score: 0 });

      // Simulate: user creates tx, writes, then throws before commit
      const tx = createTx();
      const b = await tx.bucket('customers');
      await b.update(c.id, { score: 999 });
      // tx.commit() is never called — buffer is discarded

      // Verify real store unchanged
      const found = await getCustomer(c.id);
      expect(found!.score).toBe(0);
    });
  });

  describe('rollback — version conflict', () => {
    it('throws TransactionConflictError on version mismatch', async () => {
      const c = await insertCustomer({ name: 'Jan', score: 0 });

      // Transaction update reads from real store, captures version 1
      const tx = createTx();
      const b = await tx.bucket('customers');
      await b.update(c.id, { score: 100 }); // expectedVersion = 1

      // External update AFTER tx.update but BEFORE commit bumps to version 2
      await GenServer.call(customersRef, {
        type: 'update', key: c.id, changes: { score: 50 },
      });

      // Commit detects version mismatch: expected 1, actual 2
      await expect(tx.commit()).rejects.toThrow(TransactionConflictError);

      // External update preserved, no partial writes
      const found = await getCustomer(c.id);
      expect(found!.score).toBe(50);
      expect(found!._version).toBe(2);
    });
  });

  describe('rollback — cross-bucket', () => {
    it('rolls back bucket A when bucket B fails', async () => {
      // Set up a unique-constrained bucket to force a conflict
      const uniqueRef = await GenServer.start(
        createBucketBehavior('unique_items', uniqueDef, eventBusRef),
      ) as BucketRef;

      definitions.set('unique_items', uniqueDef);
      refs.set('unique_items', uniqueRef);

      // Pre-insert a record with email=x@y.cz
      await GenServer.call(uniqueRef, {
        type: 'insert', data: { email: 'x@y.cz', name: 'Existing' },
      });

      const c = await insertCustomer({ name: 'Jan', score: 0 });

      try {
        // Transaction: update customers (succeeds), then insert duplicate in unique_items (fails)
        const tx = createTx();
        const customers = await tx.bucket('customers');
        const items = await tx.bucket('unique_items');

        await customers.update(c.id, { score: 999 });
        await items.insert({ email: 'x@y.cz', name: 'Duplicate' }); // unique violation at commit time

        await expect(tx.commit()).rejects.toThrow();

        // Customers bucket should be rolled back
        const found = await getCustomer(c.id);
        expect(found!.score).toBe(0);
        expect(found!._version).toBe(1);
      } finally {
        if (GenServer.isRunning(uniqueRef)) {
          await GenServer.stop(uniqueRef);
        }
      }
    });
  });

  describe('autoincrement counter', () => {
    it('updates counter on commit', async () => {
      const tx = createTx();
      const orders = await tx.bucket('orders');
      await orders.insert({ customerId: 'c1', amount: 100 });
      await orders.insert({ customerId: 'c2', amount: 200 });
      await tx.commit();

      // Counter should be 2 after two inserts
      const counter = await GenServer.call(ordersRef, { type: 'getAutoincrementCounter' }) as number;
      expect(counter).toBe(2);

      // Next direct insert should get id=3
      const directInsert = await GenServer.call(ordersRef, {
        type: 'insert', data: { customerId: 'c3', amount: 300 },
      }) as StoreRecord;
      expect(directInsert.id).toBe(3);
    });
  });

  describe('net operations (insert+delete = no-op)', () => {
    it('insert then delete in same tx produces no commit ops', async () => {
      const beforeCount = (await allCustomers()).length;

      const tx = createTx();
      const b = await tx.bucket('customers');
      const record = await b.insert({ name: 'Temp' });
      await b.delete(record.id);
      await tx.commit();

      expect(await allCustomers()).toHaveLength(beforeCount);
    });
  });

  describe('read-your-own-writes through commit', () => {
    it('committed inserts are visible in real store', async () => {
      const tx = createTx();
      const b = await tx.bucket('customers');
      const c = await b.insert({ name: 'Jan' });
      await tx.commit();

      // Verify through real GenServer call (not transaction handle)
      const found = await getCustomer(c.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Jan');
    });

    it('committed updates persist', async () => {
      const c = await insertCustomer({ name: 'Jan', score: 0 });

      const tx = createTx();
      const b = await tx.bucket('customers');
      await b.update(c.id, { score: 42 });
      await tx.commit();

      const found = await getCustomer(c.id);
      expect(found!.score).toBe(42);
    });

    it('committed deletes persist', async () => {
      const c = await insertCustomer({ name: 'Jan' });

      const tx = createTx();
      const b = await tx.bucket('customers');
      await b.delete(c.id);
      await tx.commit();

      expect(await getCustomer(c.id)).toBeUndefined();
    });
  });
});
