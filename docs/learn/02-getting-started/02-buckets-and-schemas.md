# Buckets and Schemas

A store without buckets is an empty container. Buckets are where data lives — each one is a named, schema-enforced collection backed by its own actor. In this chapter you'll learn how to define buckets, declare schemas with field types and constraints, and understand how the store organizes bucket actors under its supervision tree.

## What You'll Learn

- How to define a bucket with `defineBucket()` and what each configuration option does
- How to declare field types: `string`, `number`, `boolean`, `object`, `array`, `date`
- How constraints like `required`, `enum`, `default`, `generated`, `unique`, `min/max`, `minLength/maxLength`, `pattern`, and `format` work
- How the key field identifies records in a bucket
- How the store organizes bucket actors under a Supervisor

## Defining a Bucket

A bucket is created with `store.defineBucket(name, definition)`:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'app' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true, minLength: 1 },
    email: { type: 'string', format: 'email', unique: true },
    role:  { type: 'string', enum: ['admin', 'user', 'guest'], default: 'user' },
  },
  indexes: ['email', 'role'],
  ttl: '90d',
  maxSize: 50_000,
});
```

`defineBucket()` is async because it starts a GenServer actor for the bucket and (if persistence is enabled) loads previously stored data. After the promise resolves, the bucket is ready for CRUD operations.

### What Happens Inside

When you call `defineBucket('users', definition)`, the store:

```text
  defineBucket('users', definition)
        │
        ├── 1. Validate definition (key field exists in schema, index fields exist)
        ├── 2. Load persisted data (if persistence enabled and bucket is persistent)
        ├── 3. Start BucketServer actor (GenServer with schema, indexes, data)
        ├── 4. Register actor under Supervisor (one_for_one restart)
        ├── 5. Register with Persistence layer (if applicable)
        └── 6. Register with TtlManager (if ttl is set)
```

### Bucket Definition Reference

| Property | Type | Required | Default | Purpose |
|----------|------|----------|---------|---------|
| `key` | `string` | Yes | — | Name of the primary key field. Must exist in `schema`. |
| `schema` | `SchemaDefinition` | Yes | — | Field definitions with types and constraints. |
| `indexes` | `string[]` | No | `[]` | Fields to index for fast lookups. Each must exist in `schema`. |
| `etsType` | `EtsTableType` | No | `'set'` | Storage type: `'set'`, `'ordered_set'`, `'bag'`, `'duplicate_bag'`. |
| `persistent` | `boolean` | No | `true` (if store has persistence) | Set to `false` to exclude this bucket from persistence. |
| `ttl` | `number \| string` | No | `undefined` | Time-to-live per record. Number = ms, string = human-readable. |
| `maxSize` | `number` | No | `undefined` | Maximum records. Oldest (by `_createdAt`) evicted on overflow. |

## The Key Field

Every bucket must declare a `key` — the field that uniquely identifies each record. It's similar to a primary key in a database:

```typescript
await store.defineBucket('products', {
  key: 'sku',  // Primary key is the 'sku' field
  schema: {
    sku:   { type: 'string', required: true },
    name:  { type: 'string', required: true },
    price: { type: 'number', min: 0 },
  },
});

const products = store.bucket('products');

// Insert — the key field value identifies this record
await products.insert({ sku: 'WIDGET-01', name: 'Widget', price: 9.99 });

// Get by key
const widget = await products.get('WIDGET-01');

// Update by key
await products.update('WIDGET-01', { price: 12.99 });

// Delete by key
await products.delete('WIDGET-01');
```

The key field is validated as part of the schema but cannot be modified via `update()` — it's immutable after insertion.

### Auto-Generated Keys

For most buckets, you'll want the key to be auto-generated rather than manually provided:

```typescript
// UUID key — globally unique, random
await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    amount: { type: 'number', required: true },
  },
});

// Autoincrement key — sequential numbers
await store.defineBucket('logs', {
  key: 'id',
  schema: {
    id:      { type: 'number', generated: 'autoincrement' },
    message: { type: 'string', required: true },
  },
});

const orders = store.bucket('orders');
const logs = store.bucket('logs');

