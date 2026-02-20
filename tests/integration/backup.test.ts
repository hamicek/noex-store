import { describe, it, expect, afterEach, vi } from 'vitest';
import { MemoryAdapter } from '@hamicek/noex';
import { Store, PersistenceRequiredError, BackupNotFoundError, UniqueConstraintError } from '../../src/core/store.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const usersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    email: { type: 'string', format: 'email', unique: true },
  },
  indexes: ['email'],
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    product: { type: 'string', required: true },
    quantity: { type: 'number', required: true, min: 1 },
  },
};

// ── Helpers ──────────────────────────────────────────────────────

const stores: Store[] = [];

async function startStore(adapter: MemoryAdapter, name = 'test'): Promise<Store> {
  const s = await Store.start({ name, persistence: { adapter } });
  stores.push(s);
  return s;
}

afterEach(async () => {
  for (const s of stores.splice(0)) {
    await s.stop();
  }
});

// ── 1. Basic backup/restore ──────────────────────────────────────

describe('backup: basic lifecycle', () => {
  it('creates and restores a backup', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    const alice = await store.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });
    const bob = await store.bucket('users').insert({ name: 'Bob', email: 'bob@x.cz' });

    // Create backup
    const backup = await store.createBackup('before-changes');
    expect(backup.name).toBe('before-changes');
    expect(backup.totalRecords).toBe(2);
    expect(backup.bucketNames).toContain('users');

    // Modify data
    await store.bucket('users').update(alice.id, { name: 'Alice Updated' });
    await store.bucket('users').delete(bob.id);
    await store.bucket('users').insert({ name: 'Carol', email: 'carol@x.cz' });

    expect(await store.bucket('users').count()).toBe(2);

    // Restore backup
    await store.restoreBackup('before-changes');

    expect(await store.bucket('users').count()).toBe(2);
    const restoredAlice = await store.bucket('users').get(alice.id);
    expect(restoredAlice).toBeDefined();
    expect(restoredAlice!.name).toBe('Alice');
    const restoredBob = await store.bucket('users').get(bob.id);
    expect(restoredBob).toBeDefined();
    expect(restoredBob!.name).toBe('Bob');
  });
});

// ── 2. Multi-bucket backup ──────────────────────────────────────

describe('backup: multiple buckets', () => {
  it('backs up and restores multiple buckets', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);
    await store.defineBucket('orders', ordersDef);

    await store.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });
    await store.bucket('orders').insert({ product: 'Widget', quantity: 3 });
    await store.bucket('orders').insert({ product: 'Gadget', quantity: 1 });

    await store.createBackup('full');

    // Clear everything
    await store.bucket('users').clear();
    await store.bucket('orders').clear();
    expect(await store.bucket('users').count()).toBe(0);
    expect(await store.bucket('orders').count()).toBe(0);

    // Restore
    await store.restoreBackup('full');

    expect(await store.bucket('users').count()).toBe(1);
    expect(await store.bucket('orders').count()).toBe(2);
    const orders = await store.bucket('orders').all();
    expect(orders.map(o => o.product).sort()).toEqual(['Gadget', 'Widget']);
  });
});

// ── 3. Indexes after restore ─────────────────────────────────────

describe('backup: indexes after restore', () => {
  it('rebuilds indexes correctly after restore', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    await store.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });
    await store.bucket('users').insert({ name: 'Bob', email: 'bob@x.cz' });

    await store.createBackup('with-indexes');

    await store.bucket('users').clear();
    await store.restoreBackup('with-indexes');

    // Index-accelerated lookup should work
    const byEmail = await store.bucket('users').where({ email: 'alice@x.cz' });
    expect(byEmail).toHaveLength(1);
    expect(byEmail[0]!.name).toBe('Alice');
  });

  it('restores unique constraints', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    await store.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });

    await store.createBackup('snap');
    await store.bucket('users').clear();
    await store.restoreBackup('snap');

    // Unique constraint should be enforced
    await expect(
      store.bucket('users').insert({ name: 'Fake', email: 'alice@x.cz' }),
    ).rejects.toThrow(UniqueConstraintError);
  });
});

// ── 4. Autoincrement continuity ──────────────────────────────────

