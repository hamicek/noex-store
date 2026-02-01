import type { QueryBucket, QueryContext, PaginateOptions, PaginatedResult } from '../types/query.js';
import type { BucketHandle } from '../core/bucket-handle.js';
import type { StoreRecord } from '../types/record.js';

/**
 * Read-only wrapper over {@link BucketHandle}.
 *
 * Exposes only read operations so that query functions cannot
 * accidentally mutate store data. Each method delegates directly
 * to the underlying handle.
 */
class QueryBucketHandle implements QueryBucket {
  readonly #handle: BucketHandle;

  constructor(handle: BucketHandle) {
    this.#handle = handle;
  }

  get(key: unknown): Promise<StoreRecord | undefined> {
    return this.#handle.get(key);
  }

  all(): Promise<StoreRecord[]> {
    return this.#handle.all();
  }

  where(filter: Record<string, unknown>): Promise<StoreRecord[]> {
    return this.#handle.where(filter);
  }

  findOne(filter: Record<string, unknown>): Promise<StoreRecord | undefined> {
    return this.#handle.findOne(filter);
  }

  count(filter?: Record<string, unknown>): Promise<number> {
    return this.#handle.count(filter);
  }

  first(_n: number): Promise<StoreRecord[]> {
    throw new Error('Not implemented — requires BucketHandle.first');
  }

  last(_n: number): Promise<StoreRecord[]> {
    throw new Error('Not implemented — requires BucketHandle.last');
  }

  paginate(_options: PaginateOptions): Promise<PaginatedResult> {
    throw new Error('Not implemented — requires BucketHandle.paginate');
  }

  sum(_field: string, _filter?: Record<string, unknown>): Promise<number> {
    throw new Error('Not implemented — requires BucketHandle.sum');
  }

  avg(_field: string, _filter?: Record<string, unknown>): Promise<number> {
    throw new Error('Not implemented — requires BucketHandle.avg');
  }

  min(_field: string, _filter?: Record<string, unknown>): Promise<number | undefined> {
    throw new Error('Not implemented — requires BucketHandle.min');
  }

  max(_field: string, _filter?: Record<string, unknown>): Promise<number | undefined> {
    throw new Error('Not implemented — requires BucketHandle.max');
  }
}

/**
 * Query execution context with automatic dependency tracking.
 *
 * Every call to {@link bucket} records the bucket name into an internal
 * set. After the query function returns, the caller retrieves the
 * accumulated dependencies via {@link getDependencies}.
 */
export class QueryContextImpl implements QueryContext {
  readonly #bucketAccessor: (name: string) => BucketHandle;
  readonly #dependencies = new Set<string>();

  constructor(bucketAccessor: (name: string) => BucketHandle) {
    this.#bucketAccessor = bucketAccessor;
  }

  bucket(name: string): QueryBucket {
    this.#dependencies.add(name);
    return new QueryBucketHandle(this.#bucketAccessor(name));
  }

  getDependencies(): ReadonlySet<string> {
    return this.#dependencies;
  }
}
