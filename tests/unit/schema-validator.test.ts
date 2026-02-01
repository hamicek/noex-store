import { describe, it, expect, vi } from 'vitest';
import {
  SchemaValidator,
  ValidationError,
} from '../../src/core/schema-validator.js';
import type { SchemaDefinition } from '../../src/types/index.js';

// ── Helpers ──────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CUID_RE = /^c[0-9a-f]{32}$/;

function makeValidator(
  schema: SchemaDefinition,
  keyField = 'id',
  bucketName = 'test',
): SchemaValidator {
  return new SchemaValidator(bucketName, schema, keyField);
}

// ── prepareInsert ────────────────────────────────────────────────

describe('SchemaValidator.prepareInsert', () => {
  describe('generated fields', () => {
    it('generates a uuid when the field is missing', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
      });
      const record = v.prepareInsert({}, 1);
      expect(record.id).toMatch(UUID_RE);
    });

    it('generates a cuid when the field is missing', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'cuid' },
      });
      const record = v.prepareInsert({}, 1);
      expect(record.id).toMatch(CUID_RE);
    });

    it('generates a timestamp when the field is missing', () => {
      const before = Date.now();
      const v = makeValidator({
        id: { type: 'number', generated: 'autoincrement' },
        createdAt: { type: 'date', generated: 'timestamp' },
      });
      const record = v.prepareInsert({}, 1);
      const after = Date.now();
      expect(record.createdAt).toBeGreaterThanOrEqual(before);
      expect(record.createdAt).toBeLessThanOrEqual(after);
    });

    it('uses the autoincrement counter', () => {
      const v = makeValidator({
        id: { type: 'number', generated: 'autoincrement' },
      });
      expect(v.prepareInsert({}, 1).id).toBe(1);
      expect(v.prepareInsert({}, 42).id).toBe(42);
    });

    it('does not overwrite an explicitly provided generated field', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
      });
      const record = v.prepareInsert({ id: 'custom-id' }, 1);
      expect(record.id).toBe('custom-id');
    });
  });

  describe('defaults', () => {
    it('applies a static default', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
        role: { type: 'string', default: 'user' },
      });
      const record = v.prepareInsert({}, 1);
      expect(record.role).toBe('user');
    });

    it('applies a function default', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
        tags: { type: 'array', default: () => [] },
      });
      const r1 = v.prepareInsert({}, 1);
      const r2 = v.prepareInsert({}, 2);
      expect(r1.tags).toEqual([]);
      expect(r1.tags).not.toBe(r2.tags); // distinct array instances
    });

    it('does not overwrite an explicitly provided value with default', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
        role: { type: 'string', default: 'user' },
      });
      const record = v.prepareInsert({ role: 'admin' }, 1);
      expect(record.role).toBe('admin');
    });

    it('applies default after generation (generation takes priority)', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid', default: 'fallback' },
      });
      const record = v.prepareInsert({}, 1);
      expect(record.id).toMatch(UUID_RE); // generated, not default
    });
  });

  describe('meta fields', () => {
    it('sets _version to 1', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
      });
      const record = v.prepareInsert({}, 1);
      expect(record._version).toBe(1);
    });

    it('sets _createdAt and _updatedAt to the same timestamp', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
      });
      const record = v.prepareInsert({}, 1);
      expect(typeof record._createdAt).toBe('number');
      expect(record._createdAt).toBe(record._updatedAt);
    });
  });

  describe('extra fields', () => {
    it('preserves fields not defined in the schema', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
      });
      const record = v.prepareInsert({ extra: 'data', nested: { a: 1 } }, 1);
      expect(record.extra).toBe('data');
      expect(record.nested).toEqual({ a: 1 });
    });
  });

  describe('empty schema', () => {
    it('produces a valid record with only meta fields', () => {
      const v = makeValidator({}, '_nokey');
      const record = v.prepareInsert({}, 1);
      expect(record._version).toBe(1);
      expect(typeof record._createdAt).toBe('number');
      expect(typeof record._updatedAt).toBe('number');
    });
  });
});

// ── prepareInsert validation ─────────────────────────────────────

