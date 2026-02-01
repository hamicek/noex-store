import type { QueryBucket, QueryContext, QueryDependencies, PaginateOptions, PaginatedResult } from '../types/query.js';
import type { BucketHandle } from '../core/bucket-handle.js';
import type { StoreRecord } from '../types/record.js';

/**
 * Read-only wrapper over {@link BucketHandle} with two-level dependency tracking.
 *
 * - **Record-level** ({@link get}): only changes to the specific key invalidate the query.
 * - **Bucket-level** (all other reads): any change in the bucket invalidates the query.
 *
 * Both levels write into shared mutable sets owned by {@link QueryContextImpl}.
 */
class QueryBucketHandle implements QueryBucket {
  readonly #handle: BucketHandle;
  readonly #bucketName: string;
  readonly #bucketDeps: Set<string>;
  readonly #recordDeps: Map<string, Set<unknown>>;

  constructor(
    handle: BucketHandle,
    bucketName: string,
    bucketDeps: Set<string>,
    recordDeps: Map<string, Set<unknown>>,
  ) {
    this.#handle = handle;
    this.#bucketName = bucketName;
    this.#bucketDeps = bucketDeps;
    this.#recordDeps = recordDeps;
  }

  // ── Record-level: only the specific key triggers re-evaluation ──

  get(key: unknown): Promise<StoreRecord | undefined> {
    let keys = this.#recordDeps.get(this.#bucketName);
    if (keys === undefined) {
      keys = new Set();
      this.#recordDeps.set(this.#bucketName, keys);
    }
    keys.add(key);
    return this.#handle.get(key);
  }

  // ── Bucket-level: any change in the bucket triggers re-evaluation ──

  all(): Promise<StoreRecord[]> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.all();
  }

  where(filter: Record<string, unknown>): Promise<StoreRecord[]> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.where(filter);
  }

  findOne(filter: Record<string, unknown>): Promise<StoreRecord | undefined> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.findOne(filter);
  }

  count(filter?: Record<string, unknown>): Promise<number> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.count(filter);
  }

  first(n: number): Promise<StoreRecord[]> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.first(n);
  }

  last(n: number): Promise<StoreRecord[]> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.last(n);
  }

  paginate(options: PaginateOptions): Promise<PaginatedResult> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.paginate(options);
  }

  sum(field: string, filter?: Record<string, unknown>): Promise<number> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.sum(field, filter);
  }

  avg(field: string, filter?: Record<string, unknown>): Promise<number> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.avg(field, filter);
  }

  min(field: string, filter?: Record<string, unknown>): Promise<number | undefined> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.min(field, filter);
  }

  max(field: string, filter?: Record<string, unknown>): Promise<number | undefined> {
    this.#bucketDeps.add(this.#bucketName);
    return this.#handle.max(field, filter);
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

  constructor(bucketAccessor: (name: string) => BucketHandle) {
    this.#bucketAccessor = bucketAccessor;
  }

  bucket(name: string): QueryBucket {
    return new QueryBucketHandle(
      this.#bucketAccessor(name),
      name,
      this.#bucketDeps,
      this.#recordDeps,
    );
  }

  getDependencies(): QueryDependencies {
    return {
      bucketLevel: this.#bucketDeps,
      recordLevel: this.#recordDeps,
    };
  }
}
