# Field Constraints

So far every schema you've written has defined field types, maybe marked some fields as `required`, and moved on. That works for simple cases. But real data has rules: an age can't be negative, a role must be one of three values, an email must look like an email. Without constraints, the boundary between valid and invalid data lives in scattered `if` statements that someone eventually forgets to write.

noex-store pushes validation to the schema. You declare constraints once, and every insert and update passes through them — no exceptions, no forgotten code paths.

## What You'll Learn

- How `required` prevents missing data and what counts as "missing"
- How `enum` restricts a field to an explicit set of allowed values
- How `min`, `max`, `minLength`, `maxLength` enforce numeric and string boundaries
- How `pattern` applies a regular expression to string fields
- How `format` validates common string shapes like email, URL, and ISO date
- How `ValidationError` reports multiple issues at once with structured error codes

## The `required` Constraint

By default, fields in a schema are optional. If you don't provide a value, the field is `undefined` in the stored record. Mark a field as `required: true` to reject inserts and updates where the field is missing or `null`:

```typescript
const store = await Store.start({ name: 'constraints' });

await store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    bio:  { type: 'string' }, // optional — undefined is fine
  },
});

const users = store.bucket('users');

// Works — name is provided, bio is optional
await users.insert({ name: 'Alice' });

// Fails — name is missing
try {
  await users.insert({});
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "users": name: Field is required
}
```

What counts as "missing" for `required`:
- `undefined` — the field is not in the input object
- `null` — the field is explicitly set to `null`

An empty string `""` is **not** missing — it's a present value. If you need to reject empty strings, combine `required` with `minLength`:

```typescript
name: { type: 'string', required: true, minLength: 1 }
```

## The `enum` Constraint

`enum` restricts a field to a fixed set of values. Any value not in the array is rejected:

```typescript
await store.defineBucket('tickets', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    status:   { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open' },
  },
});

const tickets = store.bucket('tickets');

// Works — 'high' is in the enum
await tickets.insert({ priority: 'high' });

// Fails — 'urgent' is not in the enum
try {
  await tickets.insert({ priority: 'urgent' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "tickets": priority: Value must be one of: low, medium, high, critical
}
```

`enum` works with any field type, not just strings:

```typescript
severity: { type: 'number', enum: [1, 2, 3, 4, 5] }
```

## Numeric Constraints: `min` and `max`

`min` and `max` define inclusive boundaries for number fields:

```typescript
await store.defineBucket('products', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true },
    price:    { type: 'number', required: true, min: 0 },
    quantity: { type: 'number', required: true, min: 0, max: 10_000 },
    rating:   { type: 'number', min: 1, max: 5 },
  },
});

const products = store.bucket('products');

// Works — all values within range
await products.insert({ name: 'Widget', price: 9.99, quantity: 100, rating: 4 });

// Fails — negative price
try {
  await products.insert({ name: 'Free Widget', price: -1, quantity: 0 });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "products": price: Minimum value is 0
}
```

Both boundaries are inclusive: `min: 0` accepts `0`, and `max: 100` accepts `100`.

## String Length Constraints: `minLength` and `maxLength`

`minLength` and `maxLength` constrain the `.length` of string values:

```typescript
await store.defineBucket('articles', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    title: { type: 'string', required: true, minLength: 3, maxLength: 200 },
    slug:  { type: 'string', required: true, minLength: 1, maxLength: 100 },
    body:  { type: 'string', required: true, minLength: 10 },
  },
});

const articles = store.bucket('articles');

// Fails — title is too short
try {
  await articles.insert({ title: 'Hi', slug: 'hi', body: 'This is the body text.' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "articles": title: Minimum length is 3
}
```

A common pattern: use `required: true` to prevent missing values and `minLength: 1` to prevent empty strings.

## The `pattern` Constraint

`pattern` applies a JavaScript regular expression to string fields. The value must match the pattern to pass validation:

```typescript
await store.defineBucket('airports', {
  key: 'code',
  schema: {
    code:    { type: 'string', required: true, pattern: '^[A-Z]{3}$' },
    name:    { type: 'string', required: true },
    country: { type: 'string', required: true, pattern: '^[A-Z]{2}$' },
  },
});

const airports = store.bucket('airports');

// Works — 'PRG' matches ^[A-Z]{3}$
await airports.insert({ code: 'PRG', name: 'Vaclav Havel Airport Prague', country: 'CZ' });

// Fails — 'prg' doesn't match (lowercase)
try {
  await airports.insert({ code: 'prg', name: 'Test', country: 'CZ' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "airports": code: Value must match pattern "^[A-Z]{3}$"
}
```