describe('SchemaValidator.prepareInsert validation', () => {
  it('rejects missing required fields', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
    });
    expect(() => v.prepareInsert({}, 1)).toThrow(ValidationError);
    try {
      v.prepareInsert({}, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues).toHaveLength(1);
      expect(ve.issues[0]!.field).toBe('name');
      expect(ve.issues[0]!.code).toBe('required');
    }
  });

  it('rejects type mismatch (string expected, number given)', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
    });
    expect(() => v.prepareInsert({ name: 123 }, 1)).toThrow(ValidationError);
    try {
      v.prepareInsert({ name: 123 }, 1);
    } catch (err) {
      expect((err as ValidationError).issues[0]!.code).toBe('type');
    }
  });

  it('rejects NaN for number type', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      age: { type: 'number' },
    });
    expect(() => v.prepareInsert({ age: NaN }, 1)).toThrow(ValidationError);
  });

  it('rejects invalid enum value', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      tier: { type: 'string', enum: ['basic', 'vip'] },
    });
    expect(() => v.prepareInsert({ tier: 'premium' }, 1)).toThrow(ValidationError);
    try {
      v.prepareInsert({ tier: 'premium' }, 1);
    } catch (err) {
      expect((err as ValidationError).issues[0]!.code).toBe('enum');
    }
  });

  it('accepts a valid enum value', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      tier: { type: 'string', enum: ['basic', 'vip'] },
    });
    const record = v.prepareInsert({ tier: 'vip' }, 1);
    expect(record.tier).toBe('vip');
  });

  it('rejects string shorter than minLength', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true, minLength: 2 },
    });
    expect(() => v.prepareInsert({ name: 'A' }, 1)).toThrow(ValidationError);
    try {
      v.prepareInsert({ name: 'A' }, 1);
    } catch (err) {
      expect((err as ValidationError).issues[0]!.code).toBe('minLength');
    }
  });

  it('rejects string longer than maxLength', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      code: { type: 'string', maxLength: 3 },
    });
    expect(() => v.prepareInsert({ code: 'ABCDE' }, 1)).toThrow(ValidationError);
    try {
      v.prepareInsert({ code: 'ABCDE' }, 1);
    } catch (err) {
      expect((err as ValidationError).issues[0]!.code).toBe('maxLength');
    }
  });

  it('rejects number below min', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      age: { type: 'number', min: 0 },
    });
    expect(() => v.prepareInsert({ age: -1 }, 1)).toThrow(ValidationError);
    try {
      v.prepareInsert({ age: -1 }, 1);
    } catch (err) {
      expect((err as ValidationError).issues[0]!.code).toBe('min');
    }
  });

  it('rejects number above max', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      score: { type: 'number', max: 100 },
    });
    expect(() => v.prepareInsert({ score: 101 }, 1)).toThrow(ValidationError);
    try {
      v.prepareInsert({ score: 101 }, 1);
    } catch (err) {
      expect((err as ValidationError).issues[0]!.code).toBe('max');
    }
  });

  it('rejects invalid email format', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      email: { type: 'string', format: 'email' },
    });
    expect(() => v.prepareInsert({ email: 'not-an-email' }, 1)).toThrow(ValidationError);
    try {
      v.prepareInsert({ email: 'not-an-email' }, 1);
    } catch (err) {
      expect((err as ValidationError).issues[0]!.code).toBe('format');
    }
  });

  it('accepts a valid email format', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      email: { type: 'string', format: 'email' },
    });
    const record = v.prepareInsert({ email: 'user@example.com' }, 1);
    expect(record.email).toBe('user@example.com');
  });

  it('rejects invalid url format', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      website: { type: 'string', format: 'url' },
    });
    expect(() => v.prepareInsert({ website: 'not-a-url' }, 1)).toThrow(ValidationError);
  });

  it('rejects invalid iso-date format', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      born: { type: 'string', format: 'iso-date' },
    });
    expect(() => v.prepareInsert({ born: '2024-13-99' }, 1)).toThrow(ValidationError);
  });

  it('accepts a valid iso-date format', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      born: { type: 'string', format: 'iso-date' },
    });
    const record = v.prepareInsert({ born: '2024-01-15' }, 1);
    expect(record.born).toBe('2024-01-15');
  });

  it('rejects value not matching pattern', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      code: { type: 'string', pattern: '^[A-Z]{3}$' },
    });
    expect(() => v.prepareInsert({ code: 'ab1' }, 1)).toThrow(ValidationError);
    try {
      v.prepareInsert({ code: 'ab1' }, 1);
    } catch (err) {
      expect((err as ValidationError).issues[0]!.code).toBe('pattern');
    }
  });

  it('accepts value matching pattern', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      code: { type: 'string', pattern: '^[A-Z]{3}$' },
    });
    const record = v.prepareInsert({ code: 'ABC' }, 1);
    expect(record.code).toBe('ABC');
  });

  it('collects multiple validation issues at once', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
      age: { type: 'number', min: 0 },
    });
    try {
      v.prepareInsert({ age: -5 }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues.length).toBeGreaterThanOrEqual(2);
      const codes = ve.issues.map((i) => i.code);
      expect(codes).toContain('required');
      expect(codes).toContain('min');
    }
  });

  describe('type checking for all FieldTypes', () => {
    it('validates boolean type', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
        active: { type: 'boolean' },
      });
      expect(v.prepareInsert({ active: true }, 1).active).toBe(true);
      expect(() => v.prepareInsert({ active: 'yes' }, 1)).toThrow(ValidationError);
    });

    it('validates object type', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
        meta: { type: 'object' },
      });
      expect(v.prepareInsert({ meta: { a: 1 } }, 1).meta).toEqual({ a: 1 });
      expect(() => v.prepareInsert({ meta: [1] }, 1)).toThrow(ValidationError);
      expect(() => v.prepareInsert({ meta: null }, 1)).not.toThrow(); // null → absent → ok (not required)
    });

    it('validates array type', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
        tags: { type: 'array' },
      });
      expect(v.prepareInsert({ tags: [1, 2] }, 1).tags).toEqual([1, 2]);
      expect(() => v.prepareInsert({ tags: 'oops' }, 1)).toThrow(ValidationError);
    });

    it('validates date type (number, Date, string)', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
        at: { type: 'date' },
      });
      expect(v.prepareInsert({ at: 1700000000 }, 1).at).toBe(1700000000);
      expect(v.prepareInsert({ at: new Date('2024-01-01') }, 1).at).toBeInstanceOf(Date);
      expect(v.prepareInsert({ at: '2024-01-01' }, 1).at).toBe('2024-01-01');
      expect(() => v.prepareInsert({ at: true }, 1)).toThrow(ValidationError);
    });

    it('rejects invalid Date object', () => {
      const v = makeValidator({
        id: { type: 'string', generated: 'uuid' },
        at: { type: 'date' },
      });
      expect(() => v.prepareInsert({ at: new Date('invalid') }, 1)).toThrow(ValidationError);
    });
  });
});

