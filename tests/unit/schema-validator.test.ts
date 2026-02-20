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

// ── Nested object validation ─────────────────────────────────────

describe('SchemaValidator nested object validation', () => {
  it('validates nested object properties', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      address: {
        type: 'object',
        properties: {
          street: { type: 'string', required: true },
          city: { type: 'string', required: true },
        },
      },
    });
    const record = v.prepareInsert(
      { address: { street: 'Main St', city: 'Prague' } },
      1,
    );
    expect(record.address).toEqual({ street: 'Main St', city: 'Prague' });
  });

  it('rejects missing required nested field with dot-notation path', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      address: {
        type: 'object',
        required: true,
        properties: {
          street: { type: 'string', required: true },
          city: { type: 'string', required: true },
        },
      },
    });
    try {
      v.prepareInsert({ address: { street: 'Main St' } }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues).toHaveLength(1);
      expect(ve.issues[0]!.field).toBe('address.city');
      expect(ve.issues[0]!.code).toBe('required');
    }
  });

  it('rejects type mismatch in nested field', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      address: {
        type: 'object',
        properties: {
          zip: { type: 'number' },
        },
      },
    });
    try {
      v.prepareInsert({ address: { zip: 'not-a-number' } }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues[0]!.field).toBe('address.zip');
      expect(ve.issues[0]!.code).toBe('type');
    }
  });

  it('validates constraints on nested fields', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      address: {
        type: 'object',
        properties: {
          zip: { type: 'string', pattern: '\\d{3}\\s?\\d{2}' },
        },
      },
    });
    expect(() =>
      v.prepareInsert({ address: { zip: 'ABCDE' } }, 1),
    ).toThrow(ValidationError);
    const record = v.prepareInsert({ address: { zip: '110 00' } }, 1);
    expect((record.address as Record<string, unknown>).zip).toBe('110 00');
  });

  it('skips nested validation when optional object is absent', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      address: {
        type: 'object',
        properties: {
          street: { type: 'string', required: true },
        },
      },
    });
    // address is optional and not provided — no error
    const record = v.prepareInsert({}, 1);
    expect(record.address).toBeUndefined();
  });

  it('skips nested validation when optional object is null', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      address: {
        type: 'object',
        properties: {
          street: { type: 'string', required: true },
        },
      },
    });
    const record = v.prepareInsert({ address: null }, 1);
    expect(record.address).toBeNull();
  });

  it('validates deeply nested objects (3 levels)', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      level1: {
        type: 'object',
        properties: {
          level2: {
            type: 'object',
            properties: {
              level3: { type: 'number', min: 0 },
            },
          },
        },
      },
    });
    try {
      v.prepareInsert({ level1: { level2: { level3: -1 } } }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues[0]!.field).toBe('level1.level2.level3');
      expect(ve.issues[0]!.code).toBe('min');
    }
  });

  it('object without properties is treated as opaque blob', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      meta: { type: 'object' },
    });
    // Any object shape is fine when no `properties` is defined
    const record = v.prepareInsert({ meta: { anything: true, goes: [1, 2] } }, 1);
    expect(record.meta).toEqual({ anything: true, goes: [1, 2] });
  });

  it('collects multiple nested issues at once', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      address: {
        type: 'object',
        required: true,
        properties: {
          street: { type: 'string', required: true },
          city: { type: 'string', required: true },
          zip: { type: 'string', pattern: '\\d{5}' },
        },
      },
    });
    try {
      v.prepareInsert({ address: { zip: 'XYZ' } }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      const fields = ve.issues.map((i) => i.field);
      expect(fields).toContain('address.street');
      expect(fields).toContain('address.city');
      expect(fields).toContain('address.zip');
    }
  });
});

// ── Nested array validation ──────────────────────────────────────