const order = await orders.insert({ amount: 99.50 });
console.log(order.id); // 'a1b2c3d4-e5f6-…' (UUID)

const log1 = await logs.insert({ message: 'First' });
const log2 = await logs.insert({ message: 'Second' });
console.log(log1.id); // 1
console.log(log2.id); // 2
```

When a field has `generated`, you don't provide it during insertion — the store fills it automatically. If you do provide a value, the generated value is used instead (the provided value is ignored).

## Schema Definition

A schema is a `Record<string, FieldDefinition>` — an object where each key is a field name and each value describes the field's type and constraints:

```typescript
const schema = {
  id:        { type: 'string', generated: 'uuid' },
  name:      { type: 'string', required: true, minLength: 1, maxLength: 100 },
  email:     { type: 'string', format: 'email', unique: true },
  age:       { type: 'number', min: 0, max: 150 },
  role:      { type: 'string', enum: ['admin', 'user', 'guest'], default: 'user' },
  bio:       { type: 'string', pattern: '^[A-Za-z]' },
  tags:      { type: 'array', default: [] },
  settings:  { type: 'object', default: {} },
  active:    { type: 'boolean', default: true },
  birthDate: { type: 'date' },
};
```

Every field in the schema is validated on every `insert` and `update`. Fields not declared in the schema are silently passed through — the schema validates only what it declares.

### Field Types

noex-store supports six field types:

| Type | JavaScript Value | Example | Notes |
|------|-----------------|---------|-------|
| `string` | `string` | `'hello'`, `''` | |
| `number` | `number` | `42`, `3.14` | `NaN` is rejected |
| `boolean` | `boolean` | `true`, `false` | |
| `object` | `Record<string, unknown>` | `{ theme: 'dark' }` | Not `null`, not an array |
| `array` | `unknown[]` | `['a', 'b']` | |
| `date` | `Date`, `number`, `string` | `'2025-01-15'` | Accepts Date objects, timestamps, or ISO strings |

Type validation runs before constraint validation. If the type doesn't match, the store reports a type error and skips constraint checks for that field.

### Constraints

Constraints add rules beyond the basic type check:

#### `required`

The field must be present and non-null/non-undefined:

```typescript
name: { type: 'string', required: true }

// OK: { name: 'Alice' }
// Fail: { name: undefined }
// Fail: { name: null }
// Fail: {} (name is missing)
```

#### `enum`

The value must be one of the listed options:

```typescript
role: { type: 'string', enum: ['admin', 'user', 'guest'] }

// OK: { role: 'admin' }
// Fail: { role: 'superadmin' }
```

Works with any type, not just strings:

```typescript
priority: { type: 'number', enum: [1, 2, 3] }
```

#### `default`

Applied when the field is missing (`undefined`) during insertion. Can be a static value or a function:

```typescript
role:      { type: 'string', default: 'user' },
tags:      { type: 'array', default: [] },
createdBy: { type: 'string', default: () => getCurrentUser() },
```

Static defaults are used as-is. Function defaults are called on each insert — useful for values that should differ per record (like mutable objects or computed values).

#### `generated`

Auto-generate the field value on insert. Four strategies:

| Strategy | Type | Example Value |
|----------|------|---------------|
| `'uuid'` | `string` | `'a1b2c3d4-e5f6-7890-abcd-ef1234567890'` |
| `'cuid'` | `string` | `'clx1abc2d0001...'` |
| `'autoincrement'` | `number` | `1`, `2`, `3`, … |
| `'timestamp'` | `string` | `'2025-01-15T12:00:00.000Z'` (ISO-8601) |

```typescript
id:        { type: 'string', generated: 'uuid' },
createdAt: { type: 'string', generated: 'timestamp' },
seq:       { type: 'number', generated: 'autoincrement' },
```

Generated fields are:
- Filled automatically on insert (if the value is `undefined`)
- Stripped from update payloads — you can't override them after creation

#### `unique`

Enforces uniqueness across all records in the bucket:

```typescript
email: { type: 'string', format: 'email', unique: true }
```

If you try to insert or update a record with a duplicate value, the store throws a `UniqueConstraintError`:

```typescript
await users.insert({ name: 'Alice', email: 'alice@example.com' });