describe('backup: autoincrement continuity', () => {
  it('restores autoincrement counter', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('orders', ordersDef);

    await store.bucket('orders').insert({ product: 'A', quantity: 1 });
    await store.bucket('orders').insert({ product: 'B', quantity: 1 });
    await store.bucket('orders').insert({ product: 'C', quantity: 1 });

    await store.createBackup('snap');

    // Insert more to advance the counter
    await store.bucket('orders').insert({ product: 'D', quantity: 1 });
    await store.bucket('orders').insert({ product: 'E', quantity: 1 });

    // Restore — counter should go back to 3
    await store.restoreBackup('snap');

    expect(await store.bucket('orders').count()).toBe(3);

    const newOrder = await store.bucket('orders').insert({ product: 'D', quantity: 1 });
    // Counter was 3 in the backup, new insert gets 4
    expect(newOrder.id).toBe(4);
  });
});

// ── 5. listBackups ───────────────────────────────────────────────

describe('backup: listBackups', () => {
  it('lists backups in chronological order', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    await store.createBackup('first');
    await store.createBackup('second');
    await store.createBackup('third');

    const list = await store.listBackups();

    expect(list).toHaveLength(3);
    expect(list.map(b => b.name)).toEqual(['first', 'second', 'third']);
  });

  it('returns empty array when no backups exist', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);

    const list = await store.listBackups();
    expect(list).toEqual([]);
  });
});

// ── 6. deleteBackup ──────────────────────────────────────────────

describe('backup: deleteBackup', () => {
  it('deletes an existing backup', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    await store.createBackup('snap');
    const deleted = await store.deleteBackup('snap');

    expect(deleted).toBe(true);

    const list = await store.listBackups();
    expect(list).toHaveLength(0);
  });

  it('returns false for non-existent backup', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);

    const deleted = await store.deleteBackup('nope');
    expect(deleted).toBe(false);
  });
});

// ── 7. Error handling ────────────────────────────────────────────

describe('backup: error handling', () => {
  it('throws PersistenceRequiredError when no persistence configured', async () => {
    const store = await Store.start({ name: 'no-persist' });
    stores.push(store);

    await expect(store.createBackup()).rejects.toThrow(PersistenceRequiredError);
    await expect(store.listBackups()).rejects.toThrow(PersistenceRequiredError);
    await expect(store.restoreBackup('snap')).rejects.toThrow(PersistenceRequiredError);
    await expect(store.deleteBackup('snap')).rejects.toThrow(PersistenceRequiredError);
  });

  it('throws BackupNotFoundError for non-existent backup on restore', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);

    await expect(store.restoreBackup('nonexistent')).rejects.toThrow(BackupNotFoundError);
  });
});

// ── 8. Auto-generated backup name ────────────────────────────────

describe('backup: auto-generated name', () => {
  it('generates a name when none is provided', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    const backup = await store.createBackup();

    expect(backup.name).toMatch(/^backup-\d+$/);
    expect(backup.id).toBe(backup.name);

    const list = await store.listBackups();
    expect(list).toHaveLength(1);
  });
});

// ── 9. Non-persistent buckets ────────────────────────────────────

describe('backup: non-persistent bucket', () => {
  it('does not include non-persistent buckets in backup', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);

    await store.defineBucket('users', usersDef);
    await store.defineBucket('cache', { ...ordersDef, persistent: false });

    await store.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });
    await store.bucket('cache').insert({ product: 'Temp', quantity: 1 });

    const backup = await store.createBackup('snap');

    expect(backup.bucketNames).toContain('users');
    expect(backup.bucketNames).not.toContain('cache');
    expect(backup.totalRecords).toBe(1);
  });
});

// ── 10. Restore skips unknown buckets ────────────────────────────

describe('backup: restore with missing buckets', () => {
  it('skips buckets in backup that do not exist in current store', async () => {
    const adapter = new MemoryAdapter();
    const store1 = await startStore(adapter, 'test');
    await store1.defineBucket('users', usersDef);
    await store1.defineBucket('orders', ordersDef);

    await store1.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });
    await store1.bucket('orders').insert({ product: 'Widget', quantity: 1 });

    await store1.createBackup('full');
    await store1.stop();
    stores.length = 0;

    // Start new store with only 'users' bucket
    const store2 = await startStore(adapter, 'test');
    await store2.defineBucket('users', usersDef);

    // Modify users
    await store2.bucket('users').insert({ name: 'Bob', email: 'bob@x.cz' });

    // Restore — should only restore 'users', skip 'orders'
    await store2.restoreBackup('full');

    expect(await store2.bucket('users').count()).toBe(1);
    const user = await store2.bucket('users').findOne({ name: 'Alice' });
    expect(user).toBeDefined();
  });
});

