import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, GenServer, MemoryAdapter, type EventBusRef } from '@hamicek/noex';
import { StorePersistence } from '../../src/persistence/store-persistence.js';
import {
  createBucketBehavior,
  type BucketRef,
  type BucketSnapshot,
} from '../../src/core/bucket-server.js';
import type {
  BucketDefinition,
  StoreRecord,
  StorePersistenceConfig,
} from '../../src/types/index.js';

// ── Helpers ──────────────────────────────────────────────────────

const usersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    total: { type: 'number', required: true },
  },
};

let eventBusRef: EventBusRef;

async function startBucket(
  name: string,
  definition: BucketDefinition,
): Promise<BucketRef> {
  const behavior = createBucketBehavior(name, definition, eventBusRef);
  return GenServer.start(behavior) as Promise<BucketRef>;
}

async function insertRecord(
  ref: BucketRef,
  data: Record<string, unknown>,
): Promise<StoreRecord> {
  return GenServer.call(ref, { type: 'insert', data }) as Promise<StoreRecord>;
}

async function getSnapshot(ref: BucketRef): Promise<BucketSnapshot> {
  return GenServer.call(ref, { type: 'getSnapshot' }) as Promise<BucketSnapshot>;
}

/** Wait for debounced persistence to complete. */
async function waitForDebounce(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
});

afterEach(async () => {
  await EventBus.stop(eventBusRef);
});

// ── Tests ───────────────────────────────────────────────────────

