# Learning noex-store

A comprehensive guide for Node.js developers who want to master reactive in-memory data management. This guide teaches not just the API, but the **way of thinking** in schema-enforced, event-driven data layers.

## Who Is This For?

- Node.js / TypeScript developers (intermediate+)
- You know async/await and basic event-driven patterns
- You don't need prior actor model or reactive programming experience
- You're looking for a structured way to manage application state with validation, indexing, and real-time subscriptions

## Learning Path

### Part 1: Introduction

Understand why a reactive data layer exists and what problems it solves.

| Chapter | Description |
|---------|-------------|
| [1.1 Why a Reactive Data Layer?](./01-introduction/01-why-a-data-layer.md) | Problems with scattered state, stale UIs, and duplicated validation |
| [1.2 Key Concepts](./01-introduction/02-key-concepts.md) | Overview of Store, Buckets, Schemas, Events, Reactive Queries, and Transactions |

### Part 2: Getting Started

Learn the fundamental building blocks.

| Chapter | Description |
|---------|-------------|
| [2.1 Your First Store](./02-getting-started/01-first-store.md) | Installation, `Store.start()`, lifecycle, and shutdown |
| [2.2 Buckets and Schemas](./02-getting-started/02-buckets-and-schemas.md) | `defineBucket()`, field types, schema definitions, and the supervision tree |
| [2.3 CRUD Operations](./02-getting-started/03-crud-operations.md) | Insert, get, update, delete, clear, all, and record metadata |

### Part 3: Schema and Validation

Enforce data integrity at the boundary.

| Chapter | Description |
|---------|-------------|
| [3.1 Field Constraints](./03-schema-validation/01-field-constraints.md) | Required, enum, min/max, pattern, format, and `ValidationError` |
| [3.2 Auto-Generation](./03-schema-validation/02-auto-generation.md) | UUID, CUID, autoincrement, timestamps, and default values |
| [3.3 Unique Constraints](./03-schema-validation/03-unique-constraints.md) | Unique fields, automatic indexes, and `UniqueConstraintError` |

### Part 4: Querying

Find and aggregate data efficiently.

| Chapter | Description |
|---------|-------------|
| [4.1 Filtering and Search](./04-querying/01-filtering-and-search.md) | `where()`, `findOne()`, `count()`, `first()`, `last()`, and AND logic |
| [4.2 Secondary Indexes](./04-querying/02-secondary-indexes.md) | Index definitions, `IndexManager`, and scan vs index performance |
| [4.3 Pagination and Aggregation](./04-querying/03-pagination-and-aggregation.md) | Cursor pagination, `sum`, `avg`, `min`, `max` |

### Part 5: Reactive Queries

Keep your UI in sync without polling.

| Chapter | Description |
|---------|-------------|
| [5.1 What Are Reactive Queries?](./05-reactive-queries/01-what-are-reactive-queries.md) | Why polling fails, Convex-style reactivity, and the subscription model |
| [5.2 Defining and Subscribing](./05-reactive-queries/02-defining-and-subscribing.md) | `defineQuery()`, `subscribe()`, `runQuery()`, and parameterized queries |
| [5.3 Dependency Tracking](./05-reactive-queries/03-dependency-tracking.md) | Bucket-level vs record-level tracking, proxy-based `QueryContext` |

### Part 6: Events

React to data changes across the system.

| Chapter | Description |
|---------|-------------|
| [6.1 Event System](./06-events/01-event-system.md) | `store.on(pattern, handler)`, event types, and wildcard patterns |
| [6.2 Event Patterns](./06-events/02-event-patterns.md) | Audit logs, notifications, and cascading deletes |

### Part 7: Transactions

Guarantee consistency across multiple buckets.

| Chapter | Description |
|---------|-------------|
| [7.1 Why Transactions?](./07-transactions/01-why-transactions.md) | The problem of inconsistent state in cross-bucket operations |
| [7.2 Using Transactions](./07-transactions/02-using-transactions.md) | `store.transaction()`, `tx.bucket()`, and read-your-own-writes |
| [7.3 Optimistic Locking](./07-transactions/03-optimistic-locking.md) | Version checks, `TransactionConflictError`, rollback, and two-phase commit |

### Part 8: Persistence

Survive restarts and recover gracefully.

| Chapter | Description |
|---------|-------------|
| [8.1 Persisting Data](./08-persistence/01-persisting-data.md) | `StorePersistenceConfig`, adapters, debounced snapshots, and per-bucket opt-out |
| [8.2 Recovery and Snapshots](./08-persistence/02-recovery-and-snapshots.md) | Restart recovery, `BucketSnapshot`, and manual flush |

### Part 9: TTL and Lifecycle

Control data expiration and memory usage.

| Chapter | Description |
|---------|-------------|
| [9.1 TTL Expiration](./09-ttl-lifecycle/01-ttl-expiration.md) | Duration syntax, `_expiresAt`, `TtlManager`, and `purgeTtl()` |
| [9.2 Size Limits and Eviction](./09-ttl-lifecycle/02-size-limits-and-eviction.md) | `maxSize`, LRU eviction, and memory-bounded buckets |

### Part 10: Architecture Deep Dive

Understand the internals.

| Chapter | Description |
|---------|-------------|
| [10.1 Supervision Tree](./10-architecture/01-supervision-tree.md) | Store, Supervisor, BucketServer GenServers, registry, and one-for-one strategy |
| [10.2 Data Flow](./10-architecture/02-data-flow.md) | Request lifecycle: insert through validate, index, store, and publish |

### Part 11: Rules Bridge

Integrate with the noex-rules engine.

| Chapter | Description |
|---------|-------------|
| [11.1 Bridge Setup](./11-rules-bridge/01-bridge-setup.md) | `bridgeStoreToRules()`, `EventReceiver`, and `BridgeOptions` |
| [11.2 Store-Driven Rules](./11-rules-bridge/02-store-driven-rules.md) | Bidirectional integration between store and rule engine |

### Part 12: Projects

Apply everything in real-world projects.

| Chapter | Description |
|---------|-------------|
| [12.1 Task Management](./12-projects/01-task-management.md) | Schemas, CRUD, indexes, reactive queries, transactions, and pagination |
| [12.2 Real-Time Analytics](./12-projects/02-realtime-analytics.md) | Aggregation, TTL, maxSize, and a reactive KPI dashboard |
| [12.3 Inventory with Rules](./12-projects/03-inventory-with-rules.md) | Store + rules bridge, transactions, events, and persistence |

## Chapter Format

Each chapter includes:

1. **Introduction** - What you'll learn and why it matters
2. **Theory** - Concept explanation with ASCII diagrams and comparison tables
3. **Example** - Complete runnable TypeScript code with progressive steps
4. **Exercise** - Practical task with hidden solution
5. **Summary** - Key takeaways
6. **Next Steps** - Link to next chapter

## Getting Help

- [API Reference](../reference/index.md) - Complete API reference documentation

---

Ready to start? Begin with [Why a Reactive Data Layer?](./01-introduction/01-why-a-data-layer.md)
