import { GenServer } from '@hamicek/noex';
import type { StoreRecord } from '../types/index.js';
import type { BucketRef } from './bucket-server.js';

/**
 * Stateless proxy over a BucketServer GenServer.
 *
 * Each call delegates to `GenServer.call` — the handle itself holds
 * only the bucket name and a typed ref; creating one is effectively free.
 */
export class BucketHandle {
  readonly #name: string;
  readonly #ref: BucketRef;

  constructor(name: string, ref: BucketRef) {
    this.#name = name;
    this.#ref = ref;
  }

  get name(): string {
    return this.#name;
  }

  async insert(data: Record<string, unknown>): Promise<StoreRecord> {
    const reply = await GenServer.call(this.#ref, { type: 'insert', data });
    return reply as StoreRecord;
  }

  async get(key: unknown): Promise<StoreRecord | undefined> {
    const reply = await GenServer.call(this.#ref, { type: 'get', key });
    return reply as StoreRecord | undefined;
  }

  async update(key: unknown, changes: Record<string, unknown>): Promise<StoreRecord> {
    const reply = await GenServer.call(this.#ref, { type: 'update', key, changes });
    return reply as StoreRecord;
  }

  async delete(key: unknown): Promise<void> {
    await GenServer.call(this.#ref, { type: 'delete', key });
  }

  async all(): Promise<StoreRecord[]> {
    const reply = await GenServer.call(this.#ref, { type: 'all' });
    return reply as StoreRecord[];
  }

  async where(filter: Record<string, unknown>): Promise<StoreRecord[]> {
    const reply = await GenServer.call(this.#ref, { type: 'where', filter });
    return reply as StoreRecord[];
  }

  async findOne(filter: Record<string, unknown>): Promise<StoreRecord | undefined> {
    const reply = await GenServer.call(this.#ref, { type: 'findOne', filter });
    return reply as StoreRecord | undefined;
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    const msg = filter !== undefined
      ? { type: 'count' as const, filter }
      : { type: 'count' as const };
    const reply = await GenServer.call(this.#ref, msg);
    return reply as number;
  }

  async clear(): Promise<void> {
    await GenServer.call(this.#ref, { type: 'clear' });
  }
}