The pattern string is compiled with `new RegExp(pattern)` at validation time. Use `^` and `$` anchors to match the entire string. Without anchors, a partial match passes:

```typescript
// Without anchors: 'abc123' passes because '123' matches \d+
code: { type: 'string', pattern: '\\d+' }

// With anchors: 'abc123' fails because the whole string isn't digits
code: { type: 'string', pattern: '^\\d+$' }
```

## The `format` Constraint

`format` validates common string shapes without writing a regex yourself. Three formats are supported:

| Format | Accepts | Rejects |
|--------|---------|---------|
| `'email'` | `user@example.com` | `not-an-email` |
| `'url'` | `https://example.com` | `not-a-url` |
| `'iso-date'` | `2024-01-15` | `2024-13-99` |

```typescript
await store.defineBucket('contacts', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    email:   { type: 'string', required: true, format: 'email' },
    website: { type: 'string', format: 'url' },
    birthday:{ type: 'string', format: 'iso-date' },
  },
});

const contacts = store.bucket('contacts');

// Works
await contacts.insert({
  email: 'alice@example.com',
  website: 'https://alice.dev',
  birthday: '1990-05-20',
});

// Fails — invalid email
try {
  await contacts.insert({ email: 'alice' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "contacts": email: Invalid email format
}

// Fails — invalid iso-date
try {
  await contacts.insert({ email: 'bob@example.com', birthday: '2024-13-99' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "contacts": birthday: Invalid iso-date format
}
```

Use `format` for standard shapes. Use `pattern` when you need a custom regex.

## Combining Constraints

Constraints compose freely. The validator checks all of them for each field and collects every failure:

```typescript
await store.defineBucket('employees', {
  key: 'id',
  schema: {
    id:       { type: 'string', generated: 'uuid' },
    name:     { type: 'string', required: true, minLength: 2, maxLength: 100 },
    email:    { type: 'string', required: true, format: 'email' },
    role:     { type: 'string', required: true, enum: ['engineer', 'designer', 'manager'] },
    level:    { type: 'number', required: true, min: 1, max: 10 },
    badge:    { type: 'string', required: true, pattern: '^EMP-\\d{4}$' },
  },
});
```

This schema enforces:
- `name`: present, 2–100 characters
- `email`: present, valid email format
- `role`: present, one of three allowed values
- `level`: present, integer between 1 and 10
- `badge`: present, format `EMP-` followed by exactly 4 digits

## How Validation Works

```text
  insert / update
       │
       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  For each field in the schema:                               │
  │                                                              │
  │  1. required?    ── is the value missing (undefined / null)? │
  │     └─ yes → push issue { code: 'required' }, skip field    │
  │                                                              │
  │  2. absent?      ── value is undefined / null but not required│
  │     └─ yes → skip all remaining checks for this field       │
  │                                                              │
  │  3. type match?  ── does typeof match the declared type?     │
  │     └─ no  → push issue { code: 'type' }, skip field        │
  │                                                              │
  │  4. constraints  ── check enum, min, max, minLength,         │
  │                     maxLength, pattern, format                │
  │     └─ each failure → push issue with specific code          │
  │                                                              │
  │  After all fields: issues.length > 0 → throw ValidationError│
  └─────────────────────────────────────────────────────────────┘
```

Two key behaviors:

1. **All issues are collected.** The validator doesn't stop at the first failure. If three fields are invalid, you get three issues in one error.
2. **Type is checked before constraints.** If a field has the wrong type (e.g., a number where a string is expected), constraint checks like `minLength` are skipped for that field — they wouldn't make sense.

## `ValidationError` in Detail

`ValidationError` is a structured error with a machine-readable `issues` array:

```typescript
import { ValidationError } from '@hamicek/noex-store';

try {
  await employees.insert({ name: 'A', level: -1 });
} catch (err) {
  if (err instanceof ValidationError) {
    console.log(err.name);    // 'ValidationError'
    console.log(err.message); // 'Validation failed for bucket "employees": name: Minimum length is 2; ...'

    for (const issue of err.issues) {
      console.log(`  ${issue.field}: [${issue.code}] ${issue.message}`);
    }
    // Output:
    //   email: [required] Field is required
    //   role: [required] Field is required
    //   badge: [required] Field is required
    //   name: [minLength] Minimum length is 2
    //   level: [min] Minimum value is 1
  }
}
```

