import type { EventBusRef, SupervisorRef } from '@hamicek/noex';
import { EventBus, GenServer, Supervisor } from '@hamicek/noex';
import type { BucketDefinition, BucketSchemaUpdate, BucketEvent, FieldDefinition, QueryContext, QueryFn, StorePersistenceConfig, StoreRecord, DeclarativeQueryConfig, QueryInfo, ReadFilter } from '../types/index.js';
import { BucketHandle } from './bucket-handle.js';
import { createBucketBehavior, type BucketInitialData, type BucketRef, type BucketSnapshot, type BucketStats } from './bucket-server.js';
import { RefManager } from './ref-manager.js';
import { StorePersistence } from '../persistence/store-persistence.js';
import { QueryManager } from '../reactive/query-manager.js';
import { TtlManager } from '../lifecycle/ttl-manager.js';
import { parseTtl } from '../utils/parse-ttl.js';
import { TransactionContext } from '../transaction/transaction.js';
import { createQueryFunction } from './declarative-query.js';

// ── Stats type ──────────────────────────────────────────────────

export interface StoreStats {
  readonly name: string;
  readonly buckets: {
    readonly count: number;
    readonly names: readonly string[];
  };
  readonly records: {
    readonly total: number;
    readonly perBucket: Readonly<Record<string, number>>;
  };
  readonly indexes: {
    readonly total: number;
    readonly perBucket: Readonly<Record<string, number>>;
  };
  readonly queries: {
    readonly defined: number;
    readonly activeSubscriptions: number;
  };
  readonly persistence: {
    readonly enabled: boolean;
  };
  readonly ttl: {
    readonly enabled: boolean;
    readonly checkIntervalMs: number;
  };
}

// ── Error classes ─────────────────────────────────────────────────

export class BucketAlreadyExistsError extends Error {
  readonly bucket: string;

  constructor(bucket: string) {
    super(`Bucket "${bucket}" already exists`);
    this.name = 'BucketAlreadyExistsError';
    this.bucket = bucket;
  }
}

export class BucketNotDefinedError extends Error {
  readonly bucket: string;

  constructor(bucket: string) {
    super(`Bucket "${bucket}" is not defined`);
    this.name = 'BucketNotDefinedError';
    this.bucket = bucket;
  }
}

export class UniqueConstraintError extends Error {
  readonly bucket: string;
  readonly field: string;
  readonly value: unknown;

  constructor(bucket: string, field: string, value: unknown) {
    super(`Unique constraint violation in bucket "${bucket}": field "${field}" already has value "${String(value)}"`);
    this.name = 'UniqueConstraintError';
    this.bucket = bucket;
    this.field = field;
    this.value = value;
  }
}

export class TransactionConflictError extends Error {
  readonly bucket: string;
  readonly key: unknown;
  readonly field: string | undefined;

  constructor(bucket: string, key: unknown, message: string, field?: string) {
    super(`Transaction conflict in bucket "${bucket}" for key "${String(key)}": ${message}`);
    this.name = 'TransactionConflictError';
    this.bucket = bucket;
    this.key = key;
    this.field = field;
  }
}

// ── Options ───────────────────────────────────────────────────────

export interface StoreOptions {
  readonly name?: string;
  readonly persistence?: StorePersistenceConfig;
  /** Interval (ms) for TTL expiration checks. Default: 1000. Set to 0 to disable automatic checks. */
  readonly ttlCheckIntervalMs?: number;
}

// ── Store ─────────────────────────────────────────────────────────

let storeCounter = 0;

export class Store {
  readonly #name: string;
  readonly #supervisorRef: SupervisorRef;
  readonly #eventBusRef: EventBusRef;
  readonly #definitions = new Map<string, BucketDefinition>();
  readonly #refs = new Map<string, BucketRef>();
  readonly #queryManager: QueryManager;
  readonly #persistence: StorePersistence | null;
  readonly #ttlManager: TtlManager;
  readonly #refManager: RefManager;
  #eventBusUnsub: (() => Promise<void>) | null = null;

  private constructor(
    name: string,
    supervisorRef: SupervisorRef,
    eventBusRef: EventBusRef,
    persistence: StorePersistence | null,
    ttlManager: TtlManager,
  ) {
    this.#name = name;
    this.#supervisorRef = supervisorRef;
    this.#eventBusRef = eventBusRef;
    this.#persistence = persistence;
    this.#ttlManager = ttlManager;
    this.#refManager = new RefManager((n) => this.#rawBucket(n));
    this.#queryManager = new QueryManager((n) => this.bucket(n));
  }

