import type {
  CallResult,
  GenServerBehavior,
  GenServerRef,
} from '@hamicek/noex';
import { EventBus, type EventBusRef } from '@hamicek/noex';
import type {
  BucketDefinition,
  BucketDeletedEvent,
  BucketEvent,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  PaginatedResult,
  StoreRecord,
} from '../types/index.js';
import { IndexManager } from './index-manager.js';
import { SchemaValidator } from './schema-validator.js';
import { TransactionConflictError } from './store.js';
import { parseTtl } from '../utils/parse-ttl.js';

// ── Persistence types ─────────────────────────────────────────────

export interface BucketSnapshot {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}

export interface BucketInitialData {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}

// ── Transaction batch types ─────────────────────────────────────

export interface CommitInsertOp {
  readonly type: 'insert';
  readonly key: unknown;
  readonly record: StoreRecord;
}

export interface CommitUpdateOp {
  readonly type: 'update';
  readonly key: unknown;
  readonly newRecord: StoreRecord;
  readonly expectedVersion: number;
}

export interface CommitDeleteOp {
  readonly type: 'delete';
  readonly key: unknown;
  readonly expectedVersion: number;
}

export type CommitBatchOp = CommitInsertOp | CommitUpdateOp | CommitDeleteOp;

export interface UndoInsertOp {
  readonly type: 'undo_insert';
  readonly key: unknown;
}

export interface UndoUpdateOp {
  readonly type: 'undo_update';
  readonly key: unknown;
  readonly oldRecord: StoreRecord;
}

export interface UndoDeleteOp {
  readonly type: 'undo_delete';
  readonly key: unknown;
  readonly record: StoreRecord;
}

export type UndoOp = UndoInsertOp | UndoUpdateOp | UndoDeleteOp;

export interface CommitBatchResult {
  readonly events: readonly BucketEvent[];
  readonly undoOps: readonly UndoOp[];
}

// ── Stats type ───────────────────────────────────────────────────────

export interface BucketStats {
  readonly recordCount: number;
  readonly indexCount: number;
  readonly indexNames: readonly string[];
  readonly hasUniqueConstraints: boolean;
  readonly autoincrementCounter: number;
  readonly etsType: string;
  readonly hasTtl: boolean;
  readonly hasMaxSize: boolean;
  readonly maxSize: number | undefined;
}

// ── Message types ──────────────────────────────────────────────────

export type BucketCallMsg =
  | { readonly type: 'insert'; readonly data: Record<string, unknown> }
  | { readonly type: 'get'; readonly key: unknown }
  | { readonly type: 'update'; readonly key: unknown; readonly changes: Record<string, unknown> }
  | { readonly type: 'delete'; readonly key: unknown }
  | { readonly type: 'all' }
  | { readonly type: 'where'; readonly filter: Record<string, unknown> }
  | { readonly type: 'findOne'; readonly filter: Record<string, unknown> }
  | { readonly type: 'count'; readonly filter?: Record<string, unknown> }
  | { readonly type: 'clear' }
  | { readonly type: 'getSnapshot' }
  | { readonly type: 'first'; readonly n: number }
  | { readonly type: 'last'; readonly n: number }
  | { readonly type: 'paginate'; readonly after?: unknown; readonly limit: number }
  | { readonly type: 'sum'; readonly field: string; readonly filter?: Record<string, unknown> }
  | { readonly type: 'avg'; readonly field: string; readonly filter?: Record<string, unknown> }
  | { readonly type: 'min'; readonly field: string; readonly filter?: Record<string, unknown> }
  | { readonly type: 'max'; readonly field: string; readonly filter?: Record<string, unknown> }
  | { readonly type: 'purgeExpired' }
  | { readonly type: 'commitBatch'; readonly operations: readonly CommitBatchOp[]; readonly autoincrementUpdate?: number }
  | { readonly type: 'rollbackBatch'; readonly undoOps: readonly UndoOp[] }
  | { readonly type: 'getAutoincrementCounter' }
  | { readonly type: 'getStats' };

