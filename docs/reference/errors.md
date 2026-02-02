# Errors API Reference

> Complete catalog of every error class thrown by `@hamicek/noex-store` — trigger conditions, properties, and recommended handling patterns.

## Overview

All error classes extend the native `Error` and carry contextual read-only properties (bucket name, field name, etc.) that let you react programmatically without parsing the message string. Every error sets a descriptive `name` property so that `instanceof` checks and serialized error names both work reliably.

```typescript
import {
  ValidationError,
  UniqueConstraintError,
  BucketAlreadyExistsError,
  BucketNotDefinedError,
  TransactionConflictError,
  QueryAlreadyDefinedError,
  QueryNotDefinedError,
} from '@hamicek/noex-store';
```

## Quick Reference

| Error class | Trigger | Key properties |
|-------------|---------|----------------|
| [`ValidationError`](#validationerror) | Schema constraint violated on insert/update | `issues` |
| [`UniqueConstraintError`](#uniqueconstrainterror) | Duplicate value in a unique-indexed field | `bucket`, `field`, `value` |
| [`BucketAlreadyExistsError`](#bucketalreadyexistserror) | `defineBucket()` with a duplicate name | `bucket` |
| [`BucketNotDefinedError`](#bucketnotdefinederror) | `bucket()` or `dropBucket()` for an unknown name | `bucket` |
| [`TransactionConflictError`](#transactionconflicterror) | Optimistic-lock conflict during transaction commit | `bucket`, `key`, `field` |
| [`QueryAlreadyDefinedError`](#queryalreadydefinederror) | `defineQuery()` with a duplicate name | `query` |
| [`QueryNotDefinedError`](#querynotdefinederror) | `subscribe()` or `runQuery()` for an unknown query | `query` |

---

## ValidationError

Thrown when data passed to `insert()` or `update()` violates one or more schema constraints. Collects all violations into a single error so you can display them together (e.g., in a form).

**Hierarchy:** `ValidationError` → `Error`

**Source:** [`src/core/schema-validator.ts`](../../src/core/schema-validator.ts)

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `'ValidationError'` | Error name for `instanceof`-free identification |
| `message` | `string` | Human-readable summary: `Validation failed for bucket "<name>": field1: msg; field2: msg` |
| `issues` | `readonly ValidationIssue[]` | Structured list of every constraint violation |

### ValidationIssue

```typescript
interface ValidationIssue {
  readonly field: string;   // Schema field that failed validation
  readonly message: string; // Human-readable description
  readonly code: string;    // Machine-readable code for programmatic handling
}
```

**Validation codes:**

| Code | Constraint | Example message |
|------|-----------|-----------------|
| `required` | `required: true` | `Field is required` |
| `type` | `type: 'string'` etc. | `Expected type "string", got number` |
| `enum` | `enum: [...]` | `Value must be one of: active, inactive` |
| `minLength` | `minLength: N` | `Minimum length is 3` |
| `maxLength` | `maxLength: N` | `Maximum length is 100` |
| `pattern` | `pattern: '...'` | `Value must match pattern "^[A-Z]+"` |
| `format` | `format: 'email'` etc. | `Invalid email format` |
| `min` | `min: N` | `Minimum value is 0` |
| `max` | `max: N` | `Maximum value is 100` |

### When It's Thrown

- **`bucket.insert(data)`** — after generating fields and applying defaults, the complete record is validated against the schema.
- **`bucket.update(key, changes)`** — changes are merged with the existing record and the result is validated.
- **`tx.bucket(name).insert(data)`** / **`tx.bucket(name).update(key, changes)`** — same rules apply inside transactions.

Multiple constraint violations on the same record are collected into a single `ValidationError`.

### Example — triggering the error

```typescript
store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 2 },
    email: { type: 'string', required: true, format: 'email' },
    age:   { type: 'number', min: 0, max: 150 },
  },
});

const users = store.bucket('users');

// Missing required fields + invalid format
await users.insert({ name: '', email: 'not-an-email', age: -5 });
// Throws ValidationError with 3 issues:
//   name:  "Minimum length is 2"  (code: 'minLength')
//   email: "Invalid email format"  (code: 'format')
//   age:   "Minimum value is 0"    (code: 'min')
```

### Recommended Handling

```typescript
try {
  await users.insert(input);
} catch (err) {
  if (err instanceof ValidationError) {
    // Display all issues, e.g. map to form field errors
    for (const issue of err.issues) {
      console.error(`${issue.field}: ${issue.message} [${issue.code}]`);
    }
    return;
  }
  throw err;
}
```

---

## UniqueConstraintError

Thrown when an `insert()` or `update()` would create a duplicate value in a field that has a unique index.

**Hierarchy:** `UniqueConstraintError` → `Error`

**Source:** [`src/core/store.ts`](../../src/core/store.ts) (definition) / [`src/core/index-manager.ts`](../../src/core/index-manager.ts) (thrown)

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `'UniqueConstraintError'` | Error name |
| `message` | `string` | `Unique constraint violation in bucket "<bucket>": field "<field>" already has value "<value>"` |
| `bucket` | `string` | Bucket where the conflict occurred |
| `field` | `string` | Field with the unique constraint |
| `value` | `unknown` | The conflicting value |

### When It's Thrown

- **`bucket.insert(data)`** — the value of a unique-indexed field already exists in another record.
- **`bucket.update(key, changes)`** — the updated value of a unique-indexed field already exists in a different record.
- **Transaction commit** — same rules, checked during the commit phase.

`null` and `undefined` values are excluded from unique index checks — multiple records may have a missing unique field.

### Example — triggering the error

```typescript
store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    email: { type: 'string', unique: true },
  },
});

const users = store.bucket('users');
await users.insert({ email: 'alice@example.com' });

// Second insert with the same email
await users.insert({ email: 'alice@example.com' });
// Throws UniqueConstraintError: field "email" already has value "alice@example.com"
```

### Recommended Handling

```typescript
try {
  await users.insert(input);
} catch (err) {
  if (err instanceof UniqueConstraintError) {
    console.error(`Duplicate ${err.field}: ${String(err.value)}`);
    return;
  }
  throw err;
}
```

---

## BucketAlreadyExistsError

Thrown when `store.defineBucket()` is called with a name that is already registered.

**Hierarchy:** `BucketAlreadyExistsError` → `Error`

**Source:** [`src/core/store.ts`](../../src/core/store.ts)

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `'BucketAlreadyExistsError'` | Error name |
| `message` | `string` | `Bucket "<bucket>" already exists` |
| `bucket` | `string` | The duplicate bucket name |

### When It's Thrown

- **`store.defineBucket(name, definition)`** — a bucket with the same `name` has already been defined in this store instance.

### Example — triggering the error

```typescript
await store.defineBucket('users', {
  key: 'id',
  schema: { id: { type: 'string' } },
});

// Defining the same bucket again
await store.defineBucket('users', {
  key: 'id',
  schema: { id: { type: 'string' } },
});
// Throws BucketAlreadyExistsError: Bucket "users" already exists
```

### Recommended Handling

This is typically a programming error (duplicate definition in setup code). In production code, define each bucket exactly once during initialization. If you need to guard against it:

```typescript
try {
  await store.defineBucket('users', definition);
} catch (err) {
  if (err instanceof BucketAlreadyExistsError) {
    // Bucket already set up — safe to ignore in idempotent init
  } else {
    throw err;
  }
}
```

---

## BucketNotDefinedError

Thrown when you try to access or drop a bucket that hasn't been defined.

**Hierarchy:** `BucketNotDefinedError` → `Error`

**Source:** [`src/core/store.ts`](../../src/core/store.ts)

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `'BucketNotDefinedError'` | Error name |
| `message` | `string` | `Bucket "<bucket>" is not defined` |
| `bucket` | `string` | The unknown bucket name |

### When It's Thrown

- **`store.bucket(name)`** — no bucket with this name has been defined.
- **`store.dropBucket(name)`** — no bucket with this name exists to drop.

### Example — triggering the error

```typescript
const store = await Store.start();

// No bucket defined yet
const handle = store.bucket('orders');
// Throws BucketNotDefinedError: Bucket "orders" is not defined
```

### Recommended Handling

This is almost always a programming error — a typo in the bucket name or a missing `defineBucket()` call. Fix the name or ensure the bucket is defined before accessing it:

```typescript
try {
  const handle = store.bucket(name);
} catch (err) {
  if (err instanceof BucketNotDefinedError) {
    console.error(`Unknown bucket: ${err.bucket}`);
  }
  throw err;
}
```

---

## TransactionConflictError

Thrown during transaction commit when the store detects that another operation has modified data the transaction depends on. This is the core of the [optimistic locking](./transactions.md#optimistic-locking) mechanism.

**Hierarchy:** `TransactionConflictError` → `Error`

**Source:** [`src/core/store.ts`](../../src/core/store.ts) (definition) / [`src/core/bucket-server.ts`](../../src/core/bucket-server.ts) (thrown)

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `'TransactionConflictError'` | Error name |
| `message` | `string` | `Transaction conflict in bucket "<bucket>" for key "<key>": <detail>` |
| `bucket` | `string` | Bucket where the conflict occurred |
| `key` | `unknown` | Primary key of the conflicting record |
| `field` | `string \| undefined` | Field that caused the conflict (when applicable) |

### When It's Thrown

During the commit phase of `store.transaction()`, three conflict scenarios are detected:

| Scenario | Detail message |
|----------|---------------|
| **Insert conflict** | Record with the same key already exists in the bucket |
| **Update — record missing** | Record was deleted between the transaction read and commit |
| **Update/Delete — version mismatch** | Record was modified by another operation, `_version` no longer matches |

### Example — triggering the error

```typescript
const users = store.bucket('users');
await users.insert({ id: 'u1', name: 'Alice' });

// Start a transaction that reads a record
await store.transaction(async (tx) => {
  const txUsers = await tx.bucket('users');
  const user = await txUsers.get('u1');

  // Concurrent modification outside the transaction
  await users.update('u1', { name: 'Bob' });

  // This commit will detect the version mismatch
  await txUsers.update('u1', { name: 'Charlie' });
});
// Throws TransactionConflictError
```

### Recommended Handling — retry pattern

```typescript
async function withRetry<T>(
  store: Store,
  fn: (tx: TransactionContext) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await store.transaction(fn);
    } catch (err) {
      if (err instanceof TransactionConflictError && attempt < maxRetries) {
        continue; // Retry with fresh data
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}
```

---

## QueryAlreadyDefinedError

Thrown when `store.defineQuery()` is called with a name that is already registered.

**Hierarchy:** `QueryAlreadyDefinedError` → `Error`

**Source:** [`src/core/query-errors.ts`](../../src/core/query-errors.ts)

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `'QueryAlreadyDefinedError'` | Error name |
| `message` | `string` | `Query "<query>" is already defined` |
| `query` | `string` | The duplicate query name |

### When It's Thrown

- **`store.defineQuery(name, fn)`** — a query with the same `name` has already been defined.

### Example — triggering the error

```typescript
store.defineQuery('activeUsers', (ctx) => {
  return ctx.bucket('users').where({ status: 'active' });
});

// Defining the same query again
store.defineQuery('activeUsers', (ctx) => {
  return ctx.bucket('users').where({ status: 'active' });
});
// Throws QueryAlreadyDefinedError: Query "activeUsers" is already defined
```

### Recommended Handling

Like `BucketAlreadyExistsError`, this is a programming error. Define each query once during setup:

```typescript
try {
  store.defineQuery('activeUsers', queryFn);
} catch (err) {
  if (err instanceof QueryAlreadyDefinedError) {
    // Query already registered — safe to ignore in idempotent init
  } else {
    throw err;
  }
}
```

---

## QueryNotDefinedError

Thrown when you try to subscribe to or run a query that hasn't been defined.

**Hierarchy:** `QueryNotDefinedError` → `Error`

**Source:** [`src/core/query-errors.ts`](../../src/core/query-errors.ts)

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `'QueryNotDefinedError'` | Error name |
| `message` | `string` | `Query "<query>" is not defined` |
| `query` | `string` | The unknown query name |

### When It's Thrown

- **`store.subscribe(name, callback)`** — no query with this name has been defined.
- **`store.subscribe(name, params, callback)`** — same.
- **`store.runQuery(name, params?)`** — same.

### Example — triggering the error

```typescript
// No query defined yet
store.subscribe('topProducts', (result) => {
  console.log(result);
});
// Throws QueryNotDefinedError: Query "topProducts" is not defined
```

### Recommended Handling

This is a programming error — a typo or a missing `defineQuery()` call. Ensure all queries are defined before subscribing:

```typescript
try {
  store.subscribe(queryName, callback);
} catch (err) {
  if (err instanceof QueryNotDefinedError) {
    console.error(`Unknown query: ${err.query}`);
  }
  throw err;
}
```

---

## Error Handling Patterns

### Catch-all pattern

When you need to handle store errors generically:

```typescript
import {
  ValidationError,
  UniqueConstraintError,
  TransactionConflictError,
} from '@hamicek/noex-store';

try {
  await users.insert(data);
} catch (err) {
  if (err instanceof ValidationError) {
    // Schema violation — show issues to user
    return { errors: err.issues };
  }
  if (err instanceof UniqueConstraintError) {
    // Duplicate value — show specific field conflict
    return { errors: [{ field: err.field, message: `Already taken` }] };
  }
  // Unexpected — rethrow
  throw err;
}
```

### Name-based identification

When working across module boundaries where `instanceof` may not work (e.g., multiple package versions), use the `name` property:

```typescript
try {
  await users.insert(data);
} catch (err) {
  if (err instanceof Error && err.name === 'ValidationError') {
    // Safe cross-version check
  }
}
```

---

## See Also

- [Schema and Types](./schema.md) — `FieldDefinition` constraints that trigger `ValidationError`
- [Transactions](./transactions.md) — optimistic locking and `TransactionConflictError` retry patterns
- [Store](./store.md) — `defineBucket()`, `defineQuery()`, and `bucket()` methods that throw bucket/query errors
- [Reactive Queries](./reactive-queries.md) — `subscribe()` and `runQuery()` that throw `QueryNotDefinedError`
- **Learn:** [Field Constraints](../learn/03-schema-validation/01-field-constraints.md) — schema constraints in practice
- **Learn:** [Unique Constraints](../learn/03-schema-validation/03-unique-constraints.md) — unique indexes and `UniqueConstraintError`
- **Learn:** [Optimistic Locking](../learn/07-transactions/03-optimistic-locking.md) — `TransactionConflictError` with retry patterns
- **Source:** [`src/core/store.ts`](../../src/core/store.ts) — `BucketAlreadyExistsError`, `BucketNotDefinedError`, `UniqueConstraintError`, `TransactionConflictError`
- **Source:** [`src/core/schema-validator.ts`](../../src/core/schema-validator.ts) — `ValidationError`, `ValidationIssue`
- **Source:** [`src/core/query-errors.ts`](../../src/core/query-errors.ts) — `QueryAlreadyDefinedError`, `QueryNotDefinedError`
