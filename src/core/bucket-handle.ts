import { GenServer } from '@hamicek/noex';
import type { AggregateFunction, GroupByResult, PaginateOptions, PaginatedResult, StoreRecord, WhereFilter } from '../types/index.js';
import type { BucketRef } from './bucket-server.js';
import type { RefManager } from './ref-manager.js';

/**
 * Stateless proxy over a BucketServer GenServer.
 *
 * Each call delegates to `GenServer.call` — the handle itself holds
 * only the bucket name and a typed ref; creating one is effectively free.
 *
 * When a {@link RefManager} is provided, write operations are intercepted
 * to enforce referential integrity constraints.
 */
export class BucketHandle {
  readonly #name: string;
  readonly #ref: BucketRef;
  readonly #refManager: RefManager | null;

  constructor(name: string, ref: BucketRef, refManager?: RefManager) {
    this.#name = name;
    this.#ref = ref;
    this.#refManager = refManager ?? null;
  }

  get name(): string {
    return this.#name;
  }

  async insert(data: Record<string, unknown>): Promise<StoreRecord> {
    if (this.#refManager) {
      await this.#refManager.validateInsertRefs(this.#name, data);
    }
    const reply = await GenServer.call(this.#ref, { type: 'insert', data });
    const record = reply as StoreRecord;
    this.#refManager?.onRecordInserted(this.#name, record as Record<string, unknown>);
    return record;
  }

  async get(key: unknown): Promise<StoreRecord | undefined> {
    const reply = await GenServer.call(this.#ref, { type: 'get', key });
    return reply as StoreRecord | undefined;
  }

  async update(key: unknown, changes: Record<string, unknown>): Promise<StoreRecord> {
    if (this.#refManager) {
      await this.#refManager.validateUpdateRefs(this.#name, changes);
    }
    const reply = await GenServer.call(this.#ref, { type: 'update', key, changes });
    const record = reply as StoreRecord;
    this.#refManager?.onRecordUpdated(this.#name, key, changes);
    return record;
  }

  async delete(key: unknown): Promise<void> {
    if (this.#refManager) {
      await this.#refManager.handleDelete(this.#name, key);
    }
    await GenServer.call(this.#ref, { type: 'delete', key });
    this.#refManager?.onRecordDeleted(this.#name, key);
  }

  async insertMany(data: Record<string, unknown>[]): Promise<StoreRecord[]> {
    if (this.#refManager) {
      for (const item of data) {
        await this.#refManager.validateInsertRefs(this.#name, item);
      }
    }
    const reply = await GenServer.call(this.#ref, { type: 'insertMany', data });
    const records = reply as StoreRecord[];
    if (this.#refManager) {
      for (const record of records) {
        this.#refManager.onRecordInserted(this.#name, record as Record<string, unknown>);
      }
    }
    return records;
  }

  async updateMany(filter: WhereFilter, changes: Record<string, unknown>): Promise<number> {
    if (this.#refManager) {
      await this.#refManager.validateUpdateRefs(this.#name, changes);
      // Pre-query affected records so we can update the ref index afterwards
      const affected = await this.where(filter);
      const count = await GenServer.call(this.#ref, { type: 'updateMany', filter, changes }) as number;
      for (const record of affected) {
        const key = this.#refManager.extractKey(this.#name, record as Record<string, unknown>);
        this.#refManager.onRecordUpdated(this.#name, key, changes);
      }
      return count;
    }
    const reply = await GenServer.call(this.#ref, { type: 'updateMany', filter, changes });
    return reply as number;
  }

  async deleteMany(filter: WhereFilter): Promise<number> {
    if (this.#refManager) {
      const affected = await this.where(filter);
      await this.#refManager.handleDeleteMany(this.#name, affected as Record<string, unknown>[]);
      const count = await GenServer.call(this.#ref, { type: 'deleteMany', filter }) as number;
      for (const record of affected) {
        this.#refManager.onRecordDeleted(
          this.#name,
          this.#refManager.extractKey(this.#name, record as Record<string, unknown>),
        );
      }
      return count;
    }
    const reply = await GenServer.call(this.#ref, { type: 'deleteMany', filter });
    return reply as number;
  }

  async upsert(data: Record<string, unknown>): Promise<StoreRecord> {
    if (this.#refManager) {
      await this.#refManager.validateInsertRefs(this.#name, data);
    }
    const reply = await GenServer.call(this.#ref, { type: 'upsert', data });
    const record = reply as StoreRecord;
    this.#refManager?.onRecordUpserted(this.#name, record as Record<string, unknown>);
    return record;
  }

  async all(): Promise<StoreRecord[]> {
    const reply = await GenServer.call(this.#ref, { type: 'all' });
    return reply as StoreRecord[];
  }

  async where(filter: WhereFilter): Promise<StoreRecord[]> {
    const reply = await GenServer.call(this.#ref, { type: 'where', filter });
    return reply as StoreRecord[];
  }

  async findOne(filter: WhereFilter): Promise<StoreRecord | undefined> {
    const reply = await GenServer.call(this.#ref, { type: 'findOne', filter });
    return reply as StoreRecord | undefined;
  }

  async count(filter?: WhereFilter): Promise<number> {
    const msg = filter !== undefined
      ? { type: 'count' as const, filter }
      : { type: 'count' as const };
    const reply = await GenServer.call(this.#ref, msg);
    return reply as number;
  }

  async clear(): Promise<void> {
    await GenServer.call(this.#ref, { type: 'clear' });
  }

  async first(n: number): Promise<StoreRecord[]> {
    const reply = await GenServer.call(this.#ref, { type: 'first', n });
    return reply as StoreRecord[];
  }

  async last(n: number): Promise<StoreRecord[]> {
    const reply = await GenServer.call(this.#ref, { type: 'last', n });
    return reply as StoreRecord[];
  }

  async paginate(options: PaginateOptions): Promise<PaginatedResult> {
    const reply = await GenServer.call(this.#ref, {
      type: 'paginate',
      after: options.after,
      limit: options.limit,
    });
    return reply as PaginatedResult;
  }

  async sum(field: string, filter?: WhereFilter): Promise<number> {
    const msg = filter !== undefined
      ? { type: 'sum' as const, field, filter }
      : { type: 'sum' as const, field };
    const reply = await GenServer.call(this.#ref, msg);
    return reply as number;
  }

  async avg(field: string, filter?: WhereFilter): Promise<number> {
    const msg = filter !== undefined
      ? { type: 'avg' as const, field, filter }
      : { type: 'avg' as const, field };
    const reply = await GenServer.call(this.#ref, msg);
    return reply as number;
  }

  async min(field: string, filter?: WhereFilter): Promise<number | undefined> {
    const msg = filter !== undefined
      ? { type: 'min' as const, field, filter }
      : { type: 'min' as const, field };
    const reply = await GenServer.call(this.#ref, msg);
    return reply as number | undefined;
  }

  async max(field: string, filter?: WhereFilter): Promise<number | undefined> {
    const msg = filter !== undefined
      ? { type: 'max' as const, field, filter }
      : { type: 'max' as const, field };
    const reply = await GenServer.call(this.#ref, msg);
    return reply as number | undefined;
  }

  async groupBy(
    field: string | string[],
    aggregate: { function: AggregateFunction; field?: string },
    filter?: WhereFilter,
  ): Promise<GroupByResult[]> {
    const groupFields = typeof field === 'string' ? [field] : field;
    const msg = filter !== undefined
      ? { type: 'groupBy' as const, groupFields, aggregate, filter }
      : { type: 'groupBy' as const, groupFields, aggregate };
    const reply = await GenServer.call(this.#ref, msg);
    return reply as GroupByResult[];
  }
}
