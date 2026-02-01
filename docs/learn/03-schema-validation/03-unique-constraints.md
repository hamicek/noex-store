# Unique Constraints

You've validated types, ranges, and formats. But there's a class of constraint that no single field check can enforce: **uniqueness across all records**. When you add a user with `email: 'alice@example.com'`, you need a guarantee that no other user already has that email. With a plain `Map`, you'd have to query first, then insert — a check-then-act pattern that's inherently racy. Between the check and the insert, another write could slip in.

noex-store enforces unique constraints atomically. Declare `unique: true` on a field, and the store guarantees that no two records in the same bucket share the same value for that field.

## What You'll Learn

- How to declare unique constraints on schema fields
- How the store creates and maintains automatic indexes for unique fields
- How `UniqueConstraintError` reports violations with bucket, field, and value
- How unique constraints behave on insert vs update
- How `null` and `undefined` values interact with uniqueness
- The two-phase commit approach that prevents partial index corruption

## Declaring a Unique Constraint

Add `unique: true` to any field in the schema:

```typescript
const store = await Store.start({ name: 'unique-demo' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    username: { type: 'string', required: true, unique: true },
    email:    { type: 'string', required: true, format: 'email', unique: true },
    name:     { type: 'string', required: true },
  },
});

const users = store.bucket('users');

await users.insert({ username: 'alice', email: 'alice@example.com', name: 'Alice' });

// Fails — username 'alice' is already taken
try {
  await users.insert({ username: 'alice', email: 'bob@example.com', name: 'Bob' });
} catch (err) {
  console.log(err.message);
  // Unique constraint violation in bucket "users": field "username" already has value "alice"
}
```

You can have multiple unique fields on the same bucket. Each is enforced independently — a record must be unique on **each** field, not on the combination.

## Automatic Index Creation

When you declare `unique: true` on a field, the store automatically creates a **unique index** for that field. You don't need to add it to the `indexes` array separately:

```typescript
// These two definitions are equivalent for uniqueness:

// Option A: unique in schema (index created automatically)
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    email: { type: 'string', required: true, unique: true },
  },
});

// Option B: unique in schema + explicitly in indexes (same result)
await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    email: { type: 'string', required: true, unique: true },
  },
  indexes: ['email'],
});
```

Both produce the same unique index. The difference matters for non-unique fields: if a field has `unique: true`, it always gets a unique index; if a field is in the `indexes` array but doesn't have `unique: true`, it gets a non-unique index (allowing duplicates).

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │                     INDEX TYPES                                   │
  │                                                                   │
  │  unique: true              Non-unique (indexes array only)        │
  │  ┌──────────────────┐     ┌──────────────────────────────────┐   │
  │  │  value → key      │     │  value → Set<key>                │   │
  │  │  (1 : 1 mapping)  │     │  (1 : N mapping)                 │   │
  │  │                    │     │                                   │   │
  │  │  'alice@a.com'→k1 │     │  'admin' → { k1, k3 }           │   │
  │  │  'bob@b.com'  →k2 │     │  'user'  → { k2, k4, k5 }      │   │
  │  │  'carol@c.com'→k3 │     │  'guest' → { k6 }               │   │
  │  └──────────────────┘     └──────────────────────────────────┘   │
  │                                                                   │
  │  Enforces uniqueness        Allows duplicates                     │
  │  O(1) lookup by value       O(1) lookup by value                  │
  └──────────────────────────────────────────────────────────────────┘
```

## `UniqueConstraintError`

When a unique constraint is violated, the store throws a `UniqueConstraintError` with three properties:

```typescript
import { UniqueConstraintError } from '@hamicek/noex-store';

