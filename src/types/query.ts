import type { StoreRecord } from './record.js';

// ── Pagination ───────────────────────────────────────────────────

export interface PaginateOptions {
  /** Start after this primary key (cursor). Omit for first page. */
  readonly after?: unknown;
  /** Maximum number of records to return. */
  readonly limit: number;
}

export interface PaginatedResult {
  /** Records in this page. */
  readonly records: StoreRecord[];
  /** Whether more records exist after this page. */
  readonly hasMore: boolean;
  /** Primary key of the last returned record. Pass as `after` for next page. undefined if no records. */
  readonly nextCursor: unknown | undefined;
}

// ── Dependencies ─────────────────────────────────────────────────

export interface QueryDependencies {
  /** Buckets accessed at bucket-level (where/all/findOne/count/first/last/paginate/aggregations).
   *  Any change in these buckets triggers re-evaluation. */
  readonly bucketLevel: ReadonlySet<string>;
  /** Buckets accessed at record-level (get).
   *  Only changes to the tracked keys trigger re-evaluation.
   *  Map<bucketName, Set<primaryKey>> */
  readonly recordLevel: ReadonlyMap<string, ReadonlySet<unknown>>;
}

// ── Query Bucket ─────────────────────────────────────────────────

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
  first(n: number): Promise<StoreRecord[]>;
  last(n: number): Promise<StoreRecord[]>;
  paginate(options: PaginateOptions): Promise<PaginatedResult>;
  sum(field: string, filter?: Record<string, unknown>): Promise<number>;
  avg(field: string, filter?: Record<string, unknown>): Promise<number>;
  min(field: string, filter?: Record<string, unknown>): Promise<number | undefined>;
  max(field: string, filter?: Record<string, unknown>): Promise<number | undefined>;
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
