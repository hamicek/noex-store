import { describe, it, expect } from 'vitest';
import {
  generateUuid,
  generateTimestamp,
  isValidEmail,
  isValidUrl,
  isValidIsoDate,
} from '../../src/utils/index.js';

describe('id-generator', () => {
  describe('generateUuid', () => {
    it('returns a valid UUID v4 string', () => {
      const uuid = generateUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('generates unique values on each call', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateUuid()));
      expect(ids.size).toBe(100);
    });
  });

  describe('generateTimestamp', () => {
    it('returns a number close to Date.now()', () => {
      const before = Date.now();
      const ts = generateTimestamp();
      const after = Date.now();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('returns an integer', () => {
      expect(Number.isInteger(generateTimestamp())).toBe(true);
    });
  });
});

describe('format-validators', () => {
  describe('isValidEmail', () => {
    it.each([
      'user@example.com',
      'test.name+tag@domain.co.uk',
      'a@b.c',
    ])('accepts valid email: %s', (email) => {
      expect(isValidEmail(email)).toBe(true);
    });

    it.each([
      '',
      'plaintext',
      '@missing-local.com',
      'missing-at.com',
      'user@ space.com',
      'user @domain.com',
    ])('rejects invalid email: %s', (email) => {
      expect(isValidEmail(email)).toBe(false);
    });
  });

  describe('isValidUrl', () => {
    it.each([
      'https://example.com',
      'http://localhost:3000/path?q=1',
      'ftp://files.example.com/doc.pdf',
      'https://example.com/path#fragment',
    ])('accepts valid URL: %s', (url) => {
      expect(isValidUrl(url)).toBe(true);
    });

    it.each([
      '',
      'not-a-url',
      'example.com',
      '://missing-scheme',
    ])('rejects invalid URL: %s', (url) => {
      expect(isValidUrl(url)).toBe(false);
    });
  });

  describe('isValidIsoDate', () => {
    it.each([
      '2024-01-15',
      '2024-12-31T23:59:59Z',
      '2024-06-15T10:30:00.000Z',
      '2024-06-15T10:30:00+02:00',
      '2024-06-15T10:30:00-05:00',
    ])('accepts valid ISO date: %s', (date) => {
      expect(isValidIsoDate(date)).toBe(true);
    });

    it.each([
      '',
      '2024',
      '2024-13-01',
      '2024-00-15',
      '2024-01-32',
      'not-a-date',
      '15-01-2024',
      '2024/01/15',
    ])('rejects invalid ISO date: %s', (date) => {
      expect(isValidIsoDate(date)).toBe(false);
    });

    it('rejects structurally valid but semantically invalid dates', () => {
      // Feb 30 passes regex but fails Date.parse
      expect(isValidIsoDate('2024-02-30')).toBe(false);
    });
  });
});