export type BucketCallReply =
  | StoreRecord
  | StoreRecord[]
  | number
  | number | undefined
  | BucketSnapshot
  | PaginatedResult
  | CommitBatchResult
  | BucketStats
  | undefined;

// ── State ──────────────────────────────────────────────────────────

interface BucketState {
  readonly table: Map<unknown, StoreRecord>;
  readonly validator: SchemaValidator;
  readonly indexManager: IndexManager;
  autoincrementCounter: number;
}

// ── Ref type alias ─────────────────────────────────────────────────

export type BucketRef = GenServerRef<BucketState, BucketCallMsg, never, BucketCallReply>;

// ── Factory ────────────────────────────────────────────────────────

export function createBucketBehavior(
  bucketName: string,
  definition: BucketDefinition,
  eventBusRef: EventBusRef,
  initialData?: BucketInitialData,
): GenServerBehavior<BucketState, BucketCallMsg, never, BucketCallReply> {
  const ttlMs = definition.ttl !== undefined ? parseTtl(definition.ttl) : undefined;
  const maxSize = definition.maxSize;

  return {
    init(): BucketState {
      const table = new Map<unknown, StoreRecord>();
      const validator = new SchemaValidator(bucketName, definition.schema, definition.key);
      const indexManager = new IndexManager(
        bucketName,
        definition.indexes ?? [],
        definition.schema,
      );
      let autoincrementCounter = 0;

      if (initialData) {
        autoincrementCounter = initialData.autoincrementCounter;
        for (const [key, record] of initialData.records) {
          indexManager.addRecord(key, record as Record<string, unknown>);
          table.set(key, record);
        }
      }

      return { table, validator, indexManager, autoincrementCounter };
    },

    handleCall(
      msg: BucketCallMsg,
      state: BucketState,
    ): CallResult<BucketCallReply, BucketState> {
      switch (msg.type) {
        case 'insert':
          return handleInsert(bucketName, definition, eventBusRef, state, msg.data, ttlMs, maxSize);
        case 'get':
          return [state.table.get(msg.key), state];
        case 'update':
          return handleUpdate(bucketName, eventBusRef, state, msg.key, msg.changes);
        case 'delete':
          return handleDelete(bucketName, eventBusRef, state, msg.key);
        case 'all':
          return [[...state.table.values()], state];
        case 'where':
          return [selectWhere(state.table, msg.filter, state.indexManager), state];
        case 'findOne':
          return [findOne(state.table, msg.filter, state.indexManager), state];
        case 'count':
          return [
            msg.filter !== undefined
              ? selectWhere(state.table, msg.filter, state.indexManager).length
              : state.table.size,
            state,
          ];
        case 'clear':
          state.indexManager.clear();
          state.table.clear();
          return [undefined, state];
        case 'getSnapshot':
          return [{
            records: [...state.table.entries()],
            autoincrementCounter: state.autoincrementCounter,
          } satisfies BucketSnapshot, state];
        case 'first':
          return [handleFirst(state, msg.n, definition), state];
        case 'last':
          return [handleLast(state, msg.n, definition), state];
        case 'paginate':
          return [handlePaginate(state, msg.after, msg.limit, definition), state];
        case 'sum':
          return [handleSum(state, msg.field, msg.filter), state];
        case 'avg':
          return [handleAvg(state, msg.field, msg.filter), state];
        case 'min':
          return [handleMin(state, msg.field, msg.filter), state];
        case 'max':
          return [handleMax(state, msg.field, msg.filter), state];
        case 'purgeExpired':
          return [handlePurgeExpired(bucketName, eventBusRef, state), state];
        case 'commitBatch':
          return handleCommitBatch(bucketName, state, msg.operations, msg.autoincrementUpdate);
        case 'rollbackBatch':
          return [handleRollbackBatch(state, msg.undoOps), state];
        case 'getAutoincrementCounter':
          return [state.autoincrementCounter, state];
        case 'getStats':
          return [{
            recordCount: state.table.size,
            indexCount: state.indexManager.indexCount,
            indexNames: state.indexManager.indexNames,
            hasUniqueConstraints: state.indexManager.hasUniqueConstraints,
            autoincrementCounter: state.autoincrementCounter,
            etsType: definition.etsType ?? 'set',
            hasTtl: definition.ttl !== undefined,
            hasMaxSize: definition.maxSize !== undefined,
            maxSize: definition.maxSize,
          } satisfies BucketStats, state];
      }
    },

    handleCast(_msg: never, state: BucketState): BucketState {
      return state;
    },
  };
}

