import type { BucketHandle } from '../core/bucket-handle.js';
import type { QueryDependencies } from '../types/query.js';
import {
  QueryAlreadyDefinedError,
  QueryNotDefinedError,
} from '../core/query-errors.js';
import { QueryContextImpl } from './query-context.js';
import { deepEqual } from '../utils/deep-equal.js';

export { QueryAlreadyDefinedError, QueryNotDefinedError };

// ── Internal types ────────────────────────────────────────────────

type AnyQueryFn = (ctx: QueryContextImpl, params?: unknown) => Promise<unknown>;

interface QueryDefinition {
  readonly name: string;
  readonly fn: AnyQueryFn;
}

interface Subscription {
  readonly id: string;
  readonly queryName: string;
  readonly params: unknown;
  readonly callback: (result: unknown) => void;
  lastResult: unknown;
  dependencies: QueryDependencies;
}

// ── QueryManager ──────────────────────────────────────────────────

export class QueryManager {
  readonly #queries = new Map<string, QueryDefinition>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #bucketLevelIndex = new Map<string, Set<string>>();
  readonly #recordLevelIndex = new Map<string, Map<unknown, Set<string>>>();
  readonly #bucketAccessor: (name: string) => BucketHandle;
  readonly #pendingEvaluations = new Set<Promise<void>>();
  #nextSubId = 0;

  constructor(bucketAccessor: (name: string) => BucketHandle) {
    this.#bucketAccessor = bucketAccessor;
  }

  defineQuery(name: string, fn: AnyQueryFn): void {
    if (this.#queries.has(name)) {
      throw new QueryAlreadyDefinedError(name);
    }
    this.#queries.set(name, { name, fn });
  }

