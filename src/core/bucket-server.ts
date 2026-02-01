import type {
  CallResult,
  GenServerBehavior,
  GenServerRef,
} from '@hamicek/noex';
import { EventBus, type EventBusRef } from '@hamicek/noex';
import type {
  BucketDefinition,
  BucketDeletedEvent,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  PaginatedResult,
  StoreRecord,
} from '../types/index.js';
import { IndexManager } from './index-manager.js';
import { SchemaValidator } from './schema-validator.js';

// ── Persistence types ─────────────────────────────────────────────

export interface BucketSnapshot {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}

export interface BucketInitialData {
  readonly records: ReadonlyArray<readonly [unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
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
  | { readonly type: 'max'; readonly field: string; readonly filter?: Record<string, unknown> };

export type BucketCallReply =
  | StoreRecord
  | StoreRecord[]
  | number
  | number | undefined
  | BucketSnapshot
  | PaginatedResult
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
          return handleInsert(bucketName, definition, eventBusRef, state, msg.data);
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
): CallResult<StoreRecord, BucketState> {
  state.autoincrementCounter++;
  const record = state.validator.prepareInsert(data, state.autoincrementCounter);
  const key = (record as Record<string, unknown>)[definition.key];
  state.indexManager.addRecord(key, record as Record<string, unknown>);
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