describe('SchemaValidator nested array validation', () => {
  it('validates each element against items schema', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      tags: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
    });
    const record = v.prepareInsert({ tags: ['a', 'bb', 'ccc'] }, 1);
    expect(record.tags).toEqual(['a', 'bb', 'ccc']);
  });

  it('rejects array element with wrong type', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      tags: {
        type: 'array',
        items: { type: 'string' },
      },
    });
    try {
      v.prepareInsert({ tags: ['ok', 123, 'fine'] }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues).toHaveLength(1);
      expect(ve.issues[0]!.field).toBe('tags[1]');
      expect(ve.issues[0]!.code).toBe('type');
    }
  });

  it('rejects array element failing constraint', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      tags: {
        type: 'array',
        items: { type: 'string', minLength: 2 },
      },
    });
    try {
      v.prepareInsert({ tags: ['ok', 'x'] }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues[0]!.field).toBe('tags[1]');
      expect(ve.issues[0]!.code).toBe('minLength');
    }
  });

  it('skips null/undefined elements in array', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      tags: {
        type: 'array',
        items: { type: 'string' },
      },
    });
    const record = v.prepareInsert({ tags: ['a', null, 'b'] }, 1);
    expect(record.tags).toEqual(['a', null, 'b']);
  });

  it('validates array of objects with nested properties', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      contacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', required: true },
            email: { type: 'string', format: 'email' },
          },
        },
      },
    });
    const record = v.prepareInsert(
      { contacts: [{ name: 'Alice', email: 'alice@example.com' }] },
      1,
    );
    expect(record.contacts).toEqual([
      { name: 'Alice', email: 'alice@example.com' },
    ]);
  });

  it('reports correct path for nested object in array', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      contacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', required: true },
          },
        },
      },
    });
    try {
      v.prepareInsert({ contacts: [{ name: 'Alice' }, {}] }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues[0]!.field).toBe('contacts[1].name');
      expect(ve.issues[0]!.code).toBe('required');
    }
  });

  it('validates array of arrays (nested items)', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      matrix: {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'number', min: 0 },
        },
      },
    });
    const record = v.prepareInsert({ matrix: [[1, 2], [3, 4]] }, 1);
    expect(record.matrix).toEqual([[1, 2], [3, 4]]);
  });

  it('reports correct path for nested array of arrays', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      matrix: {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'number', min: 0 },
        },
      },
    });
    try {
      v.prepareInsert({ matrix: [[1, 2], [3, -1]] }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues[0]!.field).toBe('matrix[1][1]');
      expect(ve.issues[0]!.code).toBe('min');
    }
  });

  it('array without items is treated as opaque', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      data: { type: 'array' },
    });
    const record = v.prepareInsert({ data: [1, 'two', true, null] }, 1);
    expect(record.data).toEqual([1, 'two', true, null]);
  });

  it('skips array validation when optional array is absent', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      tags: {
        type: 'array',
        items: { type: 'string', minLength: 5 },
      },
    });
    const record = v.prepareInsert({}, 1);
    expect(record.tags).toBeUndefined();
  });

  it('collects multiple element errors', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      scores: {
        type: 'array',
        items: { type: 'number', min: 0, max: 100 },
      },
    });
    try {
      v.prepareInsert({ scores: [-5, 50, 200] }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues).toHaveLength(2);
      expect(ve.issues[0]!.field).toBe('scores[0]');
      expect(ve.issues[1]!.field).toBe('scores[2]');
    }
  });
});

// ── Nested validation in prepareUpdate ───────────────────────────