  async subscribe(
    queryName: string,
    paramsOrCallback: unknown,
    maybeCallback?: unknown,
  ): Promise<() => void> {
    const { params, callback } = this.#resolveSubscribeArgs(paramsOrCallback, maybeCallback);
    const definition = this.#getDefinition(queryName);

    const ctx = new QueryContextImpl(this.#bucketAccessor);
    const initialResult = await this.#executeQuery(definition.fn, ctx, params);
    const dependencies = ctx.getDependencies();

    const id = String(++this.#nextSubId);
    const sub: Subscription = {
      id,
      queryName,
      params,
      callback,
      lastResult: initialResult,
      dependencies,
    };

    this.#subscriptions.set(id, sub);
    this.#indexDependencies(id, dependencies);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.#subscriptions.delete(id);
      this.#removeDependencies(id, dependencies);
    };
  }

  async runQuery(queryName: string, params?: unknown): Promise<unknown> {
    const definition = this.#getDefinition(queryName);
    const ctx = new QueryContextImpl(this.#bucketAccessor);
    return this.#executeQuery(definition.fn, ctx, params);
  }

  onBucketChange(bucketName: string, key: unknown): void {
    const affectedSubIds = new Set<string>();

    // Bucket-level: all subscriptions with a bucket-level dependency
    const bucketSubs = this.#bucketLevelIndex.get(bucketName);
    if (bucketSubs !== undefined) {
      for (const subId of bucketSubs) affectedSubIds.add(subId);
    }

    // Record-level: only subscriptions tracking this specific key
    const bucketRecords = this.#recordLevelIndex.get(bucketName);
    if (bucketRecords !== undefined) {
      const keySubs = bucketRecords.get(key);
      if (keySubs !== undefined) {
        for (const subId of keySubs) affectedSubIds.add(subId);
      }
    }

    for (const subId of affectedSubIds) {
      const sub = this.#subscriptions.get(subId);
      if (sub === undefined) continue;

      const promise = this.#reEvaluate(sub);
      this.#pendingEvaluations.add(promise);
      void promise.finally(() => this.#pendingEvaluations.delete(promise));
    }
  }

  async waitForPending(): Promise<void> {
    while (this.#pendingEvaluations.size > 0) {
      await Promise.all(this.#pendingEvaluations);
    }
  }

  destroy(): void {
    this.#subscriptions.clear();
    this.#bucketLevelIndex.clear();
    this.#recordLevelIndex.clear();
    this.#queries.clear();
    this.#pendingEvaluations.clear();
  }

  // ── Private helpers ───────────────────────────────────────────

  async #reEvaluate(sub: Subscription): Promise<void> {
    const definition = this.#queries.get(sub.queryName);
    if (definition === undefined) return;

    // Subscription may have been removed while we waited
    if (!this.#subscriptions.has(sub.id)) return;

    let newResult: unknown;
    let newDependencies: QueryDependencies;

    try {
      const ctx = new QueryContextImpl(this.#bucketAccessor);
      newResult = await this.#executeQuery(definition.fn, ctx, sub.params);
      newDependencies = ctx.getDependencies();
    } catch {
      // Query threw — keep subscription alive but skip callback
      return;
    }

    // Subscription may have been removed during async evaluation
    if (!this.#subscriptions.has(sub.id)) return;

    // Update dependency index if dependencies changed
    if (!this.#depsEqual(sub.dependencies, newDependencies)) {
      this.#removeDependencies(sub.id, sub.dependencies);
      this.#indexDependencies(sub.id, newDependencies);
      sub.dependencies = newDependencies;
    }

    if (!deepEqual(sub.lastResult, newResult)) {
      sub.lastResult = newResult;
      sub.callback(newResult);
    }
  }

  #getDefinition(queryName: string): QueryDefinition {
    const definition = this.#queries.get(queryName);
    if (definition === undefined) {
      throw new QueryNotDefinedError(queryName);
    }
    return definition;
  }

  #resolveSubscribeArgs(
    paramsOrCallback: unknown,
    maybeCallback: unknown,
  ): { params: unknown; callback: (result: unknown) => void } {
    if (typeof paramsOrCallback === 'function') {
      return {
        params: undefined,
        callback: paramsOrCallback as (result: unknown) => void,
      };
    }
    return {
      params: paramsOrCallback,
      callback: maybeCallback as (result: unknown) => void,
    };
  }

  async #executeQuery(
    fn: AnyQueryFn,
    ctx: QueryContextImpl,
    params: unknown,
  ): Promise<unknown> {
    return params === undefined ? fn(ctx) : fn(ctx, params);
  }

  #indexDependencies(subId: string, deps: QueryDependencies): void {
    for (const bucket of deps.bucketLevel) {
      let subs = this.#bucketLevelIndex.get(bucket);
      if (subs === undefined) {
        subs = new Set();
        this.#bucketLevelIndex.set(bucket, subs);
      }
      subs.add(subId);
    }

    for (const [bucket, keys] of deps.recordLevel) {
      let bucketMap = this.#recordLevelIndex.get(bucket);
      if (bucketMap === undefined) {
        bucketMap = new Map();
        this.#recordLevelIndex.set(bucket, bucketMap);
      }
      for (const key of keys) {
        let subs = bucketMap.get(key);
        if (subs === undefined) {
          subs = new Set();
          bucketMap.set(key, subs);
        }
        subs.add(subId);
      }
    }
  }

  #removeDependencies(subId: string, deps: QueryDependencies): void {
    for (const bucket of deps.bucketLevel) {
      const subs = this.#bucketLevelIndex.get(bucket);
      if (subs === undefined) continue;
      subs.delete(subId);
      if (subs.size === 0) this.#bucketLevelIndex.delete(bucket);
    }

    for (const [bucket, keys] of deps.recordLevel) {
      const bucketMap = this.#recordLevelIndex.get(bucket);
      if (bucketMap === undefined) continue;
      for (const key of keys) {
        const subs = bucketMap.get(key);
        if (subs === undefined) continue;
        subs.delete(subId);
        if (subs.size === 0) bucketMap.delete(key);
      }
      if (bucketMap.size === 0) this.#recordLevelIndex.delete(bucket);
    }
  }

  #depsEqual(a: QueryDependencies, b: QueryDependencies): boolean {
    if (!this.#setsEqual(a.bucketLevel, b.bucketLevel)) return false;
    if (a.recordLevel.size !== b.recordLevel.size) return false;
    for (const [bucket, keysA] of a.recordLevel) {
      const keysB = b.recordLevel.get(bucket);
      if (keysB === undefined) return false;
      if (!this.#setsEqual(keysA, keysB)) return false;
    }
    return true;
  }

  #setsEqual(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }
}
