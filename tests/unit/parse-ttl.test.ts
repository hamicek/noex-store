import { describe, it, expect } from 'vitest';
import { parseTtl } from '../../src/utils/parse-ttl.js';

describe('parseTtl', () => {
  describe('number input (milliseconds)', () => {
    it('returns the number as-is for a positive integer', () => {
      expect(parseTtl(5000)).toBe(5000);
    });

    it('returns the number as-is for a positive float', () => {
      expect(parseTtl(1500.5)).toBe(1500.5);
    });

    it('throws for zero', () => {
      expect(() => parseTtl(0)).toThrow('TTL must be a positive finite number, got 0');
    });

    it('throws for a negative number', () => {
      expect(() => parseTtl(-100)).toThrow('TTL must be a positive finite number, got -100');
    });

    it('throws for Infinity', () => {
      expect(() => parseTtl(Infinity)).toThrow('TTL must be a positive finite number, got Infinity');
    });

    it('throws for -Infinity', () => {
      expect(() => parseTtl(-Infinity)).toThrow(
        'TTL must be a positive finite number, got -Infinity',
      );
    });

    it('throws for NaN', () => {
      expect(() => parseTtl(NaN)).toThrow('TTL must be a positive finite number, got NaN');
    });
  });

  describe('string input with suffix', () => {
    it.each([
      ['30s', 30_000],
      ['1s', 1_000],
      ['5m', 300_000],
      ['1h', 3_600_000],
      ['7d', 604_800_000],
      ['90d', 7_776_000_000],
    ])('parses "%s" → %d ms', (input, expected) => {
      expect(parseTtl(input)).toBe(expected);
    });

    it('supports fractional values', () => {
      expect(parseTtl('1.5h')).toBe(5_400_000);
      expect(parseTtl('0.5d')).toBe(43_200_000);
      expect(parseTtl('2.5s')).toBe(2_500);
    });
  });

  describe('invalid string input', () => {
    it('throws for an empty string', () => {
      expect(() => parseTtl('')).toThrow('Invalid TTL format');
    });

    it('throws for a plain word', () => {
      expect(() => parseTtl('abc')).toThrow('Invalid TTL format "abc"');
    });

    it('throws for an unsupported unit', () => {
      expect(() => parseTtl('10x')).toThrow('Invalid TTL format "10x"');
    });

    it('throws for a number-only string (no unit)', () => {
      expect(() => parseTtl('1000')).toThrow('Invalid TTL format "1000"');
    });

    it('throws for a unit-only string (no value)', () => {
      expect(() => parseTtl('h')).toThrow('Invalid TTL format "h"');
    });

    it('throws for negative value in string', () => {
      expect(() => parseTtl('-5m')).toThrow('Invalid TTL format "-5m"');
    });
  });
});
