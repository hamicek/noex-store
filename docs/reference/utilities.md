# Utilities API Reference

> ID generators, format validators, TTL parsing, and deep equality — standalone helper functions exported by the package.

## Overview

noex-store exports a set of utility functions that support schema features (generated fields, format validation, TTL parsing) and can also be used independently. All public utilities are available from the main `@hamicek/noex-store` entry point. The `deepEqual` function is used internally by the reactive query system and is not part of the public API.

## Import

```typescript
import {
  generateUuid,
  generateCuid,
  generateTimestamp,
  isValidEmail,
  isValidUrl,
  isValidIsoDate,
  parseTtl,
} from '@hamicek/noex-store';
```

---

## ID Generators

### `generateUuid(): string`

Generates a random UUID v4 string using Node.js `crypto.randomUUID()`.

**Returns:** `string` — a standard UUID v4 (e.g., `"550e8400-e29b-41d4-a716-446655440000"`).

This is the function used internally when a field has `generated: 'uuid'`.

**Example:**

```typescript
const id = generateUuid();
// '550e8400-e29b-41d4-a716-446655440000'
```

---

### `generateCuid(): string`

Generates a CUID-style identifier: a `c` prefix followed by 32 hex characters (16 random bytes).

**Returns:** `string` — a CUID string (e.g., `"c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6"`).

This is the function used internally when a field has `generated: 'cuid'`.

**Example:**

```typescript
const id = generateCuid();
// 'c' + 32 hex chars, e.g. 'c4f8a2e1b9c0d3f5a6b7c8d9e0f1a2b3'
```

---

### `generateTimestamp(): number`

Returns the current Unix timestamp in milliseconds.

**Returns:** `number` — `Date.now()`.

This is the function used internally when a field has `generated: 'timestamp'`.

**Example:**

```typescript
const ts = generateTimestamp();
// 1700000000000
```

---

## Format Validators

These functions are used by the `SchemaValidator` when a field has a `format` constraint. They can also be used standalone for validation outside of schema definitions.

### `isValidEmail(value): boolean`

Tests whether a string looks like a valid email address. Uses a simple regex that checks for non-whitespace characters around `@` and a dot in the domain part.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `value` | `string` | The string to validate |

**Returns:** `boolean` — `true` if the value matches the email pattern.

**Pattern:** `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`

This is a basic structural check, not a full RFC 5322 validation. It ensures the presence of `@`, a domain part, and a TLD separator.

**Example:**

```typescript
isValidEmail('user@example.com');   // true
isValidEmail('a@b.c');              // true
isValidEmail('user@');              // false
isValidEmail('user@example');       // false
isValidEmail('user @example.com');  // false (space)
```

---

### `isValidUrl(value): boolean`

Tests whether a string is a valid URL by attempting to construct a `URL` object. Delegates entirely to the WHATWG URL parser built into Node.js.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `value` | `string` | The string to validate |

**Returns:** `boolean` — `true` if the value can be parsed as a URL.

**Example:**

```typescript
isValidUrl('https://example.com');           // true
isValidUrl('http://localhost:3000/api');      // true
isValidUrl('ftp://files.example.com/doc');   // true
isValidUrl('not-a-url');                     // false
isValidUrl('');                              // false
```

---

### `isValidIsoDate(value): boolean`

Tests whether a string is a valid ISO 8601 date (date-only or date-time). Performs three levels of validation:

1. **Regex check** — ensures the string matches the ISO date format structurally.
2. **Parse check** — ensures `new Date(value)` produces a valid date (not `NaN`).
3. **Round-trip check** — ensures the parsed date matches the input, catching dates like `2024-02-30` that JavaScript silently adjusts to `2024-03-01`.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `value` | `string` | The string to validate |

**Returns:** `boolean` — `true` if the value is a valid, chronologically real ISO date.

**Accepted formats:**

| Format | Example |
|--------|---------|
| Date only | `2024-01-15` |
| Date + time (UTC) | `2024-01-15T10:30:00Z` |
| Date + time (offset) | `2024-01-15T10:30:00+02:00` |
| Date + time (fractional seconds) | `2024-01-15T10:30:00.123Z` |

**Example:**

```typescript
isValidIsoDate('2024-01-15');               // true
isValidIsoDate('2024-01-15T10:30:00Z');     // true
isValidIsoDate('2024-01-15T10:30:00.123Z'); // true
isValidIsoDate('2024-01-15T10:30:00+02:00'); // true
isValidIsoDate('2024-02-29');               // true  (2024 is a leap year)
isValidIsoDate('2023-02-29');               // false (2023 is not a leap year)
isValidIsoDate('2024-02-30');               // false (February never has 30 days)
isValidIsoDate('2024-13-01');               // false (month 13)
isValidIsoDate('not-a-date');               // false
isValidIsoDate('');                         // false
```

---

## TTL Parsing

### `parseTtl(ttl): number`

Converts a TTL value to milliseconds. Accepts either a raw number (already in milliseconds) or a human-readable duration string with a unit suffix.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `ttl` | `number \| string` | TTL as milliseconds (number) or duration string (`"30s"`, `"5m"`, `"1h"`, `"7d"`) |

**Returns:** `number` — the TTL in milliseconds.

