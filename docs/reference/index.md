# noex-store API Reference

> Complete reference documentation for `@hamicek/noex-store` — a schema-driven in-memory store built on the noex actor model.

## How to Use This Reference

This reference is organized by module. Each page documents every public method, type, and option with precise signatures, parameter tables, and short examples.

**Looking to learn the concepts first?** Start with the [Learning Guide](../learn/index.md), which teaches noex-store from the ground up with progressive examples and exercises.

**Already using noex-store?** Use this reference to quickly look up exact method signatures, option defaults, error conditions, and type definitions.

## Reference Documents

### Core

| Document | Description |
|----------|-------------|
| [Store](./store.md) | `Store.start()`, `defineBucket()`, `bucket()`, `defineQuery()`, `subscribe()`, `transaction()`, `on()`, and lifecycle methods |
| [BucketHandle](./bucket-handle.md) | CRUD operations, filtering, pagination, and aggregation — the fluent API for working with data |
| [Schema and Types](./schema.md) | `BucketDefinition`, `FieldDefinition`, field types, constraints, generated values, `RecordMeta`, and `SchemaValidator` |

### Reactivity and Events

| Document | Description |
|----------|-------------|
| [Reactive Queries](./reactive-queries.md) | `defineQuery()`, `subscribe()`, `QueryContext`, dependency tracking, and deep-equality diffing |
| [Events](./events.md) | `store.on()`, event types (`inserted`, `updated`, `deleted`), and wildcard pattern matching |

### Transactions

| Document | Description |
|----------|-------------|
| [Transactions](./transactions.md) | `store.transaction()`, `TransactionBucketHandle`, read-your-own-writes, optimistic locking, and `WriteBuffer` |

### Persistence and Lifecycle

| Document | Description |
|----------|-------------|
| [Persistence](./persistence.md) | `StorePersistenceConfig`, adapters, debounced snapshots, restore flow, and per-bucket configuration |
| [TTL and Lifecycle](./ttl-lifecycle.md) | TTL duration syntax, `TtlManager`, `maxSize` eviction, record metadata (`_version`, `_createdAt`, `_updatedAt`, `_expiresAt`) |

### Integration

| Document | Description |
|----------|-------------|
| [Rules Bridge](./bridge.md) | `bridgeStoreToRules()`, `EventReceiver`, `BridgeOptions`, and bidirectional store-rules integration |

### Utilities and Errors

| Document | Description |
|----------|-------------|
| [Utilities](./utilities.md) | ID generators (`generateUuid`, `generateCuid`), format validators (`isValidEmail`, `isValidUrl`, `isValidIsoDate`), `parseTtl`, and `deepEqual` |
| [Errors](./errors.md) | Complete catalog of error classes: `ValidationError`, `UniqueConstraintError`, `TransactionConflictError`, and more |

## Quick Import Guide

```typescript
// Main import — Store class and types
import { Store } from '@hamicek/noex-store';

// Types for bucket definitions
import type {
  BucketDefinition,
  FieldDefinition,
  SchemaDefinition,
  StoreRecord,
  RecordMeta,
} from '@hamicek/noex-store';

// Query types
import type {
  QueryFn,
  QueryContext,
  PaginateOptions,
  PaginatedResult,
} from '@hamicek/noex-store';

// Event types
import type {
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
} from '@hamicek/noex-store';

// Error classes
import {
  ValidationError,
  UniqueConstraintError,
  TransactionConflictError,
  BucketNotDefinedError,
  QueryNotDefinedError,
} from '@hamicek/noex-store';

// Utility functions
import {
  generateUuid,
  generateCuid,
  parseTtl,
} from '@hamicek/noex-store';

// Rules bridge (dedicated entry point)
import { bridgeStoreToRules } from '@hamicek/noex-store/bridge';
```

## Source Code

- [Source code](../../src/) — TypeScript source in `src/`
- [Tests](../../tests/) — Unit and integration tests in `tests/`
- [Package on npm](https://www.npmjs.com/package/@hamicek/noex-store) — `@hamicek/noex-store`

## See Also

- [Learning Guide](../learn/index.md) — Problem-first tutorials with exercises for learning noex-store from scratch
