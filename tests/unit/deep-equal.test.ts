import { describe, it, expect } from 'vitest';
import { deepEqual } from '../../src/utils/deep-equal.js';

describe('deepEqual', () => {
  describe('primitives', () => {
    it.each([
      [1, 1],
      [0, 0],
      [-0, -0],
      ['hello', 'hello'],
      ['', ''],
      [true, true],
      [false, false],
      [null, null],
      [undefined, undefined],
    ])('returns true for identical primitives: %j === %j', (a, b) => {
      expect(deepEqual(a, b)).toBe(true);
    });

    it('treats NaN as equal to NaN', () => {
      expect(deepEqual(NaN, NaN)).toBe(true);
    });

    it.each([
      [1, 2],
      ['a', 'b'],
      [true, false],
      [0, ''],
      [0, false],
      [null, undefined],
      [1, '1'],
    ])('returns false for different primitives: %j !== %j', (a, b) => {
      expect(deepEqual(a, b)).toBe(false);
    });
  });

  describe('same reference', () => {
    it('returns true for the same object reference', () => {
      const obj = { a: 1 };
      expect(deepEqual(obj, obj)).toBe(true);
    });

    it('returns true for the same array reference', () => {
      const arr = [1, 2, 3];
      expect(deepEqual(arr, arr)).toBe(true);
    });
  });

  describe('arrays', () => {
    it('compares equal arrays', () => {
      expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    });

    it('returns false for different length', () => {
      expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    });

    it('returns false for different elements', () => {
      expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    it('compares nested arrays', () => {
      expect(deepEqual([[1, 2], [3]], [[1, 2], [3]])).toBe(true);
      expect(deepEqual([[1, 2], [3]], [[1, 2], [4]])).toBe(false);
    });

    it('compares empty arrays', () => {
      expect(deepEqual([], [])).toBe(true);
    });

    it('differentiates array from object', () => {
      expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    });
  });

  describe('plain objects', () => {
    it('compares equal objects', () => {
      expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    });

    it('returns false when keys differ', () => {
      expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    });

    it('returns false when values differ', () => {
      expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it('returns false for different number of keys', () => {
      expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it('compares nested objects', () => {
      const a = { x: { y: { z: 1 } } };
      const b = { x: { y: { z: 1 } } };
      expect(deepEqual(a, b)).toBe(true);
    });

    it('returns false for nested value difference', () => {
      const a = { x: { y: 1 } };
      const b = { x: { y: 2 } };
      expect(deepEqual(a, b)).toBe(false);
    });

    it('compares empty objects', () => {
      expect(deepEqual({}, {})).toBe(true);
    });

    it('handles objects with undefined values', () => {
      expect(deepEqual({ a: undefined }, { a: undefined })).toBe(true);
      expect(deepEqual({ a: undefined }, {})).toBe(false);
    });

    it('compares Object.create(null) objects', () => {
      const a = Object.create(null) as Record<string, unknown>;
      const b = Object.create(null) as Record<string, unknown>;
      a.x = 1;
      b.x = 1;
      expect(deepEqual(a, b)).toBe(true);
    });
  });

  describe('dates', () => {
    it('returns true for dates with the same time', () => {
      const t = Date.now();
      expect(deepEqual(new Date(t), new Date(t))).toBe(true);
    });

    it('returns false for dates with different time', () => {
      expect(deepEqual(new Date(1000), new Date(2000))).toBe(false);
    });

    it('does not equal a plain object with getTime', () => {
      expect(deepEqual(new Date(1000), { getTime: () => 1000 })).toBe(false);
    });
  });

  describe('regexp', () => {
    it('returns true for matching pattern and flags', () => {
      expect(deepEqual(/abc/gi, /abc/gi)).toBe(true);
    });

    it('returns false for different pattern', () => {
      expect(deepEqual(/abc/, /def/)).toBe(false);
    });

    it('returns false for different flags', () => {
      expect(deepEqual(/abc/g, /abc/i)).toBe(false);
    });
  });

  describe('mixed types', () => {
    it('returns false for object vs array', () => {
      expect(deepEqual({}, [])).toBe(false);
    });

    it('returns false for number vs string', () => {
      expect(deepEqual(42, '42')).toBe(false);
    });

    it('returns false for null vs undefined', () => {
      expect(deepEqual(null, undefined)).toBe(false);
    });

    it('returns false for null vs object', () => {
      expect(deepEqual(null, {})).toBe(false);
    });

    it('returns false for Date vs number', () => {
      expect(deepEqual(new Date(1000), 1000)).toBe(false);
    });
  });

  describe('StoreRecord-like objects', () => {
    it('compares records with metadata', () => {
      const a = {
        id: '1',
        name: 'Alice',
        _version: 1,
        _createdAt: 1700000000000,
        _updatedAt: 1700000000000,
      };
      const b = {
        id: '1',
        name: 'Alice',
        _version: 1,
        _createdAt: 1700000000000,
        _updatedAt: 1700000000000,
      };
      expect(deepEqual(a, b)).toBe(true);
    });

    it('detects version difference', () => {
      const a = { id: '1', name: 'A', _version: 1, _createdAt: 0, _updatedAt: 0 };
      const b = { id: '1', name: 'A', _version: 2, _createdAt: 0, _updatedAt: 100 };
      expect(deepEqual(a, b)).toBe(false);
    });

    it('compares arrays of records', () => {
      const records = [
        { id: '1', name: 'A', _version: 1, _createdAt: 0, _updatedAt: 0 },
        { id: '2', name: 'B', _version: 1, _createdAt: 0, _updatedAt: 0 },
      ];
      expect(deepEqual(records, [...records.map((r) => ({ ...r }))])).toBe(true);
    });

    it('compares records with nested data', () => {
      const a = { id: '1', data: { tags: ['vip', 'eu'] }, _version: 1, _createdAt: 0, _updatedAt: 0 };
      const b = { id: '1', data: { tags: ['vip', 'eu'] }, _version: 1, _createdAt: 0, _updatedAt: 0 };
      expect(deepEqual(a, b)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles deeply nested structures', () => {
      const nest = (depth: number, value: unknown): unknown =>
        depth === 0 ? value : { child: nest(depth - 1, value) };

      expect(deepEqual(nest(50, 'leaf'), nest(50, 'leaf'))).toBe(true);
      expect(deepEqual(nest(50, 'a'), nest(50, 'b'))).toBe(false);
    });

    it('handles mixed arrays and objects', () => {
      const a = { list: [{ x: 1 }, { x: 2 }], meta: { count: 2 } };
      const b = { list: [{ x: 1 }, { x: 2 }], meta: { count: 2 } };
      expect(deepEqual(a, b)).toBe(true);
    });

    it('returns false for class instances (non-plain objects)', () => {
      class Foo {
        x = 1;
      }
      expect(deepEqual(new Foo(), { x: 1 })).toBe(false);
    });
  });
});