  get name(): string {
    return this.#name;
  }

  static async start(options?: StoreOptions): Promise<Store> {
    const name = options?.name ?? `store-${++storeCounter}`;

    const eventBusRef = await EventBus.start({ name: `${name}:events` });
    const supervisorRef = await Supervisor.start({
      strategy: 'one_for_one',
      name: `${name}:supervisor`,
    });

    let persistence: StorePersistence | null = null;
    if (options?.persistence) {
      persistence = new StorePersistence(name, options.persistence);
      await persistence.start(eventBusRef);
    }

    const checkIntervalMs = options?.ttlCheckIntervalMs ?? 1_000;
    const ttlManager = new TtlManager(checkIntervalMs);

    const store = new Store(name, supervisorRef, eventBusRef, persistence, ttlManager);
    await store.#initReactiveLayer();

    if (checkIntervalMs > 0) {
      ttlManager.start();
    }

    return store;
  }

  async defineBucket(name: string, definition: BucketDefinition): Promise<void> {
    if (this.#definitions.has(name)) {
      throw new BucketAlreadyExistsError(name);
    }

    this.#validateDefinition(name, definition);
    this.#refManager.registerBucket(name, definition);
    this.#definitions.set(name, definition);

    let initialData: BucketInitialData | undefined;
    const isPersistent = this.#persistence !== null && (definition.persistent ?? true);

    if (isPersistent) {
      initialData = await this.#persistence!.loadBucket(name);
    }

    const behavior = createBucketBehavior(name, definition, this.#eventBusRef, initialData);
    const registryName = `${this.#name}:bucket:${name}`;

    const ref = await Supervisor.startChild(this.#supervisorRef, {
      id: name,
      start: () => GenServer.start(behavior, { name: registryName }),
    }) as BucketRef;

    this.#refs.set(name, ref);

    if (isPersistent) {
      this.#persistence!.registerBucket(name, ref);
    }

    if (definition.ttl !== undefined) {
      this.#ttlManager.registerBucket(name, ref, parseTtl(definition.ttl));
    }

    // Index existing records (from persistence) for ref integrity tracking
    await this.#refManager.indexExistingRecords(name);
  }

  bucket(name: string): BucketHandle {
    const ref = this.#refs.get(name);
    if (ref === undefined) {
      throw new BucketNotDefinedError(name);
    }
    return new BucketHandle(name, ref, this.#refManager);
  }

  /** Raw handle without ref validation — used by RefManager for cascade operations. */
  #rawBucket(name: string): BucketHandle {
    const ref = this.#refs.get(name);
    if (ref === undefined) {
      throw new BucketNotDefinedError(name);
    }
    return new BucketHandle(name, ref);
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = new TransactionContext(this.#definitions, this.#refs, this.#eventBusRef);
    const result = await fn(tx);
    await tx.commit();
    return result;
  }

  async dropBucket(name: string): Promise<boolean> {
    if (!this.#definitions.has(name)) {
      return false;
    }

    this.#queryManager.unsubscribeByBucket(name);
    this.#ttlManager.unregisterBucket(name);
    this.#refManager.unregisterBucket(name);

    if (this.#persistence) {
      this.#persistence.unregisterBucket(name);
    }

    await Supervisor.terminateChild(this.#supervisorRef, name);

    this.#definitions.delete(name);
    this.#refs.delete(name);

    return true;
  }

  hasBucket(name: string): boolean {
    return this.#definitions.has(name);
  }

  getBucketSchema(name: string): BucketDefinition | undefined {
    return this.#definitions.get(name);
  }

  async updateBucket(name: string, updates: BucketSchemaUpdate): Promise<void> {
    const definition = this.#definitions.get(name);
    if (definition === undefined) {
      throw new BucketNotDefinedError(name);
    }

    const newDefinition = this.#mergeDefinitionUpdate(name, definition, updates);

    const ref = this.#refs.get(name)!;
    const snapshot = await GenServer.call(ref, { type: 'getSnapshot' }) as BucketSnapshot;

    await this.#rebuildBucketCore(name, newDefinition, {
      records: snapshot.records,
      autoincrementCounter: snapshot.autoincrementCounter,
    });
  }

