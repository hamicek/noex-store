import type { AggregateFunction, GroupByResult, QueryBucket, QueryContext, QueryDependencies, PaginateOptions, PaginatedResult, WhereFilter, ReadFilter } from '../types/query.js';
import type { BucketHandle } from '../core/bucket-handle.js';
import type { StoreRecord } from '../types/record.js';
import { matchesFilter } from '../core/filter-matcher.js';

/**
 * Merges two WhereFilters with $and semantics.
 * Returns the combined filter or `baseFilter` if user filter is undefined.
 */
function mergeWithFilter(baseFilter: WhereFilter, userFilter?: WhereFilter): WhereFilter {
  if (userFilter === undefined) return baseFilter;
  return { $and: [baseFilter, userFilter] };
}

/**
 * Read-only wrapper over {@link BucketHandle} with two-level dependency tracking.
 *
 * - **Record-level** ({@link get}): only changes to the specific key invalidate the query.
 * - **Bucket-level** (all other reads): any change in the bucket invalidates the query.
 *
 * Both levels write into shared mutable sets owned by {@link QueryContextImpl}.
 *
 * When a `readFilter` is provided, all read operations transparently apply
 * it — array reads are filtered, scalar aggregations operate on the filtered
 * subset, and `get` returns `undefined` for records that don't match.
 */
class QueryBucketHandle implements QueryBucket {
  readonly #handle: BucketHandle;
  readonly #bucketName: string;
  readonly #bucketDeps: Set<string>;
  readonly #recordDeps: Map<string, Set<unknown>>;
  readonly #readFilter: WhereFilter | null;

  constructor(
    handle: BucketHandle,
    bucketName: string,
    bucketDeps: Set<string>,
    recordDeps: Map<string, Set<unknown>>,
    readFilter?: WhereFilter | null,
  ) {
    this.#handle = handle;
    this.#bucketName = bucketName;
    this.#bucketDeps = bucketDeps;
    this.#recordDeps = recordDeps;
    this.#readFilter = readFilter ?? null;
  }

  // ── Record-level: only the specific key triggers re-evaluation ──

  async get(key: unknown): Promise<StoreRecord | undefined> {
    let keys = this.#recordDeps.get(this.#bucketName);
    if (keys === undefined) {
      keys = new Set();
      this.#recordDeps.set(this.#bucketName, keys);
    }
    keys.add(key);
    const record = await this.#handle.get(key);
    if (record !== undefined && this.#readFilter !== null) {
      if (!matchesFilter(record, this.#readFilter)) return undefined;
    }
    return record;
  }

  // ── Bucket-level: any change in the bucket triggers re-evaluation ──

  all(): Promise<StoreRecord[]> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      return this.#handle.where(this.#readFilter);
    }
    return this.#handle.all();
  }

  where(filter: WhereFilter): Promise<StoreRecord[]> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      return this.#handle.where(mergeWithFilter(this.#readFilter, filter));
    }
    return this.#handle.where(filter);
  }

  findOne(filter: WhereFilter): Promise<StoreRecord | undefined> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      return this.#handle.findOne(mergeWithFilter(this.#readFilter, filter));
    }
    return this.#handle.findOne(filter);
  }

  count(filter?: WhereFilter): Promise<number> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      return this.#handle.count(mergeWithFilter(this.#readFilter, filter));
    }
    return this.#handle.count(filter);
  }

  async first(n: number): Promise<StoreRecord[]> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      const all = await this.#handle.where(this.#readFilter);
      return all.slice(0, n);
    }
    return this.#handle.first(n);
  }

  async last(n: number): Promise<StoreRecord[]> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      const all = await this.#handle.where(this.#readFilter);
      return all.slice(-n);
    }
    return this.#handle.last(n);
  }

  async paginate(options: PaginateOptions): Promise<PaginatedResult> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      const all = await this.#handle.where(this.#readFilter);
      let startIdx = 0;
      if (options.after !== undefined) {
        const cursorIdx = all.findIndex(
          (r) => (r as Record<string, unknown>)['id'] === options.after ||
                 (r as Record<string, unknown>)['_key'] === options.after,
        );
        startIdx = cursorIdx === -1 ? all.length : cursorIdx + 1;
      }
      const records = all.slice(startIdx, startIdx + options.limit);
      const hasMore = startIdx + options.limit < all.length;
      const lastRecord = records[records.length - 1] as Record<string, unknown> | undefined;
      const nextCursor = lastRecord !== undefined
        ? (lastRecord['id'] ?? lastRecord['_key'])
        : undefined;
      return { records, hasMore, nextCursor };
    }
    return this.#handle.paginate(options);
  }

  sum(field: string, filter?: WhereFilter): Promise<number> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      return this.#handle.sum(field, mergeWithFilter(this.#readFilter, filter));
    }
    return this.#handle.sum(field, filter);
  }

  avg(field: string, filter?: WhereFilter): Promise<number> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      return this.#handle.avg(field, mergeWithFilter(this.#readFilter, filter));
    }
    return this.#handle.avg(field, filter);
  }

  min(field: string, filter?: WhereFilter): Promise<number | undefined> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      return this.#handle.min(field, mergeWithFilter(this.#readFilter, filter));
    }
    return this.#handle.min(field, filter);
  }

  max(field: string, filter?: WhereFilter): Promise<number | undefined> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      return this.#handle.max(field, mergeWithFilter(this.#readFilter, filter));
    }
    return this.#handle.max(field, filter);
  }

  groupBy(
    field: string | string[],
    aggregate: { function: AggregateFunction; field?: string },
    filter?: WhereFilter,
  ): Promise<GroupByResult[]> {
    this.#bucketDeps.add(this.#bucketName);
    if (this.#readFilter !== null) {
      return this.#handle.groupBy(field, aggregate, mergeWithFilter(this.#readFilter, filter));
    }
    return this.#handle.groupBy(field, aggregate, filter);
  }
}

/**
 * Query execution context with two-level dependency tracking.
 *
 * Calling {@link bucket} returns a {@link QueryBucketHandle} that records
 * dependencies at method-call time (not at bucket-access time):
 *
 * - `get(key)` → record-level dependency (bucket + key)
 * - everything else → bucket-level dependency (any change invalidates)
 *
 * After the query function returns, call {@link getDependencies} to retrieve
 * the accumulated {@link QueryDependencies}.
 */
export class QueryContextImpl implements QueryContext {
  readonly #bucketAccessor: (name: string) => BucketHandle;
  readonly #bucketDeps = new Set<string>();
  readonly #recordDeps = new Map<string, Set<unknown>>();
  readonly #readFilter: ReadFilter | undefined;

  constructor(
    bucketAccessor: (name: string) => BucketHandle,
    readFilter?: ReadFilter,
  ) {
    this.#bucketAccessor = bucketAccessor;
    this.#readFilter = readFilter;
  }

  bucket(name: string): QueryBucket {
    const filter = this.#readFilter?.(name) ?? null;
    return new QueryBucketHandle(
      this.#bucketAccessor(name),
      name,
      this.#bucketDeps,
      this.#recordDeps,
      filter,
    );
  }

  getDependencies(): QueryDependencies {
    return {
      bucketLevel: this.#bucketDeps,
      recordLevel: this.#recordDeps,
    };
  }
}
