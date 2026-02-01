import type { EventBusRef, SupervisorRef } from '@hamicek/noex';
import { EventBus, GenServer, Supervisor } from '@hamicek/noex';
import type { BucketDefinition, BucketEvent } from '../types/index.js';
import { BucketHandle } from './bucket-handle.js';
import { createBucketBehavior, type BucketRef } from './bucket-server.js';

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
}

// ── Store ─────────────────────────────────────────────────────────

let storeCounter = 0;

export class Store {
  readonly #name: string;
  readonly #supervisorRef: SupervisorRef;
  readonly #eventBusRef: EventBusRef;
  readonly #definitions = new Map<string, BucketDefinition>();
  readonly #refs = new Map<string, BucketRef>();

  private constructor(
    name: string,
    supervisorRef: SupervisorRef,
    eventBusRef: EventBusRef,
  ) {
    this.#name = name;
    this.#supervisorRef = supervisorRef;
    this.#eventBusRef = eventBusRef;
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

    return new Store(name, supervisorRef, eventBusRef);
  }

  async defineBucket(name: string, definition: BucketDefinition): Promise<void> {
    if (this.#definitions.has(name)) {
      throw new BucketAlreadyExistsError(name);
    }

    this.#validateDefinition(name, definition);
    this.#definitions.set(name, definition);

    const behavior = createBucketBehavior(name, definition, this.#eventBusRef);
    const registryName = `${this.#name}:bucket:${name}`;

    const ref = await Supervisor.startChild(this.#supervisorRef, {
      id: name,
      start: () => GenServer.start(behavior, { name: registryName }),
    }) as BucketRef;

    this.#refs.set(name, ref);
  }

  bucket(name: string): BucketHandle {
    const ref = this.#refs.get(name);
    if (ref === undefined) {
      throw new BucketNotDefinedError(name);
    }
    return new BucketHandle(name, ref);
  }

  async on<T = BucketEvent>(
    pattern: string,
    handler: (message: T, topic: string) => void,
  ): Promise<() => Promise<void>> {
    return EventBus.subscribe<T>(this.#eventBusRef, pattern, handler);
  }

  async stop(): Promise<void> {
    await Supervisor.stop(this.#supervisorRef);
    await EventBus.stop(this.#eventBusRef);

    this.#definitions.clear();
    this.#refs.clear();
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
