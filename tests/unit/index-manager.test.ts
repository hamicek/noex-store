import { describe, it, expect, beforeEach } from 'vitest';
import { IndexManager } from '../../src/core/index-manager.js';
import { UniqueConstraintError } from '../../src/core/store.js';
import type { SchemaDefinition } from '../../src/types/index.js';

// ── Helpers ──────────────────────────────────────────────────────

const schema: SchemaDefinition = {
  id: { type: 'string', generated: 'uuid' },
  email: { type: 'string', unique: true },
  name: { type: 'string', required: true },
  tier: { type: 'string', enum: ['basic', 'vip'] },
  code: { type: 'string', unique: true },
};

function makeManager(
  indexedFields: readonly string[] = ['email', 'tier'],
  overrideSchema: SchemaDefinition = schema,
): IndexManager {
  return new IndexManager('test', indexedFields, overrideSchema);
}

// ── Construction ────────────────────────────────────────────────

describe('IndexManager — construction', () => {
  it('creates indexes for explicitly listed fields', () => {
    const mgr = makeManager(['email', 'tier']);
    expect(mgr.isIndexed('email')).toBe(true);
    expect(mgr.isIndexed('tier')).toBe(true);
  });

  it('creates unique index for fields with unique: true even when not in indexedFields', () => {
    // 'code' has unique: true in schema but is not in indexedFields
    const mgr = makeManager(['tier']);
    expect(mgr.isIndexed('code')).toBe(true);
    expect(mgr.isIndexed('email')).toBe(true); // also unique: true
  });

  it('does not create index for non-indexed, non-unique fields', () => {
    const mgr = makeManager(['tier']);
    expect(mgr.isIndexed('name')).toBe(false);
  });

  it('works with empty indexedFields', () => {
    const mgr = makeManager([]);
    // unique fields still get indexed
    expect(mgr.isIndexed('email')).toBe(true);
    expect(mgr.isIndexed('code')).toBe(true);
    expect(mgr.isIndexed('tier')).toBe(false);
  });
});

// ── addRecord + lookup (non-unique) ─────────────────────────────

describe('IndexManager — addRecord + lookup (non-unique)', () => {
  let mgr: IndexManager;

  beforeEach(() => {
    mgr = makeManager();
  });

  it('indexes a single record and looks it up', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    expect(mgr.lookup('tier', 'vip')).toEqual(['k1']);
  });

  it('indexes multiple records with the same value', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    mgr.addRecord('k2', { id: 'k2', email: 'b@x.cz', name: 'B', tier: 'vip' });
    const keys = mgr.lookup('tier', 'vip')!;
    expect(keys).toHaveLength(2);
    expect(keys).toContain('k1');
    expect(keys).toContain('k2');
  });

  it('returns empty array for value with no matches', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    expect(mgr.lookup('tier', 'basic')).toEqual([]);
  });

  it('skips undefined field values', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A' });
    expect(mgr.lookup('tier', undefined)).toEqual([]);
  });

  it('skips null field values', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: null });
    expect(mgr.lookup('tier', null)).toEqual([]);
  });

  it('returns undefined for non-indexed field', () => {
    expect(mgr.lookup('name', 'Alice')).toBeUndefined();
  });
});

// ── addRecord + lookup (unique) ─────────────────────────────────