// ── Command handlers ───────────────────────────────────────────────

function handleInsert(
  bucketName: string,
  definition: BucketDefinition,
  eventBusRef: EventBusRef,
  state: BucketState,
  data: Record<string, unknown>,
  ttlMs: number | undefined,
  maxSize: number | undefined,
): CallResult<StoreRecord, BucketState> {
  state.autoincrementCounter++;
  const record = state.validator.prepareInsert(data, state.autoincrementCounter);
  const recordObj = record as Record<string, unknown>;
  const key = recordObj[definition.key];

  // Set _expiresAt if bucket has TTL and record doesn't already have it
  if (ttlMs !== undefined && recordObj._expiresAt === undefined) {
    recordObj._expiresAt = record._createdAt + ttlMs;
  }

  // Evict oldest records if at capacity
  if (maxSize !== undefined && state.table.size >= maxSize) {
    const evictCount = state.table.size - maxSize + 1;
    evictOldest(bucketName, eventBusRef, state, evictCount);
  }

  state.indexManager.addRecord(key, recordObj);
  state.table.set(key, record);

  EventBus.publish<BucketInsertedEvent>(
    eventBusRef,
    `bucket.${bucketName}.inserted`,
    { type: 'inserted', bucket: bucketName, key, record },
  );

  return [record, state];
}

function handleUpdate(
  bucketName: string,
  eventBusRef: EventBusRef,
  state: BucketState,
  key: unknown,
  changes: Record<string, unknown>,
): CallResult<StoreRecord, BucketState> {
  const existing = state.table.get(key);
  if (existing === undefined) {
    throw new Error(
      `Record with key "${String(key)}" not found in bucket "${bucketName}"`,
    );
  }

  const updated = state.validator.prepareUpdate(existing, changes);
  state.indexManager.updateRecord(
    key,
    existing as Record<string, unknown>,
    updated as Record<string, unknown>,
  );
  state.table.set(key, updated);

  EventBus.publish<BucketUpdatedEvent>(
    eventBusRef,
    `bucket.${bucketName}.updated`,
    { type: 'updated', bucket: bucketName, key, oldRecord: existing, newRecord: updated },
  );

  return [updated, state];
}

function handleDelete(
  bucketName: string,
  eventBusRef: EventBusRef,
  state: BucketState,
  key: unknown,
): CallResult<undefined, BucketState> {
  const existing = state.table.get(key);

  if (existing !== undefined) {
    state.indexManager.removeRecord(key, existing as Record<string, unknown>);
    state.table.delete(key);

    EventBus.publish<BucketDeletedEvent>(
      eventBusRef,
      `bucket.${bucketName}.deleted`,
      { type: 'deleted', bucket: bucketName, key, record: existing },
    );
  }

  return [undefined, state];
}

