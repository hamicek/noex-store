// Types
export type {
  FieldType,
  GeneratedType,
  FormatType,
  EtsTableType,
  FieldDefinition,
  SchemaDefinition,
  BucketDefinition,
  RecordMeta,
  StoreRecord,
  BucketEventType,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
  BucketEvent,
  QueryBucket,
  QueryContext,
  QueryFn,
  PaginateOptions,
  PaginatedResult,
  QueryDependencies,
  StorePersistenceConfig,
} from './types/index.js';

// Utils
export {
  generateUuid,
  generateCuid,
  generateTimestamp,
  isValidEmail,
  isValidUrl,
  isValidIsoDate,
  parseTtl,
} from './utils/index.js';

// Core — Schema Validator
export type { ValidationIssue } from './core/schema-validator.js';
export { ValidationError, SchemaValidator } from './core/schema-validator.js';

// Core — Bucket Server
export type { BucketCallMsg, BucketCallReply, BucketRef, BucketSnapshot, BucketInitialData, BucketStats } from './core/bucket-server.js';
export { createBucketBehavior } from './core/bucket-server.js';

// Core — Index Manager
export { IndexManager } from './core/index-manager.js';

// Core — Bucket Handle
export { BucketHandle } from './core/bucket-handle.js';

// Core — Store
export type { StoreOptions, StoreStats } from './core/store.js';
export { Store, BucketAlreadyExistsError, BucketNotDefinedError, UniqueConstraintError, TransactionConflictError } from './core/store.js';
export { QueryAlreadyDefinedError, QueryNotDefinedError } from './core/query-errors.js';

// Persistence
export { StorePersistence } from './persistence/store-persistence.js';

// Lifecycle
export { TtlManager } from './lifecycle/ttl-manager.js';

// Reactive
export { QueryContextImpl } from './reactive/query-context.js';
export { QueryManager } from './reactive/query-manager.js';

// Transaction
export { TransactionContext } from './transaction/transaction.js';
export { WriteBuffer, BucketWriteBuffer } from './transaction/write-buffer.js';
export { TransactionBucketHandle } from './transaction/transaction-bucket-handle.js';
export type {
  CommitBatchOp,
  CommitInsertOp,
  CommitUpdateOp,
  CommitDeleteOp,
  UndoOp,
  UndoInsertOp,
  UndoUpdateOp,
  UndoDeleteOp,
  CommitBatchResult,
} from './core/bucket-server.js';

// Bridge (re-export for convenience; primary import is '@hamicek/noex-store/bridge')
export { bridgeStoreToRules } from './bridge/rules-bridge.js';
export type { EventReceiver, BridgeOptions } from './bridge/rules-bridge.js';
