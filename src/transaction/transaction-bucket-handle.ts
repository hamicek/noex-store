import { GenServer } from '@hamicek/noex';
import type { BucketDefinition, StoreRecord } from '../types/index.js';
import type { BucketRef } from '../core/bucket-server.js';
import { SchemaValidator } from '../core/schema-validator.js';
import type { BucketWriteBuffer } from './write-buffer.js';

/**
 * Bucket handle for use within a transaction.
 *
 * Write operations are buffered locally in a {@link BucketWriteBuffer}.
 * Read operations apply the overlay (buffered writes) on top of the
 * real BucketServer state, providing read-your-own-writes isolation.
 */
export class TransactionBucketHandle {
  readonly #name: string;
  readonly #ref: BucketRef;
  readonly #buffer: BucketWriteBuffer;
  readonly #validator: SchemaValidator;
  readonly #keyField: string;
  #autoincrementCounter: number;

  constructor(
    name: string,
    ref: BucketRef,
    buffer: BucketWriteBuffer,
    definition: BucketDefinition,
    autoincrementCounter: number,
  ) {
    this.#name = name;
    this.#ref = ref;
    this.#buffer = buffer;
    this.#keyField = definition.key;
    this.#validator = new SchemaValidator(name, definition.schema, definition.key);
    this.#autoincrementCounter = autoincrementCounter;
  }

  get name(): string {
    return this.#name;
  }

  get autoincrementCounter(): number {
    return this.#autoincrementCounter;
  }

  // ── Write operations (buffered locally) ───────────────────────

  async insert(data: Record<string, unknown>): Promise<StoreRecord> {
    this.#autoincrementCounter++;
    const record = this.#validator.prepareInsert(data, this.#autoincrementCounter);
    const key = (record as Record<string, unknown>)[this.#keyField];
    this.#buffer.addInsert(key, record);
    return record;
  }

  async update(key: unknown, changes: Record<string, unknown>): Promise<StoreRecord> {
    const existing = await this.get(key);
    if (existing === undefined) {
      throw new Error(`Record with key "${String(key)}" not found in bucket "${this.#name}"`);
    }
    const updated = this.#validator.prepareUpdate(existing, changes);
    this.#buffer.addUpdate(key, existing, updated);
    return updated;
  }

  async delete(key: unknown): Promise<void> {
    const existing = await this.get(key);
    if (existing === undefined) return; // idempotent
    this.#buffer.addDelete(key, existing);
  }

  // ── Read operations (overlay → real store) ────────────────────

  async get(key: unknown): Promise<StoreRecord | undefined> {
    const overlay = this.#buffer.getOverlay(key);
    if (overlay === null) return undefined;   // deleted in this tx
    if (overlay !== undefined) return overlay; // inserted or updated in this tx
    const reply = await GenServer.call(this.#ref, { type: 'get', key });
    return reply as StoreRecord | undefined;
  }

  async all(): Promise<StoreRecord[]> {
    const realRecords = await GenServer.call(this.#ref, { type: 'all' }) as StoreRecord[];
    return this.#applyOverlay(realRecords);
  }

  async where(filter: Record<string, unknown>): Promise<StoreRecord[]> {
    const records = await this.all();
    return records.filter((r) => matchesFilter(r, filter));
  }

  async findOne(filter: Record<string, unknown>): Promise<StoreRecord | undefined> {
    const records = await this.all();
    return records.find((r) => matchesFilter(r, filter));
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    if (filter !== undefined) {
      return (await this.where(filter)).length;
    }
    return (await this.all()).length;
  }

  // ── Private helpers ───────────────────────────────────────────

  #applyOverlay(realRecords: StoreRecord[]): StoreRecord[] {
    const result: StoreRecord[] = [];

    for (const record of realRecords) {
      const key = (record as Record<string, unknown>)[this.#keyField];

      if (this.#buffer.deletes.has(key)) continue;

      const updated = this.#buffer.updates.get(key);
      result.push(updated !== undefined ? updated : record);
    }

    for (const record of this.#buffer.inserts.values()) {
      result.push(record);
    }

    return result;
  }
}

// ── Module-level helpers ──────────────────────────────────────────

function matchesFilter(
  record: StoreRecord,
  filter: Record<string, unknown>,
): boolean {
  for (const [field, value] of Object.entries(filter)) {
    if ((record as Record<string, unknown>)[field] !== value) {
      return false;
    }
  }
  return true;
}