try {
  await users.insert({ name: 'Bob', email: 'alice@example.com' });
} catch (err) {
  // UniqueConstraintError: field "email" already has value "alice@example.com"
  console.log(err.name);  // 'UniqueConstraintError'
  console.log(err.field); // 'email'
  console.log(err.value); // 'alice@example.com'
}
```

Unique constraints are backed by an automatic index — declaring `unique: true` also creates an index on that field.

#### `min` / `max`

Numeric range validation (inclusive):

```typescript
age:   { type: 'number', min: 0, max: 150 },
price: { type: 'number', min: 0.01 },
```

#### `minLength` / `maxLength`

String length validation:

```typescript
name:     { type: 'string', minLength: 1, maxLength: 100 },
password: { type: 'string', minLength: 8 },
```

#### `pattern`

Regex pattern for strings:

```typescript
slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
code: { type: 'string', pattern: '^[A-Z]{3}-\\d{4}$' },
```

The pattern string is compiled into a `RegExp` internally. It must match the entire value (anchors recommended).

#### `format`

Built-in format validators for common string patterns:

| Format | Validates |
|--------|-----------|
| `'email'` | Email address format |
| `'url'` | URL format |
| `'iso-date'` | ISO-8601 date format |

```typescript
email:    { type: 'string', format: 'email' },
website:  { type: 'string', format: 'url' },
birthday: { type: 'string', format: 'iso-date' },
```

### ValidationError

When a write violates any constraint, the store throws a `ValidationError` with structured issue details:

```typescript
try {
  await users.insert({ name: '', email: 'not-an-email', age: -5 });
} catch (err) {
  console.log(err.name);    // 'ValidationError'
  console.log(err.issues);
  // [
  //   { field: 'name',  message: 'Minimum length is 1',   code: 'minLength' },
  //   { field: 'email', message: 'Invalid email format',  code: 'format' },
  //   { field: 'age',   message: 'Minimum value is 0',    code: 'min' },
  // ]
}
```

Each issue contains:

| Property | Type | Description |
|----------|------|-------------|
| `field` | `string` | The field name that failed validation |
| `message` | `string` | Human-readable description of the failure |
| `code` | `string` | Machine-readable code: `required`, `type`, `enum`, `minLength`, `maxLength`, `pattern`, `format`, `min`, `max` |

The record is never stored when validation fails. All issues are collected and reported together — the validator doesn't stop at the first error.

## Indexes

Declare indexes for fields you frequently filter by:

```typescript
await store.defineBucket('products', {
  key: 'sku',
  schema: {
    sku:      { type: 'string', required: true },
    category: { type: 'string', required: true },
    brand:    { type: 'string', required: true },
    price:    { type: 'number', min: 0 },
  },
  indexes: ['category', 'brand'],
});
```

With indexes declared, `where({ category: 'electronics' })` uses an O(1) hash lookup instead of scanning all records. Without an index, the store falls back to a full scan.

Every field in `indexes` must exist in the schema — the store validates this when you call `defineBucket()`.

Unique constraints (`unique: true`) also create an index automatically. You don't need to add the field to `indexes` separately.

## The Supervision Tree

Each bucket runs as an independent GenServer actor. The store's Supervisor manages all bucket actors with a `one_for_one` restart strategy:

```text
                         ┌──────────────────────┐
                         │        Store         │
                         │   (orchestrator)     │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │      Supervisor      │
                         │   one_for_one        │
                         └──┬───────┬───────┬───┘
                            │       │       │
                    ┌───────▼──┐ ┌──▼─────┐ ┌▼────────┐
                    │  Bucket  │ │ Bucket │ │  Bucket │
                    │  Server  │ │ Server │ │  Server │
                    │  users   │ │ orders │ │ sessions│
                    └──────────┘ └────────┘ └─────────┘

  Each BucketServer encapsulates:
  ┌───────────────────────────────┐
  │  BucketServer (GenServer)     │
  │                               │
  │  ┌─────────────────────────┐  │
  │  │  Data (Map<key, record>)│  │
  │  ├─────────────────────────┤  │
  │  │  SchemaValidator        │  │
  │  ├─────────────────────────┤  │
  │  │  IndexManager           │  │
  │  ├─────────────────────────┤  │
  │  │  Event Publishing       │  │
  │  └─────────────────────────┘  │
  └───────────────────────────────┘
