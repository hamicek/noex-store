# Schema and Types API Reference

> Bucket definitions, field types, constraints, generated values, record metadata, and schema validation.

## Overview

Every bucket in noex-store is defined by a `BucketDefinition` that declares the primary key, a typed schema, optional indexes, TTL, and size limits. The schema drives automatic validation on every insert and update — data that violates any constraint is rejected before it reaches storage.

This document covers the complete type system: `BucketDefinition`, `FieldDefinition` with all six field types and all constraints, the four generated value strategies, `RecordMeta` system metadata, and the `SchemaValidator` class that orchestrates validation.

## API

### `BucketDefinition`

Configuration object passed to `store.defineBucket(name, definition)`.

```typescript
interface BucketDefinition {
  readonly key: string;
  readonly schema: SchemaDefinition;
  readonly indexes?: readonly string[];
  readonly etsType?: EtsTableType;
  readonly persistent?: boolean;
  readonly ttl?: number | string;
  readonly maxSize?: number;
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `key` | `string` | Yes | — | Name of the primary key field. Must reference a field defined in `schema` |
| `schema` | [`SchemaDefinition`](#schemadefinition) | Yes | — | Field definitions with types and constraints |
| `indexes` | `readonly string[]` | No | `[]` | Fields to index for fast lookups. Each must reference a field in `schema` |
| `etsType` | [`EtsTableType`](#etstabletype) | No | `'set'` | Storage structure type. Affects ordering and key uniqueness semantics |
| `persistent` | `boolean` | No | `true` (when store has persistence) | Set to `false` to exclude this bucket from persistence |
| `ttl` | `number \| string` | No | `undefined` | Time-to-live per record. Number = milliseconds, string = human-readable (`"1s"`, `"30m"`, `"1h"`, `"7d"`, `"90d"`) |
| `maxSize` | `number` | No | `undefined` | Maximum number of records. Oldest records (by `_createdAt`) are evicted on overflow |

**Example:**

```typescript
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 1 },
    email: { type: 'string', format: 'email', unique: true },
    role:  { type: 'string', enum: ['admin', 'member'], default: 'member' },
  },
  indexes: ['email', 'role'],
  ttl: '90d',
  maxSize: 50_000,
});
```

---

### `SchemaDefinition`

A record of field names to `FieldDefinition` objects. Defines the shape and validation rules for all records in a bucket.

```typescript
type SchemaDefinition = Readonly<Record<string, FieldDefinition>>;
```

Fields not declared in the schema are passed through without validation. Only declared fields are type-checked and constrained.

---

### `FieldDefinition`

Describes a single field's type, constraints, and generation strategy.

```typescript
interface FieldDefinition {
  readonly type: FieldType;
  readonly required?: boolean;
  readonly default?: unknown | (() => unknown);
  readonly generated?: GeneratedType;
  readonly enum?: readonly unknown[];
  readonly format?: FormatType;
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly ref?: string;
  readonly unique?: boolean;
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | [`FieldType`](#fieldtype) | — | **Required.** The data type of this field |
| `required` | `boolean` | `false` | Reject `undefined` and `null` values |
| `default` | `unknown \| (() => unknown)` | `undefined` | Static value or factory function applied when the field is missing on insert |
| `generated` | [`GeneratedType`](#generatedtype) | `undefined` | Auto-generate the field value on insert |
| `enum` | `readonly unknown[]` | `undefined` | Restrict the field to a fixed set of allowed values |
| `format` | [`FormatType`](#formattype) | `undefined` | Built-in string format validator |
| `min` | `number` | `undefined` | Minimum value (inclusive) for `number` fields |
| `max` | `number` | `undefined` | Maximum value (inclusive) for `number` fields |
| `minLength` | `number` | `undefined` | Minimum string length |
| `maxLength` | `number` | `undefined` | Maximum string length |
| `pattern` | `string` | `undefined` | Regex pattern for string fields. Compiled with `new RegExp(pattern)` |
| `ref` | `string` | `undefined` | Metadata hint referencing another bucket name. Not enforced at runtime |
| `unique` | `boolean` | `false` | Enforce uniqueness across all records. Automatically creates a unique index |

---

## Field Types

### `FieldType`

```typescript
type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date';
```

Type validation runs before constraint validation. If the type check fails, constraint checks (enum, min, max, etc.) are skipped for that field.

| Type | Accepts | Rejects |
|------|---------|---------|
| `'string'` | `typeof value === 'string'` | Numbers, booleans, objects, `null` |
| `'number'` | `typeof value === 'number'` except `NaN` | Strings, `NaN` |
| `'boolean'` | `true` or `false` | `0`, `1`, `'yes'`, `'false'` |
| `'object'` | Plain objects (`typeof === 'object'`, not `null`, not an array) | `null`, arrays, primitives |
| `'array'` | `Array.isArray(value)` | Plain objects, strings |
| `'date'` | `Date` instances (with valid time), numbers (timestamps), strings | Booleans, invalid `Date` objects |

**Example:**

```typescript
schema: {
  name:     { type: 'string' },
  age:      { type: 'number' },
  active:   { type: 'boolean' },
  settings: { type: 'object' },
  tags:     { type: 'array' },
  birthday: { type: 'date' },
}
```

---

## Constraints

All constraints are checked on both `insert` and `update`. On update, the store merges the update payload into the existing record, then validates the merged result. All constraint violations are collected — the validator does not stop at the first failure.

### `required`

Rejects `undefined` and `null`. An empty string `""` is considered present.

```typescript
name: { type: 'string', required: true }
```

### `enum`

Restricts the value to a fixed set. Works with any field type.

```typescript
role: { type: 'string', enum: ['admin', 'member', 'guest'] }
severity: { type: 'number', enum: [1, 2, 3, 4, 5] }
```

### `min` / `max`

Inclusive numeric boundaries. Applied only to `number` values.

```typescript
price: { type: 'number', min: 0 }
rating: { type: 'number', min: 1, max: 5 }
```

### `minLength` / `maxLength`

String length boundaries. Applied only to `string` values.

```typescript
name: { type: 'string', minLength: 1, maxLength: 100 }
```

### `pattern`

Regex validation for strings. Compiled with `new RegExp(pattern)`. Use `^` and `$` anchors for full-string matching — without anchors, a partial match passes.

```typescript
code: { type: 'string', pattern: '^[A-Z]{3}-\\d{4}$' }
```

### `format`

Built-in format validators for common string shapes:

| Format | Validates | Example |
|--------|-----------|---------|
| `'email'` | Email address | `user@example.com` |
| `'url'` | URL | `https://example.com` |
| `'iso-date'` | ISO-8601 date | `2024-01-15` |

```typescript
email: { type: 'string', format: 'email' }
website: { type: 'string', format: 'url' }
birthday: { type: 'string', format: 'iso-date' }
```

### `unique`

Enforces cross-record uniqueness within the bucket. Automatically creates a unique index for the field. `null` and `undefined` values are not indexed — multiple records can have `null` for a unique field.

```typescript
email: { type: 'string', unique: true }
```

**Throws:** `UniqueConstraintError` on insert or update when a duplicate value is detected.

### `ref`

Metadata hint referencing another bucket name. This is **not enforced** at runtime — the store does not validate foreign keys. It serves as documentation for relationships between buckets.

```typescript
authorId: { type: 'string', ref: 'authors' }
```

### `default`

Applied when the field is `undefined` during insertion. Supports static values and factory functions. Functional defaults (`default: () => []`) should be used for mutable types to avoid shared references across records.

```typescript
// Static default
role: { type: 'string', default: 'member' }

// Functional default — new instance per record
tags: { type: 'array', default: () => [] }
settings: { type: 'object', default: () => ({ theme: 'light' }) }
```

---

## Generated Types

### `GeneratedType`

```typescript
type GeneratedType = 'uuid' | 'cuid' | 'autoincrement' | 'timestamp';
```

Fields with `generated` are automatically populated on insert when the value is `undefined`. If an explicit value is provided, generation is skipped. Generated fields are **stripped from update payloads** — they cannot be overwritten after creation.

**Priority order:** explicit value > generated > default

| Strategy | Field Type | Value | Description |
|----------|-----------|-------|-------------|
| `'uuid'` | `string` | `'550e8400-e29b-41d4-a716-446655440000'` | RFC 4122 v4 UUID, 128 random bits |
| `'cuid'` | `string` | `'c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'` | Collision-resistant, `c` prefix + 32 hex characters |
| `'autoincrement'` | `number` | `1`, `2`, `3`, ... | Per-bucket sequential counter, starts at 1 |
| `'timestamp'` | `number` | `1706745600000` | Current time via `Date.now()`, Unix milliseconds |

**Example:**

```typescript
schema: {
  id:        { type: 'string', generated: 'uuid' },
  seq:       { type: 'number', generated: 'autoincrement' },
  createdAt: { type: 'number', generated: 'timestamp' },
}
```

> **Note:** Every record already receives `_createdAt` and `_updatedAt` metadata automatically. Use `generated: 'timestamp'` when you need an additional application-level timestamp field.

---

## Record Metadata

### `RecordMeta`

System metadata automatically managed by the store. Present on every stored record.

```typescript
interface RecordMeta {
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
  readonly _expiresAt?: number;
}
```

| Property | Type | Set On | Description |
|----------|------|--------|-------------|
| `_version` | `number` | Insert: `1`, Update: `+1` | Record version number. Starts at 1, incremented by 1 on each `update()`. Used for optimistic locking in transactions |
| `_createdAt` | `number` | Insert | Unix ms timestamp set when the record is first inserted |
| `_updatedAt` | `number` | Insert, Update | Unix ms timestamp set on insert and updated on each `update()` |
| `_expiresAt` | `number \| undefined` | Insert (TTL buckets) | Unix ms timestamp when the record expires. Set to `_createdAt + ttlMs` for buckets with `ttl` configured. Not present on non-TTL buckets |

Metadata fields cannot be overwritten via `update()` — they are stripped from the update payload and managed internally.

### `StoreRecord`

Every record stored in a bucket is a `StoreRecord` — the user-defined fields merged with `RecordMeta`.

```typescript
type StoreRecord<T = Record<string, unknown>> = T & RecordMeta;
```

---

## Format Types

### `FormatType`

```typescript
type FormatType = 'email' | 'url' | 'iso-date';
```

Used with the `format` constraint on `FieldDefinition`. Internally delegates to `isValidEmail()`, `isValidUrl()`, and `isValidIsoDate()` utility functions.

---

## ETS Table Types

### `EtsTableType`

```typescript
type EtsTableType = 'set' | 'ordered_set' | 'bag' | 'duplicate_bag';
```

Controls the internal storage structure of a bucket.

| Type | Key Uniqueness | Ordering | Description |
|------|---------------|----------|-------------|
| `'set'` | Unique keys | Unordered | Default. One record per key, hash-based lookup |
| `'ordered_set'` | Unique keys | Sorted by key | Records are sorted by primary key. Enables meaningful `first()`, `last()`, and cursor-based `paginate()` |
| `'bag'` | Duplicate keys allowed | Unordered | Multiple records can share the same key value |
| `'duplicate_bag'` | Duplicate keys and values allowed | Unordered | Allows fully duplicate records |

---

## Schema Validator

### `SchemaValidator`

Internal class that handles validation, default application, and generated field population. Exported from the public API for advanced use cases.

#### `new SchemaValidator(bucketName, schema, keyField)`

Creates a validator instance bound to a specific bucket schema.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `bucketName` | `string` | Bucket name (used in error messages) |
| `schema` | `SchemaDefinition` | The field definitions to validate against |
| `keyField` | `string` | Name of the primary key field |

---

#### `validator.prepareInsert(input, autoincrementCounter): StoreRecord`

Prepares a new record for insertion. Executes four steps in order:

1. **Generate** values for fields with `generated` that are missing from input
2. **Apply defaults** for fields that are still `undefined`
3. **Attach metadata** — sets `_version: 1`, `_createdAt`, and `_updatedAt` to current timestamp
4. **Validate** the complete record against all schema constraints

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `input` | `Record<string, unknown>` | User-provided field values |
| `autoincrementCounter` | `number` | Current autoincrement value for this bucket |

**Returns:** `StoreRecord` — the fully populated and validated record

**Throws:** `ValidationError` — if any field violates its constraints

---

#### `validator.prepareUpdate(existing, changes): StoreRecord`

Prepares an update to an existing record. Executes four steps in order:

1. **Strip protected fields** — removes `_version`, `_createdAt`, `_updatedAt`, the primary key, and all generated fields from changes
2. **Merge** existing record with sanitized changes
3. **Bump metadata** — increments `_version` by 1, sets `_updatedAt` to current timestamp
4. **Validate** the merged record against all schema constraints

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `existing` | `StoreRecord` | The current record as stored |
| `changes` | `Record<string, unknown>` | Fields to update |

**Returns:** `StoreRecord` — the merged, validated record

**Throws:** `ValidationError` — if the merged record violates any constraints

---

## Validation Errors

### `ValidationError`

Thrown when one or more fields fail validation. Extends `Error`. Collects all issues in a single throw — the validator does not stop at the first failure.

```typescript
class ValidationError extends Error {
  readonly name: 'ValidationError';
  readonly issues: readonly ValidationIssue[];

  constructor(bucketName: string, issues: readonly ValidationIssue[]);
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `'ValidationError'` | Always `'ValidationError'` |
| `message` | `string` | Human-readable summary: `'Validation failed for bucket "users": name: Field is required; email: Invalid email format'` |
| `issues` | `readonly ValidationIssue[]` | Structured array of all validation failures |

**Example:**

```typescript
import { ValidationError } from '@hamicek/noex-store';

try {
  await users.insert({ name: '', email: 'not-an-email', age: -5 });
} catch (err) {
  if (err instanceof ValidationError) {
    for (const issue of err.issues) {
      console.log(`[${issue.code}] ${issue.field}: ${issue.message}`);
    }
  }
}
```

---

### `ValidationIssue`

A single validation failure within a `ValidationError`.

```typescript
interface ValidationIssue {
  readonly field: string;
  readonly message: string;
  readonly code: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `field` | `string` | The schema field name that failed |
| `message` | `string` | Human-readable description of the failure |
| `code` | `string` | Machine-readable error code for programmatic handling |

### Error Codes

| Code | Trigger | Example |
|------|---------|---------|
| `'required'` | Missing or `null` value on a required field | `name` is `undefined` |
| `'type'` | Value doesn't match the declared type | `string` expected, `number` given |
| `'enum'` | Value not in the allowed set | `'premium'` not in `['basic', 'vip']` |
| `'min'` | Number below minimum | `-1` with `min: 0` |
| `'max'` | Number above maximum | `101` with `max: 100` |
| `'minLength'` | String shorter than minimum | `'A'` with `minLength: 2` |
| `'maxLength'` | String longer than maximum | `'ABCDE'` with `maxLength: 3` |
| `'pattern'` | String doesn't match regex | `'ab1'` with `pattern: '^[A-Z]{3}$'` |
| `'format'` | Invalid email, URL, or ISO date | `'not-an-email'` with `format: 'email'` |

---

## Validation Flow

The validator processes each field in the schema in order:

1. **`required` check** — if the field is required and the value is `undefined` or `null`, push issue with code `'required'` and skip remaining checks for this field
2. **Absence check** — if the value is `undefined` or `null` but not required, skip all remaining checks for this field
3. **Type check** — if the value doesn't match the declared `type`, push issue with code `'type'` and skip remaining checks for this field
4. **Constraint checks** — check `enum`, `min`, `max`, `minLength`, `maxLength`, `pattern`, and `format`. Each failure pushes its own issue

After processing all fields, if any issues were collected, throw a `ValidationError` with all of them.

---

## See Also

- [Store API](./store.md) — `store.defineBucket()`, `Store.start()`, and `StoreOptions`
- [BucketHandle API](./bucket-handle.md) — `insert()`, `update()`, and other operations that trigger validation
- [Reactive Queries](./reactive-queries.md) — read-only queries that access bucket data
- [Transactions](./transactions.md) — transactional context with the same validation rules
- [Events](./events.md) — events emitted after successful insert, update, and delete
- [TTL and Lifecycle](./ttl-lifecycle.md) — TTL duration syntax and `_expiresAt` metadata
- [Errors](./errors.md) — `ValidationError`, `UniqueConstraintError`, and other error classes
- [Utilities](./utilities.md) — `generateUuid()`, `generateCuid()`, `isValidEmail()`, and other functions used by the validator
- **Learn:** [Buckets and Schemas](../learn/02-getting-started/02-buckets-and-schemas.md) — step-by-step introduction to bucket definitions
- **Learn:** [Field Constraints](../learn/03-schema-validation/01-field-constraints.md) — tutorial on all constraint types with exercises
- **Learn:** [Auto-Generation](../learn/03-schema-validation/02-auto-generation.md) — generated types and defaults explained
- **Learn:** [Unique Constraints](../learn/03-schema-validation/03-unique-constraints.md) — uniqueness enforcement and `UniqueConstraintError`
- **Source:** [`src/types/schema.ts`](../../src/types/schema.ts), [`src/types/record.ts`](../../src/types/record.ts), [`src/core/schema-validator.ts`](../../src/core/schema-validator.ts)