// ── 11. Restore leaves unmentioned buckets unchanged ─────────────

describe('backup: restore preserves non-backed-up buckets', () => {
  it('does not affect buckets that are not in the backup', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    await store.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });

    await store.createBackup('users-only');

    // Add another bucket AFTER the backup
    await store.defineBucket('orders', ordersDef);
    await store.bucket('orders').insert({ product: 'Widget', quantity: 1 });

    // Restore — should only touch 'users', orders should remain
    await store.restoreBackup('users-only');

    expect(await store.bucket('orders').count()).toBe(1);
  });
});

// ── 12. Reactive queries after restore ───────────────────────────

describe('backup: reactive queries after restore', () => {
  it('reactive queries see restored data on subsequent mutations', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    await store.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });
    await store.createBackup('snap');

    // Delete everything
    await store.bucket('users').clear();

    store.defineQuery('allUsers', async (ctx) =>
      ctx.bucket('users').all(),
    );

    const callback = vi.fn();
    await store.subscribe('allUsers', callback);

    // Restore
    await store.restoreBackup('snap');

    // Trigger re-evaluation
    await store.bucket('users').insert({ name: 'Bob', email: 'bob@x.cz' });
    await store.settle();

    expect(callback).toHaveBeenCalled();
    const lastCall = callback.mock.calls[callback.mock.calls.length - 1]![0] as StoreRecord[];
    expect(lastCall).toHaveLength(2);
    expect(lastCall.map(r => r.name).sort()).toEqual(['Alice', 'Bob']);
  });
});

// ── 13. Backup persists through store restart ────────────────────

describe('backup: survives store restart', () => {
  it('backups persist across store restarts', async () => {
    const adapter = new MemoryAdapter();
    const store1 = await startStore(adapter, 'test');
    await store1.defineBucket('users', usersDef);
    await store1.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });

    await store1.createBackup('persistent-snap');
    await store1.stop();
    stores.length = 0;

    // Restart store
    const store2 = await startStore(adapter, 'test');
    await store2.defineBucket('users', usersDef);

    const list = await store2.listBackups();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('persistent-snap');

    // Restore from the backup created before restart
    await store2.bucket('users').clear();
    await store2.restoreBackup('persistent-snap');

    expect(await store2.bucket('users').count()).toBe(1);
    const user = await store2.bucket('users').findOne({ name: 'Alice' });
    expect(user).toBeDefined();
  });
});

// ── 14. Flush before backup ──────────────────────────────────────

describe('backup: flushes pending changes', () => {
  it('createBackup flushes pending persistence before snapshotting', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    await store.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });

    // Backup should capture the insert even if debounce hasn't fired
    const backup = await store.createBackup('snap');
    expect(backup.totalRecords).toBe(1);
  });
});

// ── 15. Store functional after restore ───────────────────────────

describe('backup: store functional after restore', () => {
  it('all CRUD operations work after restore', async () => {
    const adapter = new MemoryAdapter();
    const store = await startStore(adapter);
    await store.defineBucket('users', usersDef);

    await store.bucket('users').insert({ name: 'Alice', email: 'alice@x.cz' });
    await store.createBackup('snap');

    await store.bucket('users').clear();
    await store.restoreBackup('snap');

    // Insert
    const bob = await store.bucket('users').insert({ name: 'Bob', email: 'bob@x.cz' });
    expect(bob.name).toBe('Bob');

    // Update
    const updated = await store.bucket('users').update(bob.id, { name: 'Bobby' });
    expect(updated.name).toBe('Bobby');

    // Delete
    await store.bucket('users').delete(bob.id);
    expect(await store.bucket('users').count()).toBe(1);

    // Where
    const alice = await store.bucket('users').findOne({ name: 'Alice' });
    expect(alice).toBeDefined();
  });
});