try {
  await users.insert({ username: 'alice', email: 'alice-new@example.com', name: 'Alice 2' });
} catch (err) {
  if (err instanceof UniqueConstraintError) {
    console.log(err.name);    // 'UniqueConstraintError'
    console.log(err.bucket);  // 'users'
    console.log(err.field);   // 'username'
    console.log(err.value);   // 'alice'
    console.log(err.message);
    // Unique constraint violation in bucket "users": field "username" already has value "alice"
  }
}
```

### The Error Shape

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Always `'UniqueConstraintError'` |
| `bucket` | `string` | The bucket where the violation occurred |
| `field` | `string` | The field that has a duplicate value |
| `value` | `unknown` | The duplicate value that was rejected |
| `message` | `string` | Human-readable description |

This is different from `ValidationError` which deals with field-level schema issues. `UniqueConstraintError` is a data-level constraint — the record is valid in isolation, but conflicts with an existing record.

## Unique Constraints on Insert

On insert, the store checks all unique indexes before writing any data. If any unique field has a value that already exists in the index, the insert is rejected entirely:

```typescript
const users = store.bucket('users');

await users.insert({ username: 'alice', email: 'alice@example.com', name: 'Alice' });
await users.insert({ username: 'bob', email: 'bob@example.com', name: 'Bob' });

// Fails — both username AND email are unique, but username is checked first
try {
  await users.insert({ username: 'alice', email: 'carol@example.com', name: 'Carol' });
} catch (err) {
  console.log((err as UniqueConstraintError).field); // 'username'
}

// Fails — username is unique, email conflicts with alice's
try {
  await users.insert({ username: 'carol', email: 'alice@example.com', name: 'Carol' });
} catch (err) {
  console.log((err as UniqueConstraintError).field); // 'email'
}
```

## Unique Constraints on Update

On update, the store checks whether the new value would conflict with a different record. Updating a record to the same value it already has is allowed (self-reference):

```typescript
const users = store.bucket('users');

const alice = await users.insert({ username: 'alice', email: 'alice@example.com', name: 'Alice' });
const bob = await users.insert({ username: 'bob', email: 'bob@example.com', name: 'Bob' });

// Works — changing alice's name, username stays the same (self-reference allowed)
await users.update(alice.id, { username: 'alice', name: 'Alice Smith' });

// Works — changing alice's email to a new, unused value
await users.update(alice.id, { email: 'alice.smith@example.com' });

// Fails — changing alice's email to bob's email
try {
  await users.update(alice.id, { email: 'bob@example.com' });
} catch (err) {
  console.log((err as UniqueConstraintError).field); // 'email'
  console.log((err as UniqueConstraintError).value); // 'bob@example.com'
}
```

## Null and Undefined Values

`null` and `undefined` values are **not indexed**. This means:

- Multiple records can have the same field as `null` or `undefined` without violating uniqueness
- You can't look up records by `null` via the unique index

```typescript
await store.defineBucket('accounts', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    phone: { type: 'string', unique: true }, // optional but unique when present
  },
});

const accounts = store.bucket('accounts');

// Both inserts succeed — null phone is not indexed, no conflict
await accounts.insert({ name: 'Alice' });          // phone: undefined
await accounts.insert({ name: 'Bob' });            // phone: undefined
await accounts.insert({ name: 'Carol', phone: null }); // phone: null

// But once a phone is set, it must be unique
await accounts.insert({ name: 'Dave', phone: '+420123456789' });

try {
  await accounts.insert({ name: 'Eve', phone: '+420123456789' });
} catch (err) {
  console.log((err as UniqueConstraintError).field); // 'phone'
}
```

This behavior is consistent with SQL databases where `NULL` values are not considered equal to each other in unique indexes.

## Two-Phase Commit

The store uses a two-phase approach to prevent partial index corruption. When inserting a record that has multiple unique fields:

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │                     TWO-PHASE INSERT                              │
  │                                                                   │
  │  Phase 1 — VALIDATE                                               │
  │  ┌──────────────────────────────────────────────────────────┐    │
  │  │  For each unique index:                                    │    │
  │  │    Check if the value already exists → UniqueConstraintError│   │
  │  │                                                            │    │
  │  │  If ANY check fails → throw, indexes unchanged             │    │
  │  └──────────────────────────────────────────────────────────┘    │
  │                                                                   │
  │  Phase 2 — WRITE (only if Phase 1 passed)                        │
  │  ┌──────────────────────────────────────────────────────────┐    │
  │  │  For each index (unique and non-unique):                   │    │
  │  │    Add the value → primaryKey mapping                      │    │
  │  └──────────────────────────────────────────────────────────┘    │
  │                                                                   │
  │  Result: Either ALL indexes are updated, or NONE are             │
  └──────────────────────────────────────────────────────────────────┘
```