describe('IndexManager — addRecord + lookup (unique)', () => {
  let mgr: IndexManager;

  beforeEach(() => {
    mgr = makeManager();
  });

  it('indexes a record by unique field', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    expect(mgr.lookup('email', 'a@x.cz')).toEqual(['k1']);
  });

  it('throws UniqueConstraintError on duplicate value', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A' });
    expect(() =>
      mgr.addRecord('k2', { id: 'k2', email: 'a@x.cz', name: 'B' }),
    ).toThrow(UniqueConstraintError);
  });

  it('includes bucket, field, and value in UniqueConstraintError', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A' });
    try {
      mgr.addRecord('k2', { id: 'k2', email: 'a@x.cz', name: 'B' });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UniqueConstraintError);
      const e = err as UniqueConstraintError;
      expect(e.bucket).toBe('test');
      expect(e.field).toBe('email');
      expect(e.value).toBe('a@x.cz');
    }
  });

  it('allows multiple records with null in unique field', () => {
    mgr.addRecord('k1', { id: 'k1', email: null, name: 'A' });
    mgr.addRecord('k2', { id: 'k2', email: null, name: 'B' });
    expect(mgr.lookup('email', null)).toEqual([]);
  });

  it('allows multiple records with undefined in unique field', () => {
    mgr.addRecord('k1', { id: 'k1', name: 'A' });
    mgr.addRecord('k2', { id: 'k2', name: 'B' });
    expect(mgr.lookup('email', undefined)).toEqual([]);
  });

  it('does not write to any index when unique check fails', () => {
    // 'code' is unique, 'tier' is non-unique — both are indexed
    const mgr2 = makeManager(['email', 'tier', 'code']);
    mgr2.addRecord('k1', { id: 'k1', email: 'a@x.cz', code: 'ABC', tier: 'vip' });

    // Second record collides on 'email', so nothing should be written
    expect(() =>
      mgr2.addRecord('k2', { id: 'k2', email: 'a@x.cz', code: 'DEF', tier: 'basic' }),
    ).toThrow(UniqueConstraintError);

    // tier index should still only have k1
    expect(mgr2.lookup('tier', 'basic')).toEqual([]);
    expect(mgr2.lookup('tier', 'vip')).toEqual(['k1']);
    // code index should still only have ABC
    expect(mgr2.lookup('code', 'DEF')).toEqual([]);
  });
});

// ── removeRecord ────────────────────────────────────────────────

describe('IndexManager — removeRecord', () => {
  let mgr: IndexManager;

  beforeEach(() => {
    mgr = makeManager();
  });

  it('removes record from unique index', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    mgr.removeRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    expect(mgr.lookup('email', 'a@x.cz')).toEqual([]);
  });

  it('removes record from non-unique index', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    mgr.removeRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    expect(mgr.lookup('tier', 'vip')).toEqual([]);
  });

  it('cleans up empty sets in non-unique index', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    mgr.addRecord('k2', { id: 'k2', email: 'b@x.cz', name: 'B', tier: 'vip' });
    mgr.removeRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    expect(mgr.lookup('tier', 'vip')).toEqual(['k2']);

    mgr.removeRecord('k2', { id: 'k2', email: 'b@x.cz', name: 'B', tier: 'vip' });
    expect(mgr.lookup('tier', 'vip')).toEqual([]);
  });

  it('allows re-insert of unique value after removal', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A' });
    mgr.removeRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A' });
    // Should not throw
    mgr.addRecord('k2', { id: 'k2', email: 'a@x.cz', name: 'B' });
    expect(mgr.lookup('email', 'a@x.cz')).toEqual(['k2']);
  });

  it('handles removal of record with null/undefined values gracefully', () => {
    mgr.addRecord('k1', { id: 'k1', name: 'A' }); // email & tier undefined
    // Should not throw
    mgr.removeRecord('k1', { id: 'k1', name: 'A' });
  });
});

// ── updateRecord ────────────────────────────────────────────────