function evictOldest(
  bucketName: string,
  eventBusRef: EventBusRef,
  state: BucketState,
  count: number,
): void {
  const entries: Array<{ key: unknown; record: StoreRecord }> = [];
  for (const [key, record] of state.table) {
    entries.push({ key, record });
  }

  entries.sort((a, b) => a.record._createdAt - b.record._createdAt);

  const toEvict = entries.slice(0, count);
  for (const { key, record } of toEvict) {
    state.indexManager.removeRecord(key, record as Record<string, unknown>);
    state.table.delete(key);

    EventBus.publish<BucketDeletedEvent>(
      eventBusRef,
      `bucket.${bucketName}.deleted`,
      { type: 'deleted', bucket: bucketName, key, record },
    );
  }
}

function handlePurgeExpired(
  bucketName: string,
  eventBusRef: EventBusRef,
  state: BucketState,
): number {
  const now = Date.now();
  let purgedCount = 0;

  for (const [key, record] of state.table) {
    const expiresAt = (record as Record<string, unknown>)._expiresAt;
    if (typeof expiresAt === 'number' && expiresAt <= now) {
      state.indexManager.removeRecord(key, record as Record<string, unknown>);
      state.table.delete(key);

      EventBus.publish<BucketDeletedEvent>(
        eventBusRef,
        `bucket.${bucketName}.deleted`,
        { type: 'deleted', bucket: bucketName, key, record },
      );

      purgedCount++;
    }
  }

  return purgedCount;
}

// ── Query helpers ──────────────────────────────────────────────────

function matchesFilter(
  record: StoreRecord,
  filter: Record<string, unknown>,
): boolean {
  for (const [field, value] of Object.entries(filter)) {
    if ((record as Record<string, unknown>)[field] !== value) {
      return false;
    }
  }
  return true;
}

function selectWhere(
  table: Map<unknown, StoreRecord>,
  filter: Record<string, unknown>,
  indexManager: IndexManager,
): StoreRecord[] {
  const entries = Object.entries(filter);
  if (entries.length === 0) return [...table.values()];

  // Try to find an indexed field to narrow candidates
  for (const [field, value] of entries) {
    const keys = indexManager.lookup(field, value);
    if (keys === undefined) continue;

    // We have candidate keys from the index — resolve records and apply remaining filter
    const remaining: Record<string, unknown> = {};
    for (const [f, v] of entries) {
      if (f !== field) remaining[f] = v;
    }
    const hasRemaining = Object.keys(remaining).length > 0;

    const results: StoreRecord[] = [];
    for (const key of keys) {
      const record = table.get(key);
      if (record !== undefined && (!hasRemaining || matchesFilter(record, remaining))) {
        results.push(record);
      }
    }
    return results;
  }

  // No indexed field found — full scan fallback
  const results: StoreRecord[] = [];
  for (const record of table.values()) {
    if (matchesFilter(record, filter)) {
      results.push(record);
    }
  }
  return results;
}

function findOne(
  table: Map<unknown, StoreRecord>,
  filter: Record<string, unknown>,
  indexManager: IndexManager,
): StoreRecord | undefined {
  const entries = Object.entries(filter);
  if (entries.length === 0) {
    const first = table.values().next();
    return first.done ? undefined : first.value;
  }

  // Try to find an indexed field to narrow candidates
  for (const [field, value] of entries) {
    const keys = indexManager.lookup(field, value);
    if (keys === undefined) continue;

    const remaining: Record<string, unknown> = {};
    for (const [f, v] of entries) {
      if (f !== field) remaining[f] = v;
    }
    const hasRemaining = Object.keys(remaining).length > 0;

    for (const key of keys) {
      const record = table.get(key);
      if (record !== undefined && (!hasRemaining || matchesFilter(record, remaining))) {
        return record;
      }
    }
    return undefined;
  }

  // No indexed field found — full scan fallback
  for (const record of table.values()) {
    if (matchesFilter(record, filter)) {
      return record;
    }
  }
  return undefined;
}

// ── Key comparison ──────────────────────────────────────────────────

function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function getOrderedKeys(
  table: Map<unknown, StoreRecord>,
  definition: BucketDefinition,
): unknown[] {
  const keys = [...table.keys()];
  if (definition.etsType === 'ordered_set') {
    keys.sort(compareKeys);
  }
  return keys;
}

