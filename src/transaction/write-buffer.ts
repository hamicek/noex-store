import type { StoreRecord } from '../types/index.js';

export interface BufferedInsert {
  readonly type: 'insert';
  readonly key: unknown;
  readonly record: StoreRecord;
}

export interface BufferedUpdate {
  readonly type: 'update';
  readonly key: unknown;
  readonly oldRecord: StoreRecord;
  readonly newRecord: StoreRecord;
  readonly expectedVersion: number;
}

export interface BufferedDelete {
  readonly type: 'delete';
  readonly key: unknown;
  readonly record: StoreRecord;
  readonly expectedVersion: number;
}

export type BufferedOp = BufferedInsert | BufferedUpdate | BufferedDelete;

/**
 * Per-bucket write buffer that tracks inserts, updates, and deletes.
 * Maintains an overlay for read-your-own-writes isolation.
 */
export class BucketWriteBuffer {
  readonly inserts = new Map<unknown, StoreRecord>();
  readonly updates = new Map<unknown, StoreRecord>();
  readonly deletes = new Map<unknown, StoreRecord>();
  readonly ops: BufferedOp[] = [];

  addInsert(key: unknown, record: StoreRecord): void {
    this.inserts.set(key, record);
    this.deletes.delete(key);
    this.ops.push({ type: 'insert', key, record });
  }

  addUpdate(key: unknown, oldRecord: StoreRecord, newRecord: StoreRecord): void {
    if (this.inserts.has(key)) {
      this.inserts.set(key, newRecord);
    } else {
      this.updates.set(key, newRecord);
    }
    this.ops.push({ type: 'update', key, oldRecord, newRecord, expectedVersion: oldRecord._version });
  }

  addDelete(key: unknown, record: StoreRecord): void {
    if (this.inserts.has(key)) {
      this.inserts.delete(key);
    } else {
      this.deletes.set(key, record);
      this.updates.delete(key);
    }
    this.ops.push({ type: 'delete', key, record, expectedVersion: record._version });
  }

  /**
   * Look up a record in the overlay.
   * Returns: StoreRecord if found in inserts/updates, null if deleted, undefined if not in buffer.
   */
  getOverlay(key: unknown): StoreRecord | null | undefined {
    if (this.deletes.has(key)) return null;
    const inserted = this.inserts.get(key);
    if (inserted !== undefined) return inserted;
    const updated = this.updates.get(key);
    if (updated !== undefined) return updated;
    return undefined;
  }

  get isEmpty(): boolean {
    return this.inserts.size === 0 && this.updates.size === 0 && this.deletes.size === 0;
  }
}

/**
 * Top-level write buffer that manages per-bucket buffers.
 */
export class WriteBuffer {
  readonly #buckets = new Map<string, BucketWriteBuffer>();

  forBucket(name: string): BucketWriteBuffer {
    let buf = this.#buckets.get(name);
    if (buf === undefined) {
      buf = new BucketWriteBuffer();
      this.#buckets.set(name, buf);
    }
    return buf;
  }

  getBucketNames(): string[] {
    return [...this.#buckets.keys()];
  }

  getBucket(name: string): BucketWriteBuffer | undefined {
    return this.#buckets.get(name);
  }

  get isEmpty(): boolean {
    for (const buf of this.#buckets.values()) {
      if (!buf.isEmpty) return false;
    }
    return true;
  }
}
