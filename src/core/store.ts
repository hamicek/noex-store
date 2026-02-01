import type { EventBusRef, SupervisorRef } from '@hamicek/noex';
import { EventBus, GenServer, Supervisor } from '@hamicek/noex';
import type { BucketDefinition, BucketEvent, QueryContext, QueryFn, StorePersistenceConfig } from '../types/index.js';
import { BucketHandle } from './bucket-handle.js';
import { createBucketBehavior, type BucketInitialData, type BucketRef } from './bucket-server.js';
import { StorePersistence } from '../persistence/store-persistence.js';
import { QueryManager } from '../reactive/query-manager.js';
import { TtlManager } from '../lifecycle/ttl-manager.js';
import { parseTtl } from '../utils/parse-ttl.js';

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
  }

  bucket(name: string): BucketHandle {
    const ref = this.#refs.get(name);
    if (ref === undefined) {
      throw new BucketNotDefinedError(name);
    }
    return new BucketHandle(name, ref);
  }

  async dropBucket(name: string): Promise<void> {
    if (!this.#definitions.has(name)) {
      throw new BucketNotDefinedError(name);
    }

    this.#ttlManager.unregisterBucket(name);

    if (this.#persistence) {
      this.#persistence.unregisterBucket(name);
    }

    await Supervisor.terminateChild(this.#supervisorRef, name);

    this.#definitions.delete(name);
    this.#refs.delete(name);
  }

  /**
   * Manually trigger TTL expiration check on all TTL-enabled buckets.
   * Returns the total number of purged records.
   */
  async purgeTtl(): Promise<number> {
    return this.#ttlManager.purge();
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

  async subscribe<TResult = unknown>(
    queryName: string,
    callback: (result: TResult) => void,
  ): Promise<() => void>;
  async subscribe<TParams, TResult = unknown>(
    queryName: string,
    params: TParams,
    callback: (result: TResult) => void,
  ): Promise<() => void>;
  async subscribe(
    queryName: string,
    paramsOrCallback: unknown,
    maybeCallback?: unknown,
  ): Promise<() => void> {
    return this.#queryManager.subscribe(queryName, paramsOrCallback, maybeCallback);
  }

  async runQuery<TResult = unknown>(
    queryName: string,
    params?: unknown,
  ): Promise<TResult> {
    return this.#queryManager.runQuery(queryName, params) as Promise<TResult>;
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
