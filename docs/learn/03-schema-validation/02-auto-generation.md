# Auto-Generation

Every record needs an identifier. Many records also need a creation timestamp. Writing `crypto.randomUUID()` and `Date.now()` in every insert call is tedious, error-prone, and easy to forget. Worse, different parts of the codebase might generate IDs in different formats — one module uses UUIDs, another uses sequential counters, a third uses random strings.

noex-store moves ID and timestamp generation into the schema. Declare `generated` on a field, and the store fills it automatically on every insert — consistently, correctly, every time.

## What You'll Learn

- The four generated types: `uuid`, `cuid`, `autoincrement`, and `timestamp`
- When each type is appropriate and what values it produces
- How `default` provides static or computed fallback values
- The priority order: explicit value > generated > default
- How generated fields behave on insert vs update

## Generated Types

A field with `generated` is automatically populated when a record is inserted and the field is missing from the input:

```typescript
schema: {
  id: { type: 'string', generated: 'uuid' },
}
```

Four strategies are available:

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │                     GENERATED TYPES                               │
  │                                                                   │
  │  uuid           ─── '550e8400-e29b-41d4-a716-446655440000'       │
  │                     RFC 4122 v4, 128-bit, globally unique         │
  │                                                                   │
  │  cuid           ─── 'c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'        │
  │                     Collision-resistant, 33 chars (c + 32 hex)    │
  │                                                                   │
  │  autoincrement  ─── 1, 2, 3, 4, …                                │
  │                     Sequential integer per bucket, starts at 1    │
  │                                                                   │
  │  timestamp      ─── 1706745600000                                 │
  │                     Unix milliseconds via Date.now()              │
  └──────────────────────────────────────────────────────────────────┘
```

### `uuid` — Universally Unique Identifier

Generates a v4 UUID: 128 random bits formatted as `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.

```typescript
await store.defineBucket('sessions', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
});

const sessions = store.bucket('sessions');

const s1 = await sessions.insert({ userId: 'alice' });
console.log(s1.id); // '550e8400-e29b-41d4-a716-446655440000'

const s2 = await sessions.insert({ userId: 'bob' });
console.log(s2.id); // 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
```

**When to use:** General-purpose primary keys. UUIDs are globally unique without coordination, making them safe for distributed systems and import/export scenarios.

### `cuid` — Collision-Resistant ID

Generates a collision-resistant identifier: a `c` prefix followed by 32 hexadecimal characters.

```typescript
await store.defineBucket('events', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'cuid' },
    type: { type: 'string', required: true },
  },
});

const events = store.bucket('events');

const e = await events.insert({ type: 'click' });
console.log(e.id); // 'c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'
```

**When to use:** When you need URL-safe, compact IDs that are still collision-resistant. CUIDs are shorter than UUIDs and contain no dashes or special characters.

### `autoincrement` — Sequential Integer

Uses a per-bucket counter that increments with each insert. Starts at 1.

```typescript
await store.defineBucket('invoices', {
  key: 'number',
  schema: {
    number: { type: 'number', generated: 'autoincrement' },
    amount: { type: 'number', required: true, min: 0 },
  },
});

const invoices = store.bucket('invoices');

const inv1 = await invoices.insert({ amount: 100 });
console.log(inv1.number); // 1

const inv2 = await invoices.insert({ amount: 250 });
console.log(inv2.number); // 2

const inv3 = await invoices.insert({ amount: 75 });
console.log(inv3.number); // 3
```

**When to use:** Human-readable sequential identifiers — invoice numbers, ticket IDs, order numbers. Note that autoincrement counters are not persisted by default; if you restart the store without persistence, the counter resets to 1.

### `timestamp` — Unix Milliseconds

Generates the current timestamp via `Date.now()`.

```typescript
await store.defineBucket('logs', {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    message:   { type: 'string', required: true },
    createdAt: { type: 'number', generated: 'timestamp' },
  },
});

const logs = store.bucket('logs');

const log = await logs.insert({ message: 'Server started' });
console.log(log.createdAt); // 1706745600000 (Unix ms)
```

**When to use:** When you need a domain-specific timestamp separate from the record metadata `_createdAt`. For example, an `event.occurredAt` that represents when something happened in the real world, not when the record was created.

> **Note:** Every record already gets `_createdAt` and `_updatedAt` metadata automatically. Use `generated: 'timestamp'` when you need an additional, application-level timestamp field.

## Choosing the Right Generated Type

| Need | Generated Type | Type | Example Value |
|------|---------------|------|---------------|
| Globally unique string ID | `'uuid'` | `'string'` | `'550e8400-e29b-…'` |
| Compact, URL-safe ID | `'cuid'` | `'string'` | `'c9a1b2c3d4e5f…'` |
| Human-readable sequential number | `'autoincrement'` | `'number'` | `1`, `2`, `3` |
| Current time in milliseconds | `'timestamp'` | `'number'` | `1706745600000` |