### The `ValidationIssue` Shape

| Field | Type | Description |
|-------|------|-------------|
| `field` | `string` | The schema field name that failed |
| `message` | `string` | Human-readable description of the failure |
| `code` | `string` | Machine-readable error code for programmatic handling |

### Error Codes Reference

| Code | Trigger | Example |
|------|---------|---------|
| `'required'` | Missing or `null` value on a required field | `name` is `undefined` |
| `'type'` | Value doesn't match the declared type | `string` expected, `number` given |
| `'enum'` | Value not in the allowed set | `'premium'` not in `['basic', 'vip']` |
| `'minLength'` | String shorter than minimum | `'A'` with `minLength: 2` |
| `'maxLength'` | String longer than maximum | `'ABCDE'` with `maxLength: 3` |
| `'min'` | Number below minimum | `-1` with `min: 0` |
| `'max'` | Number above maximum | `101` with `max: 100` |
| `'pattern'` | String doesn't match regex | `'ab1'` with `pattern: '^[A-Z]{3}$'` |
| `'format'` | Invalid email, URL, or ISO date | `'not-an-email'` with `format: 'email'` |

## Validation on Update

Constraints apply on updates too. The store merges the update payload into the existing record and validates the result:

```typescript
const employees = store.bucket('employees');

const alice = await employees.insert({
  name: 'Alice Smith',
  email: 'alice@example.com',
  role: 'engineer',
  level: 5,
  badge: 'EMP-0042',
});

// Works — level stays in range
await employees.update(alice.id, { level: 8 });

// Fails — level out of range
try {
  await employees.update(alice.id, { level: 99 });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "employees": level: Maximum value is 10
}

// Fails — can't change role to an invalid enum value
try {
  await employees.update(alice.id, { role: 'intern' });
} catch (err) {
  console.log(err.message);
  // Validation failed for bucket "employees": role: Value must be one of: engineer, designer, manager
}
```

## Supported Field Types

Every field must declare a `type`. Here are all six supported types and what values they accept:

| Type | Accepts | Rejects |
|------|---------|---------|
| `'string'` | Any `typeof === 'string'` | `123`, `true`, `null` |
| `'number'` | Any `typeof === 'number'` except `NaN` | `'42'`, `NaN`, `Infinity` is allowed |
| `'boolean'` | `true` or `false` | `'yes'`, `0`, `1` |
| `'object'` | Plain objects (`{}`) | Arrays, `null`, primitives |
| `'array'` | Arrays (`[]`) | Plain objects, strings |
| `'date'` | `Date` instances (valid), numbers (timestamps), strings | `boolean`, invalid `Date` |

Notable edge cases:
- **`NaN` is rejected** for `'number'` — it's technically a number in JavaScript but semantically meaningless as stored data
- **`null` is not an object** — `{ type: 'object' }` rejects `null` even though `typeof null === 'object'` in JavaScript
- **Arrays are not objects** — `{ type: 'object' }` rejects arrays; use `{ type: 'array' }` instead
- **`'date'` is flexible** — it accepts `Date` objects, numeric timestamps, and date strings

## Complete Working Example

A product catalog with comprehensive constraints:

