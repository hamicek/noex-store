import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus, GenServer, MemoryAdapter, type EventBusRef } from '@hamicek/noex';
import { StorePersistence } from '../../src/persistence/store-persistence.js';
import {
  createBucketBehavior,
  type BucketRef,
} from '../../src/core/bucket-server.js';
import type {
  BucketDefinition,
  StoreRecord,
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
const refs: BucketRef[] = [];

async function startBucket(
  name: string,
  definition: BucketDefinition,
): Promise<BucketRef> {
  const behavior = createBucketBehavior(name, definition, eventBusRef);
  const ref = await GenServer.start(behavior) as BucketRef;
  refs.push(ref);
  return ref;
}

async function insertRecord(
  ref: BucketRef,
  data: Record<string, unknown>,
): Promise<StoreRecord> {
  return GenServer.call(ref, { type: 'insert', data }) as Promise<StoreRecord>;
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
});

afterEach(async () => {
  for (const ref of refs.splice(0)) {
    await GenServer.stop(ref);
  }
  await EventBus.stop(eventBusRef);
});

// ── Tests ───────────────────────────────────────────────────────

describe('StorePersistence: backup', () => {
  describe('createBackup', () => {
    it('creates a backup of all registered buckets', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const usersRef = await startBucket('users', usersDef);
      const ordersRef = await startBucket('orders', ordersDef);
      await insertRecord(usersRef, { name: 'Alice' });
      await insertRecord(usersRef, { name: 'Bob' });
      await insertRecord(ordersRef, { total: 100 });

      persistence.registerBucket('users', usersRef);
      persistence.registerBucket('orders', ordersRef);

      const backup = await persistence.createBackup('snap-1');

      expect(backup.id).toBe('snap-1');
      expect(backup.name).toBe('snap-1');
      expect(backup.bucketNames).toHaveLength(2);
      expect(backup.bucketNames).toContain('users');
      expect(backup.bucketNames).toContain('orders');
      expect(backup.totalRecords).toBe(3);
      expect(backup.createdAt).toBeGreaterThan(0);

      await persistence.stop();
    });

    it('stores backup data in adapter with correct key', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('my-store', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('users', usersDef);
      await insertRecord(ref, { name: 'Alice' });
      persistence.registerBucket('users', ref);

      await persistence.createBackup('daily');

      const persisted = await adapter.load<unknown>('my-store:backup:daily');
      expect(persisted).toBeDefined();
      expect(persisted!.metadata.serverId).toBe('my-store');
      expect(persisted!.metadata.schemaVersion).toBe(1);

      await persistence.stop();
    });

    it('creates empty backup when no buckets are registered', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const backup = await persistence.createBackup('empty');

      expect(backup.bucketNames).toHaveLength(0);
      expect(backup.totalRecords).toBe(0);

      await persistence.stop();
    });

    it('overwrites existing backup with the same name', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('users', usersDef);
      await insertRecord(ref, { name: 'Alice' });
      persistence.registerBucket('users', ref);

      await persistence.createBackup('snap');

      await insertRecord(ref, { name: 'Bob' });
      const backup2 = await persistence.createBackup('snap');

      expect(backup2.totalRecords).toBe(2);

      const loaded = await persistence.loadBackup('snap');
      expect(loaded!.meta.totalRecords).toBe(2);

      await persistence.stop();
    });
  });

  describe('listBackups', () => {
    it('returns empty array when no backups exist', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const list = await persistence.listBackups();

      expect(list).toEqual([]);

      await persistence.stop();
    });

    it('lists all backups sorted by createdAt', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('users', usersDef);
      persistence.registerBucket('users', ref);

      await persistence.createBackup('first');
      await insertRecord(ref, { name: 'Alice' });
      await persistence.createBackup('second');

      const list = await persistence.listBackups();

      expect(list).toHaveLength(2);
      expect(list[0]!.name).toBe('first');
      expect(list[1]!.name).toBe('second');
      expect(list[0]!.createdAt).toBeLessThanOrEqual(list[1]!.createdAt);

      await persistence.stop();
    });

    it('does not include regular bucket persistence keys', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('users', usersDef);
      await insertRecord(ref, { name: 'Alice' });
      persistence.registerBucket('users', ref);

      // Flush regular persistence
      await persistence.flush();
      // Create a backup
      await persistence.createBackup('snap');

      const list = await persistence.listBackups();

      expect(list).toHaveLength(1);
      expect(list[0]!.name).toBe('snap');

      await persistence.stop();
    });
  });

  describe('loadBackup', () => {
    it('returns undefined for non-existent backup', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const loaded = await persistence.loadBackup('nope');

      expect(loaded).toBeUndefined();

      await persistence.stop();
    });

    it('returns full backup data with bucket states', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('users', usersDef);
      await insertRecord(ref, { name: 'Alice' });
      await insertRecord(ref, { name: 'Bob' });
      persistence.registerBucket('users', ref);

      await persistence.createBackup('snap');

      const loaded = await persistence.loadBackup('snap');

      expect(loaded).toBeDefined();
      expect(loaded!.meta.name).toBe('snap');
      expect(loaded!.meta.totalRecords).toBe(2);
      expect(loaded!.buckets['users']).toBeDefined();
      expect(loaded!.buckets['users']!.records).toHaveLength(2);
      expect(loaded!.buckets['users']!.autoincrementCounter).toBe(2);

      await persistence.stop();
    });
  });

  describe('deleteBackup', () => {
    it('returns false for non-existent backup', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const result = await persistence.deleteBackup('nope');

      expect(result).toBe(false);

      await persistence.stop();
    });

    it('deletes an existing backup', async () => {
      const adapter = new MemoryAdapter();
      const persistence = new StorePersistence('test', { adapter, debounceMs: 60_000 });
      await persistence.start(eventBusRef);

      const ref = await startBucket('users', usersDef);
      persistence.registerBucket('users', ref);

      await persistence.createBackup('snap');
      const result = await persistence.deleteBackup('snap');

      expect(result).toBe(true);

      const loaded = await persistence.loadBackup('snap');
      expect(loaded).toBeUndefined();

      const list = await persistence.listBackups();
      expect(list).toHaveLength(0);

      await persistence.stop();
    });
  });
});