```

### Why Actors?

- **Isolation**: Each bucket is an independent process. A bug in one bucket doesn't crash the others.
- **Serialization**: All operations on a bucket are serialized through its GenServer mailbox. No locks, no races.
- **Restart**: If a bucket actor crashes, the Supervisor restarts it automatically. Other buckets continue unaffected.

### BucketHandle — The Stateless Proxy

You never interact with the BucketServer actor directly. Instead, you use a `BucketHandle` — a lightweight proxy that sends messages to the actor:

```typescript
// Get a handle (this is cheap — it holds no data, just a reference)
const users = store.bucket('users');

// Every call goes through GenServer.call to the BucketServer
await users.insert({ name: 'Alice' });    // → GenServer.call(ref, { type: 'insert', … })
await users.get('some-id');               // → GenServer.call(ref, { type: 'get', … })
await users.where({ role: 'admin' });     // → GenServer.call(ref, { type: 'where', … })
```

You can create as many handles as you want — they all point to the same actor. There's no connection pooling or handle lifecycle to manage.

## Dropping a Bucket

To remove a bucket and all its data:

```typescript
await store.dropBucket('users');
```

This terminates the bucket's actor, unregisters it from persistence and TTL management, and removes the definition. After dropping, `store.bucket('users')` throws a `BucketNotDefinedError`.

## Complete Example

A store with three buckets demonstrating different schema patterns:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'bucket-demo' });

  // Bucket with UUID key, format validation, unique constraint
  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:       { type: 'string', generated: 'uuid' },
      username: { type: 'string', required: true, minLength: 3, maxLength: 30, unique: true },
      email:    { type: 'string', format: 'email', unique: true },
      role:     { type: 'string', enum: ['admin', 'editor', 'viewer'], default: 'viewer' },
    },
    indexes: ['role'],
  });

  // Bucket with autoincrement key, pattern constraint, TTL
  await store.defineBucket('notifications', {
    key: 'id',
    schema: {
      id:      { type: 'number', generated: 'autoincrement' },
      userId:  { type: 'string', required: true },
      title:   { type: 'string', required: true, maxLength: 200 },
      channel: { type: 'string', enum: ['email', 'sms', 'push'], required: true },
      read:    { type: 'boolean', default: false },
    },
    indexes: ['userId', 'channel'],
    ttl: '30d',
    maxSize: 100_000,
  });

  // Bucket with manual string key, nested object defaults
  await store.defineBucket('settings', {
    key: 'userId',
    schema: {
      userId:      { type: 'string', required: true },
      theme:       { type: 'string', enum: ['light', 'dark', 'system'], default: 'system' },
      preferences: { type: 'object', default: () => ({ notifications: true, language: 'en' }) },
    },
  });

  // Use the buckets
  const users = store.bucket('users');
  const notifications = store.bucket('notifications');
  const settings = store.bucket('settings');

  const alice = await users.insert({ username: 'alice', email: 'alice@example.com', role: 'admin' });
  console.log(alice);
  // { id: 'a1b2…', username: 'alice', email: 'alice@example.com', role: 'admin',
  //   _version: 1, _createdAt: …, _updatedAt: … }

  const notif = await notifications.insert({ userId: alice.id, title: 'Welcome!', channel: 'email' });
  console.log(notif);
  // { id: 1, userId: 'a1b2…', title: 'Welcome!', channel: 'email', read: false,
  //   _version: 1, _createdAt: …, _updatedAt: …, _expiresAt: … }

  const prefs = await settings.insert({ userId: alice.id as string });
  console.log(prefs.theme);       // 'system' (default)
  console.log(prefs.preferences); // { notifications: true, language: 'en' } (function default)

  // Validation works
  try {
    await users.insert({ username: 'ab', email: 'bad', role: 'hacker' });
  } catch (err) {
    console.log(err.issues.map((i: any) => `${i.field}: ${i.code}`));
    // ['username: minLength', 'email: format', 'role: enum']
  }

  // Unique constraint works
  try {
    await users.insert({ username: 'alice', email: 'other@example.com' });
  } catch (err) {
    console.log(err.name); // 'UniqueConstraintError'
  }

  const stats = await store.getStats();
  console.log(`Buckets: ${stats.buckets.names.join(', ')}`);
  // Buckets: users, notifications, settings

  await store.stop();
}

main();
```