describe('IndexManager — updateRecord', () => {
  let mgr: IndexManager;

  beforeEach(() => {
    mgr = makeManager();
  });

  it('updates non-unique index when value changes', () => {
    const old = { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'basic' };
    mgr.addRecord('k1', old);

    const updated = { ...old, tier: 'vip' };
    mgr.updateRecord('k1', old, updated);

    expect(mgr.lookup('tier', 'basic')).toEqual([]);
    expect(mgr.lookup('tier', 'vip')).toEqual(['k1']);
  });

  it('updates unique index when value changes', () => {
    const old = { id: 'k1', email: 'a@x.cz', name: 'A' };
    mgr.addRecord('k1', old);

    const updated = { ...old, email: 'new@x.cz' };
    mgr.updateRecord('k1', old, updated);

    expect(mgr.lookup('email', 'a@x.cz')).toEqual([]);
    expect(mgr.lookup('email', 'new@x.cz')).toEqual(['k1']);
  });

  it('is a no-op when value has not changed', () => {
    const rec = { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' };
    mgr.addRecord('k1', rec);
    // Same tier — should not throw or change anything
    mgr.updateRecord('k1', rec, { ...rec, name: 'B' });
    expect(mgr.lookup('tier', 'vip')).toEqual(['k1']);
    expect(mgr.lookup('email', 'a@x.cz')).toEqual(['k1']);
  });

  it('allows updating unique field to its own current value (excludeKey)', () => {
    const rec = { id: 'k1', email: 'a@x.cz', name: 'A' };
    mgr.addRecord('k1', rec);
    // email stays the same — strict equality, skipped entirely
    mgr.updateRecord('k1', rec, rec);
    expect(mgr.lookup('email', 'a@x.cz')).toEqual(['k1']);
  });

  it('throws UniqueConstraintError when updating to existing unique value', () => {
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A' });
    mgr.addRecord('k2', { id: 'k2', email: 'b@x.cz', name: 'B' });

    const old = { id: 'k2', email: 'b@x.cz', name: 'B' };
    const updated = { ...old, email: 'a@x.cz' };
    expect(() => mgr.updateRecord('k2', old, updated)).toThrow(UniqueConstraintError);
  });

  it('does not partially update indexes on unique violation', () => {
    const mgr2 = makeManager(['email', 'tier', 'code']);
    mgr2.addRecord('k1', { id: 'k1', email: 'a@x.cz', code: 'AAA', tier: 'vip' });
    mgr2.addRecord('k2', { id: 'k2', email: 'b@x.cz', code: 'BBB', tier: 'basic' });

    const old = { id: 'k2', email: 'b@x.cz', code: 'BBB', tier: 'basic' };
    const updated = { ...old, email: 'a@x.cz', tier: 'vip' }; // email collision

    expect(() => mgr2.updateRecord('k2', old, updated)).toThrow(UniqueConstraintError);

    // tier index should NOT have been updated
    expect(mgr2.lookup('tier', 'basic')).toEqual(['k2']);
    expect(mgr2.lookup('tier', 'vip')).toEqual(['k1']);
  });

  it('handles update from null to a value', () => {
    const old = { id: 'k1', name: 'A', tier: 'vip' }; // email undefined
    mgr.addRecord('k1', old);

    const updated = { ...old, email: 'a@x.cz' };
    mgr.updateRecord('k1', old, updated);
    expect(mgr.lookup('email', 'a@x.cz')).toEqual(['k1']);
  });

  it('handles update from a value to null', () => {
    const old = { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' };
    mgr.addRecord('k1', old);

    const updated = { ...old, email: null };
    mgr.updateRecord('k1', old, updated);
    expect(mgr.lookup('email', 'a@x.cz')).toEqual([]);
    expect(mgr.lookup('email', null)).toEqual([]);
  });
});

// ── clear ───────────────────────────────────────────────────────

describe('IndexManager — clear', () => {
  it('empties all indexes', () => {
    const mgr = makeManager();
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A', tier: 'vip' });
    mgr.addRecord('k2', { id: 'k2', email: 'b@x.cz', name: 'B', tier: 'basic' });

    mgr.clear();

    expect(mgr.lookup('email', 'a@x.cz')).toEqual([]);
    expect(mgr.lookup('email', 'b@x.cz')).toEqual([]);
    expect(mgr.lookup('tier', 'vip')).toEqual([]);
    expect(mgr.lookup('tier', 'basic')).toEqual([]);
  });

  it('allows new inserts after clear', () => {
    const mgr = makeManager();
    mgr.addRecord('k1', { id: 'k1', email: 'a@x.cz', name: 'A' });
    mgr.clear();
    // Re-insert same email — should not throw
    mgr.addRecord('k2', { id: 'k2', email: 'a@x.cz', name: 'B' });
    expect(mgr.lookup('email', 'a@x.cz')).toEqual(['k2']);
  });
});

// ── isIndexed ───────────────────────────────────────────────────

describe('IndexManager — isIndexed', () => {
  it('returns true for explicitly indexed field', () => {
    const mgr = makeManager(['tier']);
    expect(mgr.isIndexed('tier')).toBe(true);
  });

  it('returns true for implicitly indexed unique field', () => {
    const mgr = makeManager([]);
    expect(mgr.isIndexed('email')).toBe(true);
  });

  it('returns false for non-indexed, non-unique field', () => {
    const mgr = makeManager([]);
    expect(mgr.isIndexed('name')).toBe(false);
  });

  it('returns false for non-existent field', () => {
    const mgr = makeManager([]);
    expect(mgr.isIndexed('nope')).toBe(false);
  });
});
