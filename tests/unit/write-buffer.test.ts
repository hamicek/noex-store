import { describe, it, expect } from 'vitest';
import type { StoreRecord } from '../../src/types/index.js';
import { BucketWriteBuffer, WriteBuffer } from '../../src/transaction/write-buffer.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeRecord(fields: Record<string, unknown>, version = 1): StoreRecord {
  const now = Date.now();
  return {
    ...fields,
    _version: version,
    _createdAt: now,
    _updatedAt: now,
  } as StoreRecord;
}

// ── BucketWriteBuffer ────────────────────────────────────────────

describe('BucketWriteBuffer', () => {
  describe('addInsert', () => {
    it('stores record in inserts map', () => {
      const buf = new BucketWriteBuffer();
      const record = makeRecord({ id: 'k1', name: 'Alice' });

      buf.addInsert('k1', record);

      expect(buf.inserts.get('k1')).toBe(record);
      expect(buf.ops).toHaveLength(1);
      expect(buf.ops[0]!.type).toBe('insert');
    });

    it('overrides a previous delete of the same key', () => {
      const buf = new BucketWriteBuffer();
      const original = makeRecord({ id: 'k1', name: 'Alice' });
      const reinserted = makeRecord({ id: 'k1', name: 'Bob' });

      buf.addDelete('k1', original);
      expect(buf.deletes.has('k1')).toBe(true);

      buf.addInsert('k1', reinserted);
      expect(buf.deletes.has('k1')).toBe(false);
      expect(buf.inserts.get('k1')).toBe(reinserted);
    });
  });

  describe('addUpdate', () => {
    it('stores record in updates map for existing real records', () => {
      const buf = new BucketWriteBuffer();
      const old = makeRecord({ id: 'k1', name: 'Alice' });
      const updated = makeRecord({ id: 'k1', name: 'Bob' }, 2);

      buf.addUpdate('k1', old, updated);

      expect(buf.updates.get('k1')).toBe(updated);
      expect(buf.inserts.has('k1')).toBe(false);
      expect(buf.ops).toHaveLength(1);
      expect(buf.ops[0]!.type).toBe('update');
    });

    it('updates insert in-place when updating a previously inserted key', () => {
      const buf = new BucketWriteBuffer();
      const inserted = makeRecord({ id: 'k1', name: 'Alice' });
      const updated = makeRecord({ id: 'k1', name: 'Bob' }, 2);

      buf.addInsert('k1', inserted);
      buf.addUpdate('k1', inserted, updated);

      expect(buf.inserts.get('k1')).toBe(updated);
      expect(buf.updates.has('k1')).toBe(false);
    });

    it('records expectedVersion from oldRecord', () => {
      const buf = new BucketWriteBuffer();
      const old = makeRecord({ id: 'k1' }, 3);
      const updated = makeRecord({ id: 'k1' }, 4);

      buf.addUpdate('k1', old, updated);

      const op = buf.ops[0]!;
      expect(op.type).toBe('update');
      if (op.type === 'update') {
        expect(op.expectedVersion).toBe(3);
      }
    });
  });

  describe('addDelete', () => {
    it('stores record in deletes map', () => {
      const buf = new BucketWriteBuffer();
      const record = makeRecord({ id: 'k1', name: 'Alice' });

      buf.addDelete('k1', record);

      expect(buf.deletes.has('k1')).toBe(true);
      expect(buf.deletes.get('k1')).toBe(record);
      expect(buf.ops).toHaveLength(1);
      expect(buf.ops[0]!.type).toBe('delete');
    });

    it('removes insert when deleting a previously inserted key (net-zero)', () => {
      const buf = new BucketWriteBuffer();
      const record = makeRecord({ id: 'k1', name: 'Alice' });

      buf.addInsert('k1', record);
      expect(buf.inserts.has('k1')).toBe(true);

      buf.addDelete('k1', record);
      expect(buf.inserts.has('k1')).toBe(false);
      expect(buf.deletes.has('k1')).toBe(false);
    });

    it('removes previous update and adds delete', () => {
      const buf = new BucketWriteBuffer();
      const old = makeRecord({ id: 'k1', name: 'Alice' });
      const updated = makeRecord({ id: 'k1', name: 'Bob' }, 2);

      buf.addUpdate('k1', old, updated);
      expect(buf.updates.has('k1')).toBe(true);

      buf.addDelete('k1', old);
      expect(buf.updates.has('k1')).toBe(false);
      expect(buf.deletes.has('k1')).toBe(true);
    });

    it('records expectedVersion from record', () => {
      const buf = new BucketWriteBuffer();
      const record = makeRecord({ id: 'k1' }, 5);

      buf.addDelete('k1', record);

      const op = buf.ops[0]!;
      expect(op.type).toBe('delete');
      if (op.type === 'delete') {
        expect(op.expectedVersion).toBe(5);
      }
    });
  });

  describe('getOverlay', () => {
    it('returns StoreRecord for inserted key', () => {
      const buf = new BucketWriteBuffer();
      const record = makeRecord({ id: 'k1', name: 'Alice' });

      buf.addInsert('k1', record);

      expect(buf.getOverlay('k1')).toBe(record);
    });

    it('returns StoreRecord for updated key', () => {
      const buf = new BucketWriteBuffer();
      const old = makeRecord({ id: 'k1', name: 'Alice' });
      const updated = makeRecord({ id: 'k1', name: 'Bob' }, 2);

      buf.addUpdate('k1', old, updated);

      expect(buf.getOverlay('k1')).toBe(updated);
    });

    it('returns null for deleted key', () => {
      const buf = new BucketWriteBuffer();
      const record = makeRecord({ id: 'k1', name: 'Alice' });

      buf.addDelete('k1', record);

      expect(buf.getOverlay('k1')).toBeNull();
    });

    it('returns undefined for key not in buffer', () => {
      const buf = new BucketWriteBuffer();

      expect(buf.getOverlay('unknown')).toBeUndefined();
    });

    it('prioritizes deletes over inserts/updates', () => {
      const buf = new BucketWriteBuffer();
      const record = makeRecord({ id: 'k1', name: 'Alice' });

      // Simulate: real record exists, was updated, then deleted
      buf.addUpdate('k1', record, makeRecord({ id: 'k1', name: 'Bob' }, 2));
      buf.addDelete('k1', record);

      expect(buf.getOverlay('k1')).toBeNull();
    });
  });

  describe('isEmpty', () => {
    it('returns true for a fresh buffer', () => {
      const buf = new BucketWriteBuffer();
      expect(buf.isEmpty).toBe(true);
    });

    it('returns false after insert', () => {
      const buf = new BucketWriteBuffer();
      buf.addInsert('k1', makeRecord({ id: 'k1' }));
      expect(buf.isEmpty).toBe(false);
    });

    it('returns false after update', () => {
      const buf = new BucketWriteBuffer();
      buf.addUpdate('k1', makeRecord({ id: 'k1' }), makeRecord({ id: 'k1' }, 2));
      expect(buf.isEmpty).toBe(false);
    });

    it('returns false after delete', () => {
      const buf = new BucketWriteBuffer();
      buf.addDelete('k1', makeRecord({ id: 'k1' }));
      expect(buf.isEmpty).toBe(false);
    });

    it('returns true after insert then delete of same key (net-zero)', () => {
      const buf = new BucketWriteBuffer();
      const record = makeRecord({ id: 'k1' });

      buf.addInsert('k1', record);
      buf.addDelete('k1', record);

      expect(buf.isEmpty).toBe(true);
    });
  });
});