describe('SchemaValidator nested validation in prepareUpdate', () => {
  const schema: SchemaDefinition = {
    id: { type: 'string', generated: 'uuid' },
    address: {
      type: 'object',
      properties: {
        street: { type: 'string', required: true },
        city: { type: 'string', required: true },
      },
    },
    tags: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  };

  function makeExisting(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      id: 'existing-uuid',
      address: { street: 'Main St', city: 'Prague' },
      tags: ['tag1'],
      _version: 1,
      _createdAt: now - 10_000,
      _updatedAt: now - 10_000,
      ...overrides,
    } as import('../../src/types/index.js').StoreRecord;
  }

  it('accepts valid nested update', () => {
    const v = makeValidator(schema);
    const updated = v.prepareUpdate(makeExisting(), {
      address: { street: 'New St', city: 'Brno' },
    });
    expect(updated.address).toEqual({ street: 'New St', city: 'Brno' });
  });

  it('rejects invalid nested update', () => {
    const v = makeValidator(schema);
    expect(() =>
      v.prepareUpdate(makeExisting(), {
        address: { street: 'New St' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects invalid array element in update', () => {
    const v = makeValidator(schema);
    expect(() =>
      v.prepareUpdate(makeExisting(), {
        tags: ['ok', ''],
      }),
    ).toThrow(ValidationError);
  });
});

// ── Field-level custom validators ─────────────────────────────────

describe('SchemaValidator field-level custom validate', () => {
  it('rejects when field validate returns an error message', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      username: {
        type: 'string',
        required: true,
        validate: (value) =>
          (value as string).startsWith('_') ? 'Username must not start with underscore' : undefined,
      },
    });
    try {
      v.prepareInsert({ username: '_bad' }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues).toHaveLength(1);
      expect(ve.issues[0]!.field).toBe('username');
      expect(ve.issues[0]!.code).toBe('custom');
      expect(ve.issues[0]!.message).toBe('Username must not start with underscore');
    }
  });

  it('passes when field validate returns undefined', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      username: {
        type: 'string',
        required: true,
        validate: () => undefined,
      },
    });
    const record = v.prepareInsert({ username: 'alice' }, 1);
    expect(record.username).toBe('alice');
  });

  it('provides the root record as second argument', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      startDate: { type: 'string', required: true },
      endDate: {
        type: 'string',
        required: true,
        validate: (value, record) =>
          (value as string) <= (record.startDate as string)
            ? 'endDate must be after startDate'
            : undefined,
      },
    });
    expect(() =>
      v.prepareInsert({ startDate: '2024-06-01', endDate: '2024-01-01' }, 1),
    ).toThrow(ValidationError);

    const record = v.prepareInsert(
      { startDate: '2024-01-01', endDate: '2024-06-01' },
      1,
    );
    expect(record.endDate).toBe('2024-06-01');
  });

  it('runs custom validate after built-in constraints', () => {
    const validateFn = vi.fn(() => undefined);
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      age: { type: 'number', min: 0, validate: validateFn },
    });

    // Built-in 'min' check fails first — custom validate still runs for same field
    // (both issues collected)
    try {
      v.prepareInsert({ age: -1 }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      const codes = ve.issues.map((i) => i.code);
      expect(codes).toContain('min');
    }
    expect(validateFn).toHaveBeenCalledWith(-1, expect.any(Object));
  });

  it('collects custom error alongside built-in constraint errors', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      code: {
        type: 'string',
        minLength: 3,
        validate: (value) =>
          (value as string).includes(' ') ? 'Code must not contain spaces' : undefined,
      },
    });
    try {
      v.prepareInsert({ code: 'a b' }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      // minLength fails (length 3 passes, "a b" is length 3 — actually minLength 3 passes),
      // but custom fails because of the space
      expect(ve.issues.some((i) => i.code === 'custom')).toBe(true);
      expect(ve.issues[0]!.message).toBe('Code must not contain spaces');
    }
  });

  it('skips custom validate when value is undefined/null (not required)', () => {
    const validateFn = vi.fn(() => 'should not be called');
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      nickname: { type: 'string', validate: validateFn },
    });
    const record = v.prepareInsert({}, 1);
    expect(record.nickname).toBeUndefined();
    expect(validateFn).not.toHaveBeenCalled();
  });

  it('skips custom validate when type check fails', () => {
    const validateFn = vi.fn(() => undefined);
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', validate: validateFn },
    });
    expect(() => v.prepareInsert({ name: 123 }, 1)).toThrow(ValidationError);
    expect(validateFn).not.toHaveBeenCalled();
  });

  it('works on nested object properties', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      address: {
        type: 'object',
        properties: {
          zip: {
            type: 'string',
            validate: (value) =>
              !/^\d{5}$/.test(value as string) ? 'ZIP must be 5 digits' : undefined,
          },
        },
      },
    });
    try {
      v.prepareInsert({ address: { zip: 'ABC' } }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues[0]!.field).toBe('address.zip');
      expect(ve.issues[0]!.code).toBe('custom');
      expect(ve.issues[0]!.message).toBe('ZIP must be 5 digits');
    }
  });

  it('nested field validate receives the root record', () => {
    let capturedRecord: Record<string, unknown> | undefined;
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      country: { type: 'string', required: true },
      address: {
        type: 'object',
        properties: {
          zip: {
            type: 'string',
            validate: (_value, record) => {
              capturedRecord = record;
              return undefined;
            },
          },
        },
      },
    });
    v.prepareInsert({ country: 'CZ', address: { zip: '11000' } }, 1);
    expect(capturedRecord).toBeDefined();
    expect(capturedRecord!.country).toBe('CZ');
  });

  it('works on array item definitions', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      scores: {
        type: 'array',
        items: {
          type: 'number',
          validate: (value) =>
            (value as number) % 1 !== 0 ? 'Score must be an integer' : undefined,
        },
      },
    });
    try {
      v.prepareInsert({ scores: [10, 20.5, 30] }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues).toHaveLength(1);
      expect(ve.issues[0]!.field).toBe('scores[1]');
      expect(ve.issues[0]!.code).toBe('custom');
      expect(ve.issues[0]!.message).toBe('Score must be an integer');
    }
  });

  it('array item validate receives root record', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      maxScore: { type: 'number', required: true },
      scores: {
        type: 'array',
        items: {
          type: 'number',
          validate: (value, record) =>
            (value as number) > (record.maxScore as number)
              ? 'Score exceeds maximum'
              : undefined,
        },
      },
    });
    try {
      v.prepareInsert({ maxScore: 100, scores: [50, 150] }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues).toHaveLength(1);
      expect(ve.issues[0]!.field).toBe('scores[1]');
      expect(ve.issues[0]!.message).toBe('Score exceeds maximum');
    }
  });

  it('field validate runs during prepareUpdate', () => {
    const schema = {
      id: { type: 'string' as const, generated: 'uuid' as const },
      status: {
        type: 'string' as const,
        validate: (value: unknown) =>
          value === 'invalid' ? 'Invalid status' : undefined,
      },
    };
    const v = makeValidator(schema);
    const existing = {
      id: 'test-id',
      status: 'active',
      _version: 1,
      _createdAt: Date.now() - 1000,
      _updatedAt: Date.now() - 1000,
    } as import('../../src/types/index.js').StoreRecord;

    expect(() => v.prepareUpdate(existing, { status: 'invalid' })).toThrow(ValidationError);
    const updated = v.prepareUpdate(existing, { status: 'completed' });
    expect(updated.status).toBe('completed');
  });
});