Without this approach, a record with two unique fields could fail on the second check after the first index was already updated — leaving the indexes in an inconsistent state. The two-phase approach validates everything first, then writes everything.

## Unique vs Non-Unique Indexes

It's important to understand the difference between a unique index and a regular index:

```typescript
await store.defineBucket('employees', {
  key: 'id',
  schema: {
    id:         { type: 'string', generated: 'uuid' },
    badgeNumber:{ type: 'string', required: true, unique: true },
    department: { type: 'string', required: true },
    email:      { type: 'string', required: true, format: 'email', unique: true },
  },
  indexes: ['department'], // non-unique index for fast lookups
});
```

| Aspect | Unique Index (`unique: true`) | Non-Unique Index (`indexes: [...]`) |
|--------|-------------------------------|-------------------------------------|
| **Duplicates** | Rejected with `UniqueConstraintError` | Allowed — many records share the same value |
| **Data structure** | `Map<value, key>` (1:1) | `Map<value, Set<key>>` (1:N) |
| **Lookup result** | At most 1 record | 0 or more records |
| **Created by** | `unique: true` in schema | Field name in `indexes` array |
| **Primary use** | Data integrity (no duplicates) | Query performance (fast lookups) |

## Complete Working Example

A user registration system with unique username, email, and optional phone:

```typescript
import { Store, UniqueConstraintError, ValidationError } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'unique-constraints' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:       { type: 'string', generated: 'uuid' },
      username: { type: 'string', required: true, minLength: 3, maxLength: 20, unique: true },
      email:    { type: 'string', required: true, format: 'email', unique: true },
      phone:    { type: 'string', unique: true }, // optional but unique when present
      role:     { type: 'string', enum: ['admin', 'user'], default: 'user' },
    },
    indexes: ['role'], // non-unique index for querying by role
  });

  const users = store.bucket('users');

  // Register users
  const alice = await users.insert({
    username: 'alice',
    email: 'alice@example.com',
    phone: '+420111222333',
  });
  console.log('Registered:', alice.username, '(' + alice.email + ')');

  const bob = await users.insert({
    username: 'bob',
    email: 'bob@example.com',
    // No phone — multiple users can have no phone
  });
  console.log('Registered:', bob.username, '(' + bob.email + ')');

  // Duplicate username
  try {
    await users.insert({ username: 'alice', email: 'alice2@example.com' });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      console.log(`\nDuplicate ${err.field}: "${String(err.value)}" in ${err.bucket}`);
      // Duplicate username: "alice" in users
    }
  }

  // Duplicate email
  try {
    await users.insert({ username: 'carol', email: 'alice@example.com' });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      console.log(`Duplicate ${err.field}: "${String(err.value)}" in ${err.bucket}`);
      // Duplicate email: "alice@example.com" in users
    }
  }

  // Duplicate phone
  try {
    await users.insert({ username: 'dave', email: 'dave@example.com', phone: '+420111222333' });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      console.log(`Duplicate ${err.field}: "${String(err.value)}" in ${err.bucket}`);
      // Duplicate phone: "+420111222333" in users
    }
  }

  // Update: change alice's email to a new unique value
  const updated = await users.update(alice.id, { email: 'alice.new@example.com' });
  console.log('\nAlice email updated to:', updated.email);

  // Update: try to change alice's email to bob's email
  try {
    await users.update(alice.id, { email: 'bob@example.com' });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      console.log(`Cannot update: ${err.field} "${String(err.value)}" belongs to another user`);
      // Cannot update: email "bob@example.com" belongs to another user
    }
  }

  // ValidationError vs UniqueConstraintError
  try {
    await users.insert({ username: 'ab', email: 'short@example.com' }); // username too short
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('\nValidation (not uniqueness):', err.issues[0]!.code);
      // Validation (not uniqueness): minLength
    }
  }

  await store.stop();
}

main();
```