// ── WriteBuffer ──────────────────────────────────────────────────

describe('WriteBuffer', () => {
  describe('forBucket', () => {
    it('creates a new BucketWriteBuffer on first access', () => {
      const wb = new WriteBuffer();
      const buf = wb.forBucket('users');

      expect(buf).toBeInstanceOf(BucketWriteBuffer);
    });

    it('returns the same instance on subsequent access', () => {
      const wb = new WriteBuffer();
      const first = wb.forBucket('users');
      const second = wb.forBucket('users');

      expect(first).toBe(second);
    });

    it('returns different instances for different bucket names', () => {
      const wb = new WriteBuffer();
      const users = wb.forBucket('users');
      const orders = wb.forBucket('orders');

      expect(users).not.toBe(orders);
    });
  });

  describe('getBucketNames', () => {
    it('returns empty array when no buckets accessed', () => {
      const wb = new WriteBuffer();
      expect(wb.getBucketNames()).toEqual([]);
    });

    it('returns names of accessed buckets', () => {
      const wb = new WriteBuffer();
      wb.forBucket('users');
      wb.forBucket('orders');

      const names = wb.getBucketNames();
      expect(names).toHaveLength(2);
      expect(names).toContain('users');
      expect(names).toContain('orders');
    });
  });

  describe('getBucket', () => {
    it('returns undefined for non-existing bucket', () => {
      const wb = new WriteBuffer();
      expect(wb.getBucket('nonexistent')).toBeUndefined();
    });

    it('returns the buffer for an existing bucket', () => {
      const wb = new WriteBuffer();
      const created = wb.forBucket('users');
      const fetched = wb.getBucket('users');

      expect(fetched).toBe(created);
    });
  });

  describe('isEmpty', () => {
    it('returns true when no buckets accessed', () => {
      const wb = new WriteBuffer();
      expect(wb.isEmpty).toBe(true);
    });

    it('returns true when buckets accessed but no operations', () => {
      const wb = new WriteBuffer();
      wb.forBucket('users');
      expect(wb.isEmpty).toBe(true);
    });

    it('returns false when any bucket has operations', () => {
      const wb = new WriteBuffer();
      const buf = wb.forBucket('users');
      buf.addInsert('k1', makeRecord({ id: 'k1' }));

      expect(wb.isEmpty).toBe(false);
    });

    it('returns true when all net operations cancel out', () => {
      const wb = new WriteBuffer();
      const buf = wb.forBucket('users');
      const record = makeRecord({ id: 'k1' });
      buf.addInsert('k1', record);
      buf.addDelete('k1', record);

      expect(wb.isEmpty).toBe(true);
    });
  });
});