describe('StorePersistence', () => {
  describe('loadBucket', () => {
    it('returns undefined when no persisted data exists', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter });
      await persistence.start(eventBusRef);

      const result = await persistence.loadBucket('users');

      expect(result).toBeUndefined();
      await persistence.stop();
    });

    it('returns BucketInitialData when persisted data exists', async () => {
      const adapter = new MemoryAdapter();

      // Pre-populate adapter with persisted data
      await adapter.save('test:bucket:users', {
        state: {
          records: [[1, { id: 1, name: 'Jan', _version: 1, _createdAt: 100, _updatedAt: 100 }]],
          autoincrementCounter: 1,
        },
        metadata: { persistedAt: Date.now(), serverId: 'test', schemaVersion: 1 },
      });

      const persistence = new StorePersistence('test', { adapter });
      await persistence.start(eventBusRef);

      const result = await persistence.loadBucket('users');

      expect(result).toBeDefined();
      expect(result!.autoincrementCounter).toBe(1);
      expect(result!.records).toHaveLength(1);
      expect(result!.records[0]![1]).toMatchObject({ id: 1, name: 'Jan' });
      await persistence.stop();
    });

    it('calls onError and returns undefined when adapter throws', async () => {
      const onError = vi.fn();
      const adapter = new MemoryAdapter();
      const originalLoad = adapter.load.bind(adapter);
      adapter.load = async () => { throw new Error('disk failure'); };

      const persistence = new StorePersistence('test', { adapter, onError });
      await persistence.start(eventBusRef);

      const result = await persistence.loadBucket('users');

      expect(result).toBeUndefined();
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(onError.mock.calls[0]![0].message).toBe('disk failure');

      adapter.load = originalLoad;
      await persistence.stop();
    });
  });

  describe('registerBucket + flush', () => {
    it('persists dirty buckets on flush', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 5000 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('users', usersDef);
      await insertRecord(ref, { name: 'Jan' });
      persistence.registerBucket('users', ref);

      // Manually mark as dirty by triggering a change via EventBus
      await insertRecord(ref, { name: 'Petra' });
      // The EventBus event will mark bucket dirty, but debounce is 5s.
      // Wait a tick for event delivery.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Force flush
      await persistence.flush();

      // Verify data was persisted
      const persisted = await adapter.load<{ records: unknown[]; autoincrementCounter: number }>('test:bucket:users');
      expect(persisted).toBeDefined();
      expect(persisted!.state.records).toHaveLength(2);
      expect(persisted!.state.autoincrementCounter).toBe(2);

      await persistence.stop();
      await GenServer.stop(ref);
    });

    it('does not call adapter.save when no dirty buckets', async () => {
      const adapter = new MemoryAdapter();
      const saveSpy = vi.spyOn(adapter, 'save');
      const persistence = new StorePersistence('test', { adapter });
      await persistence.start(eventBusRef);

      await persistence.flush();

      expect(saveSpy).not.toHaveBeenCalled();
      await persistence.stop();
    });
  });

  describe('debounce batching', () => {
    it('batches multiple changes within debounce interval', async () => {
      const adapter = new MemoryAdapter();
      const saveSpy = vi.spyOn(adapter, 'save');
      const persistence = new StorePersistence('test', { adapter, debounceMs: 50 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('users', usersDef);
      persistence.registerBucket('users', ref);

      // Rapid inserts
      await insertRecord(ref, { name: 'Jan' });
      await insertRecord(ref, { name: 'Petra' });
      await insertRecord(ref, { name: 'Lucie' });

      // Wait for debounce
      await waitForDebounce(100);

      // Should batch into one save call per bucket
      expect(saveSpy).toHaveBeenCalledTimes(1);

      const persisted = await adapter.load<{ records: unknown[]; autoincrementCounter: number }>('test:bucket:users');
      expect(persisted!.state.records).toHaveLength(3);

      await persistence.stop();
      await GenServer.stop(ref);
    });
  });

  describe('unregisterBucket', () => {
    it('ignores events for unregistered buckets', async () => {
      const adapter = new MemoryAdapter();
      const saveSpy = vi.spyOn(adapter, 'save');
      const persistence = new StorePersistence('test', { adapter, debounceMs: 20 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('users', usersDef);
      persistence.registerBucket('users', ref);
      persistence.unregisterBucket('users');

      await insertRecord(ref, { name: 'Jan' });
      await waitForDebounce(50);

      expect(saveSpy).not.toHaveBeenCalled();

      await persistence.stop();
      await GenServer.stop(ref);
    });
  });

  describe('stop', () => {
    it('marks all registered buckets dirty and flushes', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const usersRef = await startBucket('users', usersDef);
      const ordersRef = await startBucket('orders', ordersDef);
      await insertRecord(usersRef, { name: 'Jan' });
      await insertRecord(ordersRef, { total: 100 });

      persistence.registerBucket('users', usersRef);
      persistence.registerBucket('orders', ordersRef);

      // Stop — should persist both buckets even though no events were received after register
      await persistence.stop();

      const users = await adapter.load<{ records: unknown[] }>('test:bucket:users');
      const orders = await adapter.load<{ records: unknown[] }>('test:bucket:orders');
      expect(users!.state.records).toHaveLength(1);
      expect(orders!.state.records).toHaveLength(1);

      await GenServer.stop(usersRef);
      await GenServer.stop(ordersRef);
    });

    it('calls adapter.close', async () => {
      const adapter = new MemoryAdapter();
      const closeSpy = vi.spyOn(adapter, 'close');
      const persistence = new StorePersistence('test', { adapter });
      await persistence.start(eventBusRef);

      await persistence.stop();

      expect(closeSpy).toHaveBeenCalledOnce();
    });
  });

  describe('persistence errors', () => {
    it('calls onError when adapter.save throws, without stopping other buckets', async () => {
      const onError = vi.fn();
      const adapter = new MemoryAdapter();
      let callCount = 0;
      const originalSave = adapter.save.bind(adapter);
      adapter.save = async (key, data) => {
        callCount++;
        if (key === 'test:bucket:users') {
          throw new Error('write failure');
        }
        return originalSave(key, data);
      };

      const persistence = new StorePersistence('test', { adapter, onError, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const usersRef = await startBucket('users', usersDef);
      const ordersRef = await startBucket('orders', ordersDef);
      await insertRecord(usersRef, { name: 'Jan' });
      await insertRecord(ordersRef, { total: 100 });
      persistence.registerBucket('users', usersRef);
      persistence.registerBucket('orders', ordersRef);

      // Mark both dirty and flush
      await persistence.stop();

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]![0].message).toBe('write failure');

      // Orders should still have been persisted
      adapter.save = originalSave;
      const orders = await adapter.load<{ records: unknown[] }>('test:bucket:orders');
      expect(orders!.state.records).toHaveLength(1);

      await GenServer.stop(usersRef);
      await GenServer.stop(ordersRef);
    });
  });

  describe('bucket key format', () => {
    it('uses <storeName>:bucket:<bucketName> format', async () => {
      const adapter = new MemoryAdapter();
      const saveSpy = vi.spyOn(adapter, 'save');
      const persistence = new StorePersistence('my-store', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('customers', usersDef);
      await insertRecord(ref, { name: 'Jan' });
      persistence.registerBucket('customers', ref);

      await persistence.stop();

      expect(saveSpy).toHaveBeenCalledWith(
        'my-store:bucket:customers',
        expect.objectContaining({
          state: expect.objectContaining({ autoincrementCounter: expect.any(Number) }),
          metadata: expect.objectContaining({
            serverId: 'my-store',
            schemaVersion: 1,
          }),
        }),
      );

      await GenServer.stop(ref);
    });
  });

  describe('metadata', () => {
    it('stores correct metadata with each save', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('store-x', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('items', usersDef);
      await insertRecord(ref, { name: 'Item' });
      persistence.registerBucket('items', ref);

      const before = Date.now();
      await persistence.stop();
      const after = Date.now();

      const persisted = await adapter.load<unknown>('store-x:bucket:items');
      expect(persisted!.metadata.serverId).toBe('store-x');
      expect(persisted!.metadata.schemaVersion).toBe(1);
      expect(persisted!.metadata.persistedAt).toBeGreaterThanOrEqual(before);
      expect(persisted!.metadata.persistedAt).toBeLessThanOrEqual(after);

      await GenServer.stop(ref);
    });
  });
});