// ── prepareUpdate ────────────────────────────────────────────────

describe('SchemaValidator.prepareUpdate', () => {
  const schema: SchemaDefinition = {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true, minLength: 1 },
    tier: { type: 'string', enum: ['basic', 'vip'], default: 'basic' },
  };

  function makeExisting(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      id: 'existing-uuid',
      name: 'Alice',
      tier: 'basic',
      _version: 1,
      _createdAt: now - 10_000,
      _updatedAt: now - 10_000,
      ...overrides,
    } as import('../../src/types/index.js').StoreRecord;
  }

  it('increments _version', () => {
    const v = makeValidator(schema);
    const updated = v.prepareUpdate(makeExisting(), { name: 'Bob' });
    expect(updated._version).toBe(2);
  });

  it('updates _updatedAt to a recent timestamp', () => {
    const v = makeValidator(schema);
    const before = Date.now();
    const updated = v.prepareUpdate(makeExisting(), { name: 'Bob' });
    const after = Date.now();
    expect(updated._updatedAt).toBeGreaterThanOrEqual(before);
    expect(updated._updatedAt).toBeLessThanOrEqual(after);
  });

  it('preserves _createdAt from the existing record', () => {
    const v = makeValidator(schema);
    const existing = makeExisting();
    const updated = v.prepareUpdate(existing, { name: 'Bob' });
    expect(updated._createdAt).toBe(existing._createdAt);
  });

  it('strips generated fields from changes', () => {
    const v = makeValidator(schema);
    const existing = makeExisting();
    const updated = v.prepareUpdate(existing, { id: 'hacked-uuid', name: 'Bob' });
    expect(updated.id).toBe('existing-uuid');
  });

  it('strips the primary key from changes', () => {
    const v = makeValidator(schema);
    const existing = makeExisting();
    const updated = v.prepareUpdate(existing, { id: 'new-id', name: 'Charlie' });
    expect(updated.id).toBe('existing-uuid');
  });

  it('strips meta fields from changes', () => {
    const v = makeValidator(schema);
    const existing = makeExisting();
    const updated = v.prepareUpdate(existing, {
      name: 'Bob',
      _version: 999,
      _createdAt: 0,
      _updatedAt: 0,
    });
    expect(updated._version).toBe(2); // incremented, not 999
    expect(updated._createdAt).toBe(existing._createdAt); // preserved
  });

  it('merges changes into the existing record', () => {
    const v = makeValidator(schema);
    const updated = v.prepareUpdate(makeExisting(), { tier: 'vip' });
    expect(updated.name).toBe('Alice'); // preserved
    expect(updated.tier).toBe('vip'); // changed
  });

  it('validates the merged record', () => {
    const v = makeValidator(schema);
    expect(() => v.prepareUpdate(makeExisting(), { name: '' })).toThrow(ValidationError);
  });

  it('handles consecutive version bumps', () => {
    const v = makeValidator(schema);
    const v1 = v.prepareUpdate(makeExisting({ _version: 5 }), { name: 'V6' });
    expect(v1._version).toBe(6);
    const v2 = v.prepareUpdate(v1, { name: 'V7' });
    expect(v2._version).toBe(7);
  });
});

// ── ValidationError ──────────────────────────────────────────────

describe('ValidationError', () => {
  it('is an instance of Error', () => {
    const err = new ValidationError('test', [
      { field: 'f', message: 'm', code: 'c' },
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('has the correct name', () => {
    const err = new ValidationError('test', [
      { field: 'f', message: 'm', code: 'c' },
    ]);
    expect(err.name).toBe('ValidationError');
  });

  it('includes bucket name and field info in message', () => {
    const err = new ValidationError('users', [
      { field: 'email', message: 'bad', code: 'format' },
    ]);
    expect(err.message).toContain('users');
    expect(err.message).toContain('email');
  });

  it('exposes readonly issues array', () => {
    const issues = [{ field: 'a', message: 'b', code: 'c' }] as const;
    const err = new ValidationError('t', issues);
    expect(err.issues).toEqual(issues);
  });
});
