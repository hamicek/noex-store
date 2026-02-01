import { EventBus, GenServer } from '@hamicek/noex';
import type { EventBusRef, PersistedState, StorageAdapter } from '@hamicek/noex';
import type { BucketEvent, StoreRecord, StorePersistenceConfig } from '../types/index.js';
import type { BucketRef, BucketSnapshot, BucketInitialData } from '../core/bucket-server.js';

// ── Internal types ──────────────────────────────────────────────

interface PersistedBucketState {
  readonly records: Array<[unknown, StoreRecord]>;
  readonly autoincrementCounter: number;
}

// ── StorePersistence ────────────────────────────────────────────

export class StorePersistence {
  readonly #adapter: StorageAdapter;
  readonly #debounceMs: number;
  readonly #storeName: string;
  readonly #onError: ((error: Error) => void) | undefined;

  readonly #refs = new Map<string, BucketRef>();
  readonly #dirtyBuckets = new Set<string>();
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #eventBusUnsub: (() => Promise<void>) | null = null;
  #isStopping = false;

  constructor(storeName: string, config: StorePersistenceConfig) {
    this.#adapter = config.adapter;
    this.#debounceMs = config.debounceMs ?? 100;
    this.#storeName = storeName;
    this.#onError = config.onError;
  }

  async start(eventBusRef: EventBusRef): Promise<void> {
    this.#eventBusUnsub = await EventBus.subscribe<BucketEvent>(
      eventBusRef,
      'bucket.*.*',
      (event) => {
        if (!this.#isStopping) {
          this.#onBucketChange(event.bucket);
        }
      },
    );
  }

  async loadBucket(name: string): Promise<BucketInitialData | undefined> {
    try {
      const key = this.#bucketKey(name);
      const persisted = await this.#adapter.load<PersistedBucketState>(key);
      if (!persisted) return undefined;

      return {
        records: persisted.state.records,
        autoincrementCounter: persisted.state.autoincrementCounter,
      };
    } catch (error) {
      this.#onError?.(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }

  registerBucket(name: string, ref: BucketRef): void {
    this.#refs.set(name, ref);
  }

  unregisterBucket(name: string): void {
    this.#refs.delete(name);
    this.#dirtyBuckets.delete(name);
  }

  async flush(): Promise<void> {
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    await this.#persistDirty();
  }

  async stop(): Promise<void> {
    this.#isStopping = true;

    for (const name of this.#refs.keys()) {
      this.#dirtyBuckets.add(name);
    }

    await this.flush();
    await this.#eventBusUnsub?.();

    if (this.#adapter.close) {
      await this.#adapter.close();
    }
  }

  // ── Private ─────────────────────────────────────────────────

  #onBucketChange(bucketName: string): void {
    if (!this.#refs.has(bucketName)) return;

    this.#dirtyBuckets.add(bucketName);

    if (this.#debounceTimer === null) {
      this.#debounceTimer = setTimeout(() => {
        this.#debounceTimer = null;
        void this.#persistDirty();
      }, this.#debounceMs);
    }
  }

  async #persistDirty(): Promise<void> {
    const buckets = [...this.#dirtyBuckets];
    this.#dirtyBuckets.clear();

    await Promise.all(
      buckets.map((name) => this.#persistBucket(name)),
    );
  }

  async #persistBucket(name: string): Promise<void> {
    const ref = this.#refs.get(name);
    if (!ref) return;

    try {
      const snapshot = await GenServer.call(ref, { type: 'getSnapshot' }) as BucketSnapshot;

      const key = this.#bucketKey(name);
      const data: PersistedState<PersistedBucketState> = {
        state: {
          records: snapshot.records as Array<[unknown, StoreRecord]>,
          autoincrementCounter: snapshot.autoincrementCounter,
        },
        metadata: {
          persistedAt: Date.now(),
          serverId: this.#storeName,
          schemaVersion: 1,
        },
      };

      await this.#adapter.save(key, data);
    } catch (error) {
      this.#onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #bucketKey(name: string): string {
    return `${this.#storeName}:bucket:${name}`;
  }
}