## Exercise

Design a `products` bucket for an e-commerce platform with these requirements:

1. `id` — auto-generated UUID
2. `sku` — required, unique, must match pattern `^[A-Z]{2}-\d{4}$`
3. `name` — required, 3–200 characters
4. `barcode` — optional, unique when present (EAN-13 pattern: `^\d{13}$`)
5. `category` — required, one of `['electronics', 'clothing', 'food', 'home']`
6. `price` — required, minimum 0

Then write code that demonstrates:
- Inserting two valid products
- Attempting a duplicate `sku` and catching `UniqueConstraintError`
- Inserting two products without `barcode` (both succeed)
- Attempting a duplicate `barcode` and catching the error
- Updating a product's `sku` to a taken value and catching the error

<details>
<summary>Solution</summary>

```typescript
import { Store, UniqueConstraintError } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'exercise' });

  await store.defineBucket('products', {
    key: 'id',
    schema: {
      id:       { type: 'string', generated: 'uuid' },
      sku:      { type: 'string', required: true, unique: true, pattern: '^[A-Z]{2}-\\d{4}$' },
      name:     { type: 'string', required: true, minLength: 3, maxLength: 200 },
      barcode:  { type: 'string', unique: true, pattern: '^\\d{13}$' },
      category: { type: 'string', required: true, enum: ['electronics', 'clothing', 'food', 'home'] },
      price:    { type: 'number', required: true, min: 0 },
    },
  });

  const products = store.bucket('products');

  // Two valid products
  const laptop = await products.insert({
    sku: 'EL-0001',
    name: 'Laptop Pro',
    barcode: '5901234123457',
    category: 'electronics',
    price: 999,
  });
  console.log('Created:', laptop.sku);

  const shirt = await products.insert({
    sku: 'CL-0001',
    name: 'Cotton T-Shirt',
    barcode: '4006381333931',
    category: 'clothing',
    price: 29.99,
  });
  console.log('Created:', shirt.sku);

  // Duplicate SKU
  try {
    await products.insert({ sku: 'EL-0001', name: 'Another Laptop', category: 'electronics', price: 500 });
  } catch (err) {
    console.log('Duplicate SKU:', (err as UniqueConstraintError).field); // 'sku'
  }

  // Two products without barcode — both succeed (null not indexed)
  await products.insert({ sku: 'FD-0001', name: 'Organic Apples', category: 'food', price: 3.50 });
  await products.insert({ sku: 'FD-0002', name: 'Fresh Bread', category: 'food', price: 2.00 });
  console.log('Two products without barcode: OK');

  // Duplicate barcode
  try {
    await products.insert({
      sku: 'HM-0001',
      name: 'Table Lamp',
      barcode: '5901234123457', // same as laptop
      category: 'home',
      price: 45,
    });
  } catch (err) {
    console.log('Duplicate barcode:', (err as UniqueConstraintError).field); // 'barcode'
  }

  // Update SKU to a taken value
  try {
    await products.update(shirt.id, { sku: 'EL-0001' }); // laptop's SKU
  } catch (err) {
    console.log('Update conflict:', (err as UniqueConstraintError).field); // 'sku'
  }

  await store.stop();
}

main();
```

</details>

## Summary

- `unique: true` on a schema field guarantees no two records in the bucket share the same value
- The store automatically creates a unique index for fields marked `unique: true` — no need to add them to `indexes`
- `UniqueConstraintError` provides `bucket`, `field`, and `value` properties for precise error handling
- On insert, all unique constraints are validated before any indexes are updated (two-phase commit)
- On update, self-reference is allowed — a record can "update" to the same value it already has
- `null` and `undefined` values are not indexed — multiple records can have `null` for a unique field
- `UniqueConstraintError` is separate from `ValidationError`: validation checks individual field rules, uniqueness checks cross-record integrity

---

Next: [Filtering and Search](../04-querying/01-filtering-and-search.md)