// ── Pagination handlers ─────────────────────────────────────────────

function handleFirst(
  state: BucketState,
  n: number,
  definition: BucketDefinition,
): StoreRecord[] {
  const keys = getOrderedKeys(state.table, definition);
  return keys.slice(0, n).map((k) => state.table.get(k)!);
}

function handleLast(
  state: BucketState,
  n: number,
  definition: BucketDefinition,
): StoreRecord[] {
  const keys = getOrderedKeys(state.table, definition);
  return keys.slice(-n).map((k) => state.table.get(k)!);
}

function handlePaginate(
  state: BucketState,
  after: unknown | undefined,
  limit: number,
  definition: BucketDefinition,
): PaginatedResult {
  const keys = getOrderedKeys(state.table, definition);
  let startIdx = 0;

  if (after !== undefined) {
    const cursorIdx = keys.findIndex((k) => k === after);
    startIdx = cursorIdx === -1 ? keys.length : cursorIdx + 1;
  }

  const slice = keys.slice(startIdx, startIdx + limit);
  const records = slice.map((k) => state.table.get(k)!);
  const hasMore = startIdx + limit < keys.length;
  const nextCursor = records.length > 0
    ? (records[records.length - 1] as Record<string, unknown>)[definition.key]
    : undefined;

  return { records, hasMore, nextCursor };
}

// ── Aggregation handlers ────────────────────────────────────────────

function getMatchingRecords(
  state: BucketState,
  filter?: Record<string, unknown>,
): StoreRecord[] {
  if (filter === undefined) return [...state.table.values()];
  return selectWhere(state.table, filter, state.indexManager);
}

function handleSum(
  state: BucketState,
  field: string,
  filter?: Record<string, unknown>,
): number {
  const records = getMatchingRecords(state, filter);
  let sum = 0;
  for (const record of records) {
    const value = (record as Record<string, unknown>)[field];
    if (typeof value === 'number') sum += value;
  }
  return sum;
}