## Default Values

Where `generated` creates new values algorithmically, `default` provides a fixed fallback when a field is missing. Defaults come in two forms:

### Static Defaults

A plain value used as-is:

```typescript
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    name:   { type: 'string', required: true },
    role:   { type: 'string', default: 'viewer' },
    active: { type: 'boolean', default: true },
    score:  { type: 'number', default: 0 },
  },
});

const users = store.bucket('users');

const alice = await users.insert({ name: 'Alice' });
console.log(alice.role);   // 'viewer'
console.log(alice.active); // true
console.log(alice.score);  // 0
```

### Functional Defaults

A function called on each insert, producing a fresh value every time. Essential for mutable types like arrays and objects:

```typescript
await store.defineBucket('profiles', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true },
    tags:     { type: 'array', default: () => [] },
    settings: { type: 'object', default: () => ({ theme: 'light', lang: 'en' }) },
  },
});

const profiles = store.bucket('profiles');

const p1 = await profiles.insert({ name: 'Alice' });
const p2 = await profiles.insert({ name: 'Bob' });

console.log(p1.tags);     // []
console.log(p2.tags);     // []
console.log(p1.tags === p2.tags); // false — distinct array instances
```

**Why functions for arrays and objects?** A static default like `default: []` would share the same array reference across all records. Mutating one record's tags would mutate them all. A function default creates a new instance for each insert.

## Priority Order: Explicit > Generated > Default

When a field has multiple sources of values, the priority is:

```text
  ┌─────────────────────────────────────────────────────────────┐
  │                     VALUE PRIORITY                           │
  │                                                              │
  │  1. Explicit value ─── provided in the insert input          │
  │     └─ used as-is, no generation or default applied          │
  │                                                              │
  │  2. Generated      ─── field has `generated` and no explicit │
  │     └─ store generates the value                             │
  │                                                              │
  │  3. Default        ─── field has `default`, still undefined  │
  │     └─ static value or function result applied               │
  │                                                              │
  │  4. undefined      ─── none of the above                     │
  │     └─ field is absent from the record                       │
  └─────────────────────────────────────────────────────────────┘
```

This means you can always override a generated field by providing a value explicitly:

```typescript
await store.defineBucket('items', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

const items = store.bucket('items');

// Generated — store creates a UUID
const auto = await items.insert({ name: 'Auto ID' });
console.log(auto.id); // 'a1b2c3d4-…' (generated UUID)

// Explicit — your value is used, generation skipped
const manual = await items.insert({ id: 'custom-id-001', name: 'Manual ID' });
console.log(manual.id); // 'custom-id-001'
```

And if a field has both `generated` and `default`, the generated value takes priority:

```typescript
schema: {
  id: { type: 'string', generated: 'uuid', default: 'fallback' },
}

// When id is missing: generated UUID is used, not 'fallback'
// The default would only apply if the field were not generated
```

## Generated Fields on Update

Generated fields are **protected on update**. The store strips them from the update payload, preventing accidental or malicious overwrites:

```typescript
const items = store.bucket('items');

const item = await items.insert({ name: 'Widget' });
console.log(item.id); // 'a1b2c3d4-…'

// Attempting to change the generated id — silently ignored
const updated = await items.update(item.id, { id: 'hacked-id', name: 'Updated Widget' });
console.log(updated.id);   // 'a1b2c3d4-…' (unchanged)
console.log(updated.name); // 'Updated Widget' (changed)
```

This protection applies to all generated fields, not just the primary key. If you have a `createdAt` field with `generated: 'timestamp'`, it can't be overwritten via `update()`.

The same stripping applies to:
- **Primary key** — can never change
- **Generated fields** — protected from update
- **Metadata fields** (`_version`, `_createdAt`, `_updatedAt`) — managed by the store

## Complete Working Example

