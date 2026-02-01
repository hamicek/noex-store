const MULTIPLIERS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const TTL_PATTERN = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/;

/**
 * Parse a TTL value into milliseconds.
 *
 * Accepts:
 * - `number` — interpreted as milliseconds (must be positive and finite)
 * - `string` with suffix: `"s"` (seconds), `"m"` (minutes), `"h"` (hours), `"d"` (days)
 *
 * @throws {Error} if the format is invalid or value is not positive.
 */
export function parseTtl(ttl: number | string): number {
  if (typeof ttl === 'number') {
    if (ttl <= 0 || !Number.isFinite(ttl)) {
      throw new Error(`TTL must be a positive finite number, got ${String(ttl)}`);
    }
    return ttl;
  }

  const match = TTL_PATTERN.exec(ttl);
  if (match === null) {
    throw new Error(
      `Invalid TTL format "${ttl}". Expected a number (ms) or string like "30s", "5m", "1h", "7d".`,
    );
  }

  const value = Number(match[1]);
  const unit = match[2]!;

  if (value <= 0) {
    throw new Error(`TTL value must be positive, got "${ttl}"`);
  }

  return value * MULTIPLIERS[unit]!;
}