function handleAvg(
  state: BucketState,
  field: string,
  filter?: Record<string, unknown>,
): number {
  const records = getMatchingRecords(state, filter);
  if (records.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const record of records) {
    const value = (record as Record<string, unknown>)[field];
    if (typeof value === 'number') {
      sum += value;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

function handleMin(
  state: BucketState,
  field: string,
  filter?: Record<string, unknown>,
): number | undefined {
  const records = getMatchingRecords(state, filter);
  let min: number | undefined;
  for (const record of records) {
    const value = (record as Record<string, unknown>)[field];
    if (typeof value === 'number' && (min === undefined || value < min)) {
      min = value;
    }
  }
  return min;
}

function handleMax(
  state: BucketState,
  field: string,
  filter?: Record<string, unknown>,
): number | undefined {
  const records = getMatchingRecords(state, filter);
  let max: number | undefined;
  for (const record of records) {
    const value = (record as Record<string, unknown>)[field];
    if (typeof value === 'number' && (max === undefined || value > max)) {
      max = value;
    }
  }
  return max;
}

// ── Transaction batch handlers ──────────────────────────────────

function handleCommitBatch(
  bucketName: string,
  state: BucketState,
  operations: readonly CommitBatchOp[],
  autoincrementUpdate: number | undefined,
): CallResult<CommitBatchResult, BucketState> {
  // ── Phase 1: Validate ALL operations (no mutations) ───────────
  for (const op of operations) {
    switch (op.type) {
      case 'insert': {
        if (state.table.has(op.key)) {
          throw new TransactionConflictError(
            bucketName, op.key,
            `Record with key "${String(op.key)}" already exists`,
          );
        }
        state.indexManager.validateInsert(op.key, op.record as Record<string, unknown>);
        break;
      }
      case 'update': {
        const existing = state.table.get(op.key);
        if (existing === undefined) {
          throw new TransactionConflictError(
            bucketName, op.key,
            `Record with key "${String(op.key)}" not found`,
          );
        }
        if (existing._version !== op.expectedVersion) {
          throw new TransactionConflictError(
            bucketName, op.key,
            `Version mismatch: expected ${String(op.expectedVersion)}, got ${String(existing._version)}`,
          );
        }
        state.indexManager.validateUpdate(
          op.key,
          existing as Record<string, unknown>,
          op.newRecord as Record<string, unknown>,
        );
        break;
      }
      case 'delete': {
        const existing = state.table.get(op.key);
        if (existing !== undefined && existing._version !== op.expectedVersion) {
          throw new TransactionConflictError(
            bucketName, op.key,
            `Version mismatch: expected ${String(op.expectedVersion)}, got ${String(existing._version)}`,
          );
        }
        break;
      }
    }
  }

  // ── Phase 2: Apply ALL operations + collect events and undo ops ──
  const events: BucketEvent[] = [];
  const undoOps: UndoOp[] = [];

  try {
    for (const op of operations) {
      switch (op.type) {
        case 'insert': {
          state.indexManager.addRecord(op.key, op.record as Record<string, unknown>);
          state.table.set(op.key, op.record);
          events.push({
            type: 'inserted', bucket: bucketName, key: op.key, record: op.record,
          });
          undoOps.push({ type: 'undo_insert', key: op.key });
          break;
        }
        case 'update': {
          const oldRecord = state.table.get(op.key)!;
          state.indexManager.updateRecord(
            op.key,
            oldRecord as Record<string, unknown>,
            op.newRecord as Record<string, unknown>,
          );
          state.table.set(op.key, op.newRecord);
          events.push({
            type: 'updated', bucket: bucketName, key: op.key,
            oldRecord, newRecord: op.newRecord,
          });
          undoOps.push({ type: 'undo_update', key: op.key, oldRecord });
          break;
        }
        case 'delete': {
          const existing = state.table.get(op.key);
          if (existing !== undefined) {
            state.indexManager.removeRecord(op.key, existing as Record<string, unknown>);
            state.table.delete(op.key);
            events.push({
              type: 'deleted', bucket: bucketName, key: op.key, record: existing,
            });
            undoOps.push({ type: 'undo_delete', key: op.key, record: existing });
          }
          break;
        }
      }
    }
  } catch (error) {
    // Rollback partial Phase 2 changes to keep state consistent
    for (let i = undoOps.length - 1; i >= 0; i--) {
      applyUndoOp(state, undoOps[i]!);
    }
    throw error;
  }

  if (autoincrementUpdate !== undefined && autoincrementUpdate > state.autoincrementCounter) {
    state.autoincrementCounter = autoincrementUpdate;
  }

  return [{ events, undoOps }, state];
}

function handleRollbackBatch(
  state: BucketState,
  undoOps: readonly UndoOp[],
): undefined {
  for (let i = undoOps.length - 1; i >= 0; i--) {
    applyUndoOp(state, undoOps[i]!);
  }
  return undefined;
}

function applyUndoOp(state: BucketState, op: UndoOp): void {
  switch (op.type) {
    case 'undo_insert': {
      const record = state.table.get(op.key);
      if (record !== undefined) {
        state.indexManager.removeRecord(op.key, record as Record<string, unknown>);
        state.table.delete(op.key);
      }
      break;
    }
    case 'undo_update': {
      const current = state.table.get(op.key);
      if (current !== undefined) {
        state.indexManager.updateRecord(
          op.key,
          current as Record<string, unknown>,
          op.oldRecord as Record<string, unknown>,
        );
      }
      state.table.set(op.key, op.oldRecord);
      break;
    }
    case 'undo_delete': {
      state.indexManager.addRecord(op.key, op.record as Record<string, unknown>);
      state.table.set(op.key, op.record);
      break;
    }
  }
}