A bug tracker with generated IDs, timestamps, and defaults:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'auto-generation' });

  await store.defineBucket('bugs', {
    key: 'id',
    schema: {
      id:          { type: 'number', generated: 'autoincrement' },
      title:       { type: 'string', required: true, minLength: 5 },
      severity:    { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
      assignee:    { type: 'string' },
      reportedAt:  { type: 'number', generated: 'timestamp' },
      tags:        { type: 'array', default: () => [] },
      metadata:    { type: 'object', default: () => ({ source: 'manual' }) },
    },
  });

  const bugs = store.bucket('bugs');

  // Insert with minimal input — generated + defaults fill the rest
  const bug1 = await bugs.insert({ title: 'Login page crashes on submit' });
  console.log('Bug #' + String(bug1.id));         // Bug #1
  console.log('Severity:', bug1.severity);          // medium (default)
  console.log('Reported at:', bug1.reportedAt);     // 1706745600000 (generated timestamp)
  console.log('Tags:', bug1.tags);                  // [] (functional default)
  console.log('Metadata:', bug1.metadata);          // { source: 'manual' } (functional default)

  // Insert with explicit overrides
  const bug2 = await bugs.insert({
    title: 'Database timeout on large queries',
    severity: 'critical',
    assignee: 'alice',
    tags: ['backend', 'performance'],
    metadata: { source: 'monitoring', alertId: 'ALT-42' },
  });
  console.log('\nBug #' + String(bug2.id));         // Bug #2
  console.log('Severity:', bug2.severity);            // critical (explicit, not default)
  console.log('Tags:', bug2.tags);                    // ['backend', 'performance'] (explicit)

  // Try to overwrite generated fields via update — silently stripped
  const updated = await bugs.update(bug1.id, {
    id: 999,                    // stripped — primary key
    reportedAt: 0,              // stripped — generated field
    severity: 'high',           // applied — regular field
  });
  console.log('\nAfter update:');
  console.log('ID:', updated.id);                    // 1 (unchanged)
  console.log('Reported at:', updated.reportedAt);   // 1706745600000 (unchanged)
  console.log('Severity:', updated.severity);         // high (updated)
  console.log('Version:', updated._version);          // 2 (incremented by store)

  // Sequential autoincrement
  const bug3 = await bugs.insert({ title: 'Pagination offset off by one' });
  console.log('\nBug #' + String(bug3.id));          // Bug #3

  await store.stop();
}

main();
```

## Exercise

You're building an order system. Design a bucket schema for `orders` with these requirements:

1. `id` — auto-generated UUID
2. `orderNumber` — auto-generated sequential number
3. `placedAt` — auto-generated timestamp (when the order was placed)
4. `status` — defaults to `'pending'`, restricted to `['pending', 'processing', 'shipped', 'delivered']`
5. `items` — required, array of order items
6. `shippingAddress` — required, object
7. `notes` — optional string, max 500 characters
8. `priority` — defaults to `'standard'`, restricted to `['express', 'standard', 'economy']`

Then write code that:
- Inserts an order with only `items` and `shippingAddress`
- Verifies that `id`, `orderNumber`, `placedAt`, `status`, and `priority` were filled automatically
- Inserts a second order and verifies `orderNumber` incremented

<details>
<summary>Solution</summary>

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'exercise' });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:              { type: 'string', generated: 'uuid' },
      orderNumber:     { type: 'number', generated: 'autoincrement' },
      placedAt:        { type: 'number', generated: 'timestamp' },
      status:          { type: 'string', enum: ['pending', 'processing', 'shipped', 'delivered'], default: 'pending' },
      items:           { type: 'array', required: true },
      shippingAddress: { type: 'object', required: true },
      notes:           { type: 'string', maxLength: 500 },
      priority:        { type: 'string', enum: ['express', 'standard', 'economy'], default: 'standard' },
    },
  });

  const orders = store.bucket('orders');

  // Insert with only required fields
  const order1 = await orders.insert({
    items: [{ sku: 'WIDGET-01', qty: 2 }],
    shippingAddress: { street: '123 Main St', city: 'Prague', zip: '11000' },
  });

  // Verify auto-generated and default fields
  console.log('ID:', typeof order1.id === 'string' && order1.id.length > 0);  // true
  console.log('Order #:', order1.orderNumber);     // 1
  console.log('Placed at:', order1.placedAt > 0);  // true
  console.log('Status:', order1.status);            // 'pending'
  console.log('Priority:', order1.priority);        // 'standard'

  // Second order — orderNumber increments
  const order2 = await orders.insert({
    items: [{ sku: 'GADGET-05', qty: 1 }],
    shippingAddress: { street: '456 Oak Ave', city: 'Brno', zip: '60200' },
    priority: 'express',
  });
  console.log('Order #:', order2.orderNumber);     // 2
  console.log('Priority:', order2.priority);        // 'express' (explicit override)

  await store.stop();
}

main();
```

</details>

## Summary

- `generated: 'uuid'` creates a v4 UUID — best for globally unique string IDs
- `generated: 'cuid'` creates a collision-resistant, compact, URL-safe ID
- `generated: 'autoincrement'` uses a per-bucket sequential counter starting at 1
- `generated: 'timestamp'` captures the current time as Unix milliseconds
- `default` provides a static value or a function that produces a fresh value per insert
- Use functional defaults (`default: () => []`) for mutable types to avoid shared references
- Priority order: explicit value > generated > default
- Generated fields and primary keys are stripped from update payloads — they can't be overwritten
- Record metadata (`_version`, `_createdAt`, `_updatedAt`) is managed by the store automatically

## API Reference

- [Schema and Types](../../reference/schema.md) — `generated` field types: `uuid`, `cuid`, `autoincrement`, `timestamp`
- [Utilities](../../reference/utilities.md) — `generateUuid()`, `generateCuid()`, `generateTimestamp()` functions

---

Next: [Unique Constraints](./03-unique-constraints.md)