**Throws:** `Error` — if the value is not positive, not finite, or the string format is unrecognized.

**Duration string syntax:** `<value><unit>` — value can be integer or decimal, optional whitespace before unit.

| Unit | Suffix | Multiplier | Examples |
|------|--------|------------|---------|
| Seconds | `s` | 1,000 ms | `"30s"`, `"2.5s"` |
| Minutes | `m` | 60,000 ms | `"5m"`, `"1.5m"` |
| Hours | `h` | 3,600,000 ms | `"1h"`, `"0.5h"` |
| Days | `d` | 86,400,000 ms | `"7d"`, `"90d"` |

**Example:**

```typescript
parseTtl(5000);     // 5000
parseTtl('30s');    // 30000
parseTtl('5m');     // 300000
parseTtl('1h');     // 3600000
parseTtl('7d');     // 604800000
parseTtl('1.5h');   // 5400000
parseTtl('30 m');   // 1800000  (whitespace allowed)
```

**Error cases:**

```typescript
parseTtl(0);         // Error: TTL must be a positive finite number, got 0
parseTtl(-100);      // Error: TTL must be a positive finite number, got -100
parseTtl(Infinity);  // Error: TTL must be a positive finite number, got Infinity
parseTtl('');        // Error: Invalid TTL format ""
parseTtl('fast');    // Error: Invalid TTL format "fast"
parseTtl('10w');     // Error: Invalid TTL format "10w" (weeks not supported)
```

---

## Deep Equality (Internal)

### `deepEqual(a, b): boolean`

Performs deep structural equality comparison. Used internally by the `QueryManager` to determine whether a reactive query result has actually changed before notifying subscribers.

> **Not part of the public API.** This function is not exported from the main `@hamicek/noex-store` entry point. It is documented here for completeness because it drives the reactive query diffing behavior.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `a` | `unknown` | First value |
| `b` | `unknown` | Second value |

**Returns:** `boolean` — `true` if the two values are structurally identical.

**Comparison rules:**

| Type | Comparison method |
|------|-------------------|
| Primitives | Strict equality (`===`) |
| `NaN` | `NaN === NaN` is `true` (unlike standard JS) |
| `Date` | `getTime()` comparison |
| `RegExp` | `source` + `flags` comparison |
| `Array` | Length check + recursive element comparison |
| Plain objects | Key count + recursive value comparison (own properties only) |
| Other types | Always `false` (Map, Set, class instances, etc.) |

A "plain object" is one whose prototype is `Object.prototype` or `null`.

**Example:**

```typescript
// Used internally — equivalent behavior:
deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] });  // true
deepEqual({ a: 1 }, { a: 2 });                          // false
deepEqual(NaN, NaN);                                     // true
deepEqual(new Date('2024-01-01'), new Date('2024-01-01')); // true
deepEqual([1, 2, 3], [1, 2, 3]);                         // true
deepEqual([1, 2], [1, 2, 3]);                            // false
```

---

## Schema Integration

The utility functions map directly to schema features:

| Schema feature | Utility function | Schema config |
|----------------|-----------------|---------------|
| UUID generation | `generateUuid()` | `{ generated: 'uuid' }` |
| CUID generation | `generateCuid()` | `{ generated: 'cuid' }` |
| Timestamp generation | `generateTimestamp()` | `{ generated: 'timestamp' }` |
| Email validation | `isValidEmail()` | `{ format: 'email' }` |
| URL validation | `isValidUrl()` | `{ format: 'url' }` |
| ISO date validation | `isValidIsoDate()` | `{ format: 'iso-date' }` |
| TTL parsing | `parseTtl()` | `BucketDefinition.ttl` |

The `SchemaValidator` calls these functions automatically during `insert` and `update` operations. You only need to call them directly when working outside of the store's schema system.

**Example — using validators outside the store:**

```typescript
import { isValidEmail, parseTtl, generateUuid } from '@hamicek/noex-store';

// Validate user input before passing to the store
if (!isValidEmail(userInput.email)) {
  throw new Error('Invalid email address');
}

// Convert TTL config for external use
const cacheMs = parseTtl('5m');
setTimeout(cleanup, cacheMs);

// Generate IDs for external systems
const correlationId = generateUuid();
```

---

## See Also

- [Schema and Types](./schema.md) — `FieldDefinition.generated`, `FieldDefinition.format`, and `SchemaValidator` that uses these utilities
- [TTL and Lifecycle](./ttl-lifecycle.md) — `parseTtl()` in the context of bucket TTL configuration
- [Reactive Queries](./reactive-queries.md) — deep equality diffing that prevents unnecessary subscriber notifications
- **Learn:** [Buckets and Schemas](../learn/02-getting-started/02-buckets-and-schemas.md) — schema definition with generated fields and format validation
- **Learn:** [TTL Expiration](../learn/09-ttl-lifecycle/01-ttl-expiration.md) — TTL duration syntax in practice
- **Source:** [`src/utils/id-generator.ts`](../../src/utils/id-generator.ts)
- **Source:** [`src/utils/format-validators.ts`](../../src/utils/format-validators.ts)
- **Source:** [`src/utils/parse-ttl.ts`](../../src/utils/parse-ttl.ts)
- **Source:** [`src/utils/deep-equal.ts`](../../src/utils/deep-equal.ts)
