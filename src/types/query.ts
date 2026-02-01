import type { StoreRecord } from './record.js';

/**
 * Read-only bucket interface available inside query functions.
 * Exposes only read operations — queries must not mutate data.
 */
export interface QueryBucket {
  get(key: unknown): Promise<StoreRecord | undefined>;
  all(): Promise<StoreRecord[]>;
  where(filter: Record<string, unknown>): Promise<StoreRecord[]>;
  findOne(filter: Record<string, unknown>): Promise<StoreRecord | undefined>;
  count(filter?: Record<string, unknown>): Promise<number>;
}

/**
 * Context passed to query functions.
 * Tracks which buckets the query accesses (dependency tracking).
 */
export interface QueryContext {
  bucket(name: string): QueryBucket;
}

/**
 * Query function signature.
 * Pure async function that reads from buckets via QueryContext.
 *
 * @param ctx - Query context for accessing bucket data
 * @param params - Optional parameters for the query
 * @returns Query result (any serializable value)
 */
export type QueryFn<TParams = void, TResult = unknown> =
  TParams extends void
    ? (ctx: QueryContext) => Promise<TResult>
    : (ctx: QueryContext, params: TParams) => Promise<TResult>;