// ── Bucket-level custom validators ───────────────────────────────

describe('SchemaValidator bucket-level custom validate', () => {
  it('rejects when bucket validate returns error messages', () => {
    const v = new SchemaValidator(
      'orders',
      {
        id: { type: 'string', generated: 'uuid' },
        status: { type: 'string', required: true },
        trackingNumber: { type: 'string' },
      },
      'id',
      (record) => {
        const errors: string[] = [];
        if (record.status === 'shipped' && !record.trackingNumber) {
          errors.push('trackingNumber is required when status is shipped');
        }
        return errors.length > 0 ? errors : undefined;
      },
    );

    try {
      v.prepareInsert({ status: 'shipped' }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues).toHaveLength(1);
      expect(ve.issues[0]!.field).toBe('_record');
      expect(ve.issues[0]!.code).toBe('custom');
      expect(ve.issues[0]!.message).toBe('trackingNumber is required when status is shipped');
    }
  });

  it('passes when bucket validate returns undefined', () => {
    const v = new SchemaValidator(
      'orders',
      {
        id: { type: 'string', generated: 'uuid' },
        status: { type: 'string', required: true },
      },
      'id',
      () => undefined,
    );
    const record = v.prepareInsert({ status: 'pending' }, 1);
    expect(record.status).toBe('pending');
  });

  it('collects multiple bucket-level errors', () => {
    const v = new SchemaValidator(
      'test',
      {
        id: { type: 'string', generated: 'uuid' },
        a: { type: 'string' },
        b: { type: 'string' },
      },
      'id',
      () => ['Error one', 'Error two'],
    );
    try {
      v.prepareInsert({ a: 'x', b: 'y' }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      const customIssues = ve.issues.filter((i) => i.code === 'custom');
      expect(customIssues).toHaveLength(2);
      expect(customIssues[0]!.message).toBe('Error one');
      expect(customIssues[1]!.message).toBe('Error two');
    }
  });

  it('combines field-level and bucket-level errors', () => {
    const v = new SchemaValidator(
      'test',
      {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
        status: { type: 'string', required: true },
      },
      'id',
      (record) =>
        record.status === 'bad' ? ['Bad status at record level'] : undefined,
    );
    try {
      // Missing required 'name' + bucket-level error for status
      v.prepareInsert({ status: 'bad' }, 1);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.issues.length).toBeGreaterThanOrEqual(2);
      expect(ve.issues.some((i) => i.code === 'required' && i.field === 'name')).toBe(true);
      expect(ve.issues.some((i) => i.code === 'custom' && i.field === '_record')).toBe(true);
    }
  });

  it('bucket validate runs during prepareUpdate', () => {
    const v = new SchemaValidator(
      'orders',
      {
        id: { type: 'string', generated: 'uuid' },
        status: { type: 'string', required: true },
        trackingNumber: { type: 'string' },
      },
      'id',
      (record) => {
        if (record.status === 'shipped' && !record.trackingNumber) {
          return ['trackingNumber is required when status is shipped'];
        }
        return undefined;
      },
    );

    const existing = {
      id: 'order-1',
      status: 'pending',
      _version: 1,
      _createdAt: Date.now() - 1000,
      _updatedAt: Date.now() - 1000,
    } as import('../../src/types/index.js').StoreRecord;

    expect(() => v.prepareUpdate(existing, { status: 'shipped' })).toThrow(ValidationError);

    const updated = v.prepareUpdate(existing, {
      status: 'shipped',
      trackingNumber: 'TR-123',
    });
    expect(updated.status).toBe('shipped');
    expect(updated.trackingNumber).toBe('TR-123');
  });

  it('bucket validate receives the complete record with meta fields', () => {
    let receivedRecord: Record<string, unknown> | undefined;
    const v = new SchemaValidator(
      'test',
      { id: { type: 'string', generated: 'uuid' } },
      'id',
      (record) => {
        receivedRecord = record;
        return undefined;
      },
    );
    v.prepareInsert({}, 1);
    expect(receivedRecord).toBeDefined();
    expect(receivedRecord!._version).toBe(1);
    expect(typeof receivedRecord!._createdAt).toBe('number');
    expect(typeof receivedRecord!.id).toBe('string');
  });

  it('works without bucket validate (backward compatible)', () => {
    const v = makeValidator({
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
    });
    const record = v.prepareInsert({ name: 'Alice' }, 1);
    expect(record.name).toBe('Alice');
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