```typescript
import { Store, ValidationError } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'field-constraints' });

  await store.defineBucket('products', {
    key: 'id',
    schema: {
      id:          { type: 'string', generated: 'uuid' },
      sku:         { type: 'string', required: true, pattern: '^[A-Z]{2}-\\d{4}$' },
      name:        { type: 'string', required: true, minLength: 2, maxLength: 120 },
      description: { type: 'string', maxLength: 1000 },
      price:       { type: 'number', required: true, min: 0 },
      category:    { type: 'string', required: true, enum: ['electronics', 'clothing', 'food', 'books'] },
      rating:      { type: 'number', min: 1, max: 5 },
      website:     { type: 'string', format: 'url' },
      active:      { type: 'boolean', default: true },
    },
  });

  const products = store.bucket('products');

  // Valid product — all constraints satisfied
  const laptop = await products.insert({
    sku: 'EL-0001',
    name: 'Laptop Pro 15',
    description: 'A professional-grade laptop.',
    price: 1299.99,
    category: 'electronics',
    rating: 5,
    website: 'https://example.com/laptop-pro',
  });
  console.log('Inserted:', laptop.sku, laptop.name);
  console.log('Active (default):', laptop.active); // true

  // Invalid product — multiple constraint violations
  try {
    await products.insert({
      sku: 'bad-sku',          // pattern violation
      name: 'X',              // minLength violation
      price: -10,             // min violation
      category: 'furniture',  // enum violation
      rating: 6,              // max violation
      website: 'not-a-url',   // format violation
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log(`\n${err.issues.length} validation issues:`);
      for (const issue of err.issues) {
        console.log(`  [${issue.code}] ${issue.field}: ${issue.message}`);
      }
      // Output:
      //   6 validation issues:
      //   [pattern] sku: Value must match pattern "^[A-Z]{2}-\d{4}$"
      //   [minLength] name: Minimum length is 2
      //   [min] price: Minimum value is 0
      //   [enum] category: Value must be one of: electronics, clothing, food, books
      //   [max] rating: Maximum value is 5
      //   [format] website: Invalid url format
    }
  }

  // Update with constraint violation
  try {
    await products.update(laptop.id, { price: -1 });
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log(`\nUpdate rejected: ${err.issues[0]!.message}`);
      // Update rejected: Minimum value is 0
    }
  }

  await store.stop();
}

main();
```

## Exercise

Write a bucket definition for a `users` collection that enforces these rules:

1. `id` — auto-generated UUID
2. `username` — required, 3–20 characters, only lowercase letters and digits (`^[a-z0-9]+$`)
3. `email` — required, valid email format
4. `age` — optional, but if provided must be between 13 and 150
5. `role` — required, one of `'admin'`, `'editor'`, `'viewer'`
6. `profileUrl` — optional, but if provided must be a valid URL

Then write code that:
- Inserts a valid user
- Attempts three invalid inserts (one violating `pattern`, one violating `min`, one violating `enum`)
- Catches each `ValidationError` and logs the `code` of the first issue

<details>
<summary>Solution</summary>

```typescript
import { Store, ValidationError } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'exercise' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:         { type: 'string', generated: 'uuid' },
      username:   { type: 'string', required: true, minLength: 3, maxLength: 20, pattern: '^[a-z0-9]+$' },
      email:      { type: 'string', required: true, format: 'email' },
      age:        { type: 'number', min: 13, max: 150 },
      role:       { type: 'string', required: true, enum: ['admin', 'editor', 'viewer'] },
      profileUrl: { type: 'string', format: 'url' },
    },
  });

  const users = store.bucket('users');

  // Valid insert
  const alice = await users.insert({
    username: 'alice42',
    email: 'alice@example.com',
    age: 30,
    role: 'admin',
    profileUrl: 'https://alice.dev',
  });
  console.log('Created user:', alice.username); // alice42

  // Invalid: pattern violation — uppercase letters in username
  try {
    await users.insert({ username: 'Alice', email: 'a@b.com', role: 'viewer' });
  } catch (err) {
    console.log('Error 1:', (err as ValidationError).issues[0]!.code); // pattern
  }

  // Invalid: min violation — age below 13
  try {
    await users.insert({ username: 'bob', email: 'bob@b.com', role: 'editor', age: 5 });
  } catch (err) {
    console.log('Error 2:', (err as ValidationError).issues[0]!.code); // min
  }

  // Invalid: enum violation — role 'superuser' not allowed
  try {
    await users.insert({ username: 'charlie', email: 'c@c.com', role: 'superuser' });
  } catch (err) {
    console.log('Error 3:', (err as ValidationError).issues[0]!.code); // enum
  }

  await store.stop();
}

main();
```

</details>

## Summary

- `required: true` rejects `undefined` and `null` — an empty string is still present
- `enum` restricts a field to a fixed list of allowed values, works with any type
- `min` / `max` define inclusive numeric boundaries
- `minLength` / `maxLength` constrain string length
- `pattern` applies a regex to string fields — use `^` and `$` anchors for full-string matching
- `format` validates `'email'`, `'url'`, or `'iso-date'` without custom regex
- Constraints compose freely — declare as many as needed on a single field
- `ValidationError` collects **all** issues in one throw, with `field`, `message`, and `code` per issue
- Validation runs on both insert and update — updates validate the merged record

## API Reference

- [Schema and Types](../../reference/schema.md) — complete `FieldDefinition` reference with all constraints
- [Errors](../../reference/errors.md) — `ValidationError` structure and `ValidationIssue` fields

---

Next: [Auto-Generation](./02-auto-generation.md)
