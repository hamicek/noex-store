import type { StoreRecord } from './record.js';

// ── Filter Operators ─────────────────────────────────────────────

/** Operators for a single field value. */
export interface FilterOperators {
  readonly $eq?: unknown;
  readonly $neq?: unknown;
  readonly $gt?: number | string;
  readonly $gte?: number | string;
  readonly $lt?: number | string;
  readonly $lte?: number | string;
  readonly $in?: readonly unknown[];
  readonly $nin?: readonly unknown[];
  /** Case-insensitive substring match. */
  readonly $contains?: string;
  readonly $startsWith?: string;
  readonly $endsWith?: string;
  /** `true` = field is not null/undefined, `false` = field is null/undefined. */
  readonly $exists?: boolean;
  /** Inclusive range: `[lower, upper]`. */
  readonly $between?: readonly [number | string, number | string];
}

/** Filter value — plain value (= $eq) or an operator object. */
export type FilterValue = unknown | FilterOperators;

/** Top-level filter with optional logical combinators. */
export interface WhereFilter {
  readonly $or?: readonly WhereFilter[];
  readonly $and?: readonly WhereFilter[];
  readonly [field: string]: FilterValue;
}

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

// ── Group By ─────────────────────────────────────────────────────

export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface GroupByResult {
  readonly key: Record<string, unknown>;
  readonly value: number;
}

// ── Query Bucket ─────────────────────────────────────────────────

/**
 * Read-only bucket interface available inside query functions.
 * Exposes only read operations — queries must not mutate data.
 */
export interface QueryBucket {
  get(key: unknown): Promise<StoreRecord | undefined>;
  all(): Promise<StoreRecord[]>;
  where(filter: WhereFilter): Promise<StoreRecord[]>;
  findOne(filter: WhereFilter): Promise<StoreRecord | undefined>;
  count(filter?: WhereFilter): Promise<number>;
  first(n: number): Promise<StoreRecord[]>;
  last(n: number): Promise<StoreRecord[]>;
  paginate(options: PaginateOptions): Promise<PaginatedResult>;
  sum(field: string, filter?: WhereFilter): Promise<number>;
  avg(field: string, filter?: WhereFilter): Promise<number>;
  min(field: string, filter?: WhereFilter): Promise<number | undefined>;
  max(field: string, filter?: WhereFilter): Promise<number | undefined>;
  groupBy(
    field: string | string[],
    aggregate: { function: AggregateFunction; field?: string },
    filter?: WhereFilter,
  ): Promise<GroupByResult[]>;
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

/**
 * Function that returns a WhereFilter for a given bucket name,
 * or `null` if no filter should be applied.
 *
 * Used to inject row-level security or other access control
 * into query execution — the filter is transparently applied
 * to all bucket reads within the query.
 */
export type ReadFilter = (bucketName: string) => WhereFilter | null;