  /**
   * @internal Used by the migration framework.
   * Replaces a bucket's definition and optionally transforms all existing records.
   */
  async rebuildBucket(
    name: string,
    newDefinition: BucketDefinition,
    transformRecords?: (records: ReadonlyArray<readonly [unknown, StoreRecord]>) => Array<[unknown, StoreRecord]>,
  ): Promise<void> {
    if (!this.#definitions.has(name)) {
      throw new BucketNotDefinedError(name);
    }

    this.#validateDefinition(name, newDefinition);

    const ref = this.#refs.get(name)!;
    const snapshot = await GenServer.call(ref, { type: 'getSnapshot' }) as BucketSnapshot;

    const records = transformRecords
      ? transformRecords([...snapshot.records])
      : snapshot.records;

    this.#refManager.unregisterBucket(name);

    await this.#rebuildBucketCore(name, newDefinition, {
      records,
      autoincrementCounter: snapshot.autoincrementCounter,
    });

    this.#refManager.registerBucket(name, newDefinition);
    await this.#refManager.indexExistingRecords(name);
  }

  async #rebuildBucketCore(
    name: string,
    newDefinition: BucketDefinition,
    initialData: BucketInitialData,
  ): Promise<void> {
    this.#ttlManager.unregisterBucket(name);
    if (this.#persistence) {
      this.#persistence.unregisterBucket(name);
    }
    await Supervisor.terminateChild(this.#supervisorRef, name);

    const behavior = createBucketBehavior(name, newDefinition, this.#eventBusRef, initialData);
    const registryName = `${this.#name}:bucket:${name}`;

    const newRef = await Supervisor.startChild(this.#supervisorRef, {
      id: name,
      start: () => GenServer.start(behavior, { name: registryName }),
    }) as BucketRef;

    this.#definitions.set(name, newDefinition);
    this.#refs.set(name, newRef);

    const isPersistent = this.#persistence !== null && (newDefinition.persistent ?? true);
    if (isPersistent) {
      this.#persistence!.registerBucket(name, newRef);
    }

    if (newDefinition.ttl !== undefined) {
      this.#ttlManager.registerBucket(name, newRef, parseTtl(newDefinition.ttl));
    }
  }

  /**
   * Manually trigger TTL expiration check on all TTL-enabled buckets.
   * Returns the total number of purged records.
   */
  async purgeTtl(): Promise<number> {
    return this.#ttlManager.purge();
  }

  async getStats(): Promise<StoreStats> {
    const bucketNames = [...this.#definitions.keys()];
    const perBucketRecords: Record<string, number> = {};
    const perBucketIndexes: Record<string, number> = {};
    let totalRecords = 0;
    let totalIndexes = 0;

    for (const name of bucketNames) {
      const ref = this.#refs.get(name)!;
      const stats = await GenServer.call(ref, { type: 'getStats' }) as BucketStats;
      perBucketRecords[name] = stats.recordCount;
      perBucketIndexes[name] = stats.indexCount;
      totalRecords += stats.recordCount;
      totalIndexes += stats.indexCount;
    }

    return {
      name: this.#name,
      buckets: { count: bucketNames.length, names: bucketNames },
      records: { total: totalRecords, perBucket: perBucketRecords },
      indexes: { total: totalIndexes, perBucket: perBucketIndexes },
      queries: {
        defined: this.#queryManager.queryCount,
        activeSubscriptions: this.#queryManager.subscriptionCount,
      },
      persistence: { enabled: this.#persistence !== null },
      ttl: {
        enabled: this.#ttlManager.enabled,
        checkIntervalMs: this.#ttlManager.checkIntervalMs,
      },
    };
  }

  async on<T = BucketEvent>(
    pattern: string,
    handler: (message: T, topic: string) => void,
  ): Promise<() => Promise<void>> {
    return EventBus.subscribe<T>(this.#eventBusRef, pattern, handler);
  }

  defineQuery<TParams = void, TResult = unknown>(
    name: string,
    fn: QueryFn<TParams, TResult>,
  ): void {
    this.#queryManager.defineQuery(
      name,
      fn as (ctx: QueryContext, params?: unknown) => Promise<unknown>,
    );
  }

  defineDeclarativeQuery(name: string, config: DeclarativeQueryConfig): void {
    if (!this.#definitions.has(config.bucket)) {
      throw new BucketNotDefinedError(config.bucket);
    }
    const fn = createQueryFunction(config);
    this.#queryManager.defineDeclarativeQuery(name, fn, config);
  }

  undefineQuery(name: string): boolean {
    return this.#queryManager.undefineQuery(name);
  }

  getQueries(): QueryInfo[] {
    return this.#queryManager.getQueries();
  }

  getQueryInfo(name: string): QueryInfo | undefined {
    return this.#queryManager.getQueryInfo(name);
  }

  async subscribe<TResult = unknown>(
    queryName: string,
    callback: (result: TResult) => void,
  ): Promise<() => void>;
  async subscribe<TParams, TResult = unknown>(
    queryName: string,
    params: TParams,
    callback: (result: TResult) => void,
  ): Promise<() => void>;
  async subscribe<TParams, TResult = unknown>(
    queryName: string,
    params: TParams,
    callback: (result: TResult) => void,
    readFilter: ReadFilter,
  ): Promise<() => void>;
  async subscribe(
    queryName: string,
    paramsOrCallback: unknown,
    maybeCallback?: unknown,
    readFilter?: ReadFilter,
  ): Promise<() => void> {
    return this.#queryManager.subscribe(queryName, paramsOrCallback, maybeCallback, readFilter);
  }

  async runQuery<TResult = unknown>(
    queryName: string,
    params?: unknown,
  ): Promise<TResult>;
  async runQuery<TResult = unknown>(
    queryName: string,
    params: unknown | undefined,
    readFilter: ReadFilter,
  ): Promise<TResult>;
  async runQuery<TResult = unknown>(
    queryName: string,
    params?: unknown,
    readFilter?: ReadFilter,
  ): Promise<TResult> {
    return this.#queryManager.runQuery(queryName, params, readFilter) as Promise<TResult>;
  }

  async settle(): Promise<void> {
    await EventBus.getSubscriptionCount(this.#eventBusRef);
    await this.#queryManager.waitForPending();
  }

  async stop(): Promise<void> {
    this.#ttlManager.stop();
    this.#queryManager.destroy();
    await this.#eventBusUnsub?.();

    // Flush and stop persistence BEFORE stopping BucketServers
    // (persistence.stop needs to send getSnapshot messages to live BucketServers)
    if (this.#persistence) {
      await this.#persistence.stop();
    }

    await Supervisor.stop(this.#supervisorRef);
    await EventBus.stop(this.#eventBusRef);

    this.#definitions.clear();
    this.#refs.clear();
  }

  async #initReactiveLayer(): Promise<void> {
    this.#eventBusUnsub = await EventBus.subscribe<BucketEvent>(
      this.#eventBusRef,
      'bucket.*.*',
      (event) => {
        this.#queryManager.onBucketChange(event.bucket, event.key);
      },
    );
  }

  #mergeDefinitionUpdate(
    name: string,
    definition: BucketDefinition,
    updates: BucketSchemaUpdate,
  ): BucketDefinition {
    const mergedSchema: Record<string, FieldDefinition> = { ...definition.schema };

    if (updates.addFields !== undefined) {
      for (const [field, def] of Object.entries(updates.addFields)) {
        if (field in mergedSchema) {
          throw new Error(
            `Field "${field}" already exists in bucket "${name}"`,
          );
        }
        mergedSchema[field] = def;
      }
    }

    const existingIndexes = [...(definition.indexes ?? [])];

    if (updates.addIndexes !== undefined) {
      for (const index of updates.addIndexes) {
        if (!(index in mergedSchema)) {
          throw new Error(
            `Index field "${index}" does not exist in schema for bucket "${name}"`,
          );
        }
        if (!existingIndexes.includes(index)) {
          existingIndexes.push(index);
        }
      }
    }

    // Build the result without optional fields that would be undefined.
    // exactOptionalPropertyTypes forbids assigning undefined to optional props.
    const { indexes: _oldIdx, ttl: _oldTtl, ...base } = definition;

    const result: Record<string, unknown> = {
      ...base,
      schema: mergedSchema,
    };

    if (existingIndexes.length > 0) {
      result['indexes'] = existingIndexes;
    }

    // Resolve TTL: undefined = keep original, null = remove, value = set
    if (updates.ttl === undefined) {
      if (definition.ttl !== undefined) {
        result['ttl'] = definition.ttl;
      }
    } else if (updates.ttl !== null) {
      result['ttl'] = updates.ttl;
    }

    return result as unknown as BucketDefinition;
  }

  #validateDefinition(name: string, definition: BucketDefinition): void {
    const { key, schema, indexes } = definition;

    if (!(key in schema)) {
      throw new Error(
        `Key field "${key}" does not exist in schema for bucket "${name}"`,
      );
    }

    if (indexes !== undefined) {
      for (const index of indexes) {
        if (!(index in schema)) {
          throw new Error(
            `Index field "${index}" does not exist in schema for bucket "${name}"`,
          );
        }
      }
    }
  }
}