## Exercise

Design bucket definitions (key, schema, indexes) for a blog platform. You need three buckets: `authors`, `posts`, and `comments`. Consider:

- Authors have a unique username (3-30 characters), an email, and a bio (optional, max 500 characters)
- Posts have a title (required, 1-200 characters), a body, a status (`draft`, `published`, `archived`), and an author reference
- Comments belong to a post and an author, have a body (required, 1-2000 characters), and should auto-expire after 365 days
- The system needs to look up posts by author and status, and comments by post

Write the three `defineBucket()` calls.

<details>
<summary>Solution</summary>

```typescript
// Authors — UUID key, unique username and email
await store.defineBucket('authors', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    username: { type: 'string', required: true, minLength: 3, maxLength: 30, unique: true },
    email:    { type: 'string', format: 'email', required: true, unique: true },
    bio:      { type: 'string', maxLength: 500 },
  },
});

// Posts — UUID key, enum status with default, indexed for author and status lookups
await store.defineBucket('posts', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    title:    { type: 'string', required: true, minLength: 1, maxLength: 200 },
    body:     { type: 'string', required: true },
    status:   { type: 'string', enum: ['draft', 'published', 'archived'], default: 'draft' },
    authorId: { type: 'string', required: true, ref: 'authors' },
  },
  indexes: ['authorId', 'status'],
});

// Comments — UUID key, TTL for auto-expiration, indexed for post lookups
await store.defineBucket('comments', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    postId:   { type: 'string', required: true, ref: 'posts' },
    authorId: { type: 'string', required: true, ref: 'authors' },
    body:     { type: 'string', required: true, minLength: 1, maxLength: 2000 },
  },
  indexes: ['postId'],
  ttl: '365d',
});
```

**Key decisions:**
- All three buckets use `generated: 'uuid'` for the key — globally unique, no coordination needed.
- `unique: true` on `username` and `email` enforces uniqueness at the data layer (which also creates indexes automatically).
- `ref: 'authors'` and `ref: 'posts'` are metadata hints — the store doesn't enforce foreign keys, but they document the relationships.
- `indexes: ['authorId', 'status']` on posts enables fast lookups like `where({ authorId: '…' })` and `where({ status: 'published' })`.
- `indexes: ['postId']` on comments enables fast lookups like `where({ postId: '…' })`.
- `ttl: '365d'` on comments means they automatically expire after one year — no cleanup code needed.

</details>

## Summary

- `defineBucket(name, definition)` creates a schema-enforced collection backed by a GenServer actor
- The `key` field identifies records uniquely — it's immutable after insertion
- Keys can be auto-generated with `generated: 'uuid'`, `'cuid'`, `'autoincrement'`, or `'timestamp'`
- Six field types: `string`, `number`, `boolean`, `object`, `array`, `date`
- Constraints validate data on every write: `required`, `enum`, `default`, `generated`, `unique`, `min/max`, `minLength/maxLength`, `pattern`, `format`
- `ValidationError` collects all issues and reports them together — the record is never stored on failure
- `unique: true` enforces uniqueness and creates an automatic index
- Declare `indexes` for fields you filter by to get O(1) lookups instead of full scans
- Each bucket runs as an isolated actor under a Supervisor with `one_for_one` restart strategy
- `BucketHandle` is a stateless proxy — creating handles is free, all calls go through GenServer

## API Reference

- [Store API](../../reference/store.md) — `store.defineBucket()` and `store.bucket()` methods
- [Schema and Types](../../reference/schema.md) — `BucketDefinition`, `FieldDefinition`, all constraints and generated types

---

Next: [CRUD Operations](./03-crud-operations.md)
