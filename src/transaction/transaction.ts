import { EventBus, GenServer, type EventBusRef } from '@hamicek/noex';
import type { BucketDefinition, BucketEvent } from '../types/index.js';
import type { BucketRef, CommitBatchOp, CommitBatchResult, UndoOp } from '../core/bucket-server.js';
import { TransactionBucketHandle } from './transaction-bucket-handle.js';
import { WriteBuffer } from './write-buffer.js';

/**
 * Transactional context for atomic multi-bucket writes.
 *
 * Created via {@link Store.transaction}. All writes are buffered locally
 * and committed atomically after the user callback completes. If the
 * callback throws, nothing is written. If any bucket commit fails,
 * previously committed buckets are rolled back via undo operations.
 */
export class TransactionContext {
  readonly #definitions: ReadonlyMap<string, BucketDefinition>;
  readonly #refs: ReadonlyMap<string, BucketRef>;
  readonly #eventBusRef: EventBusRef;
  readonly #buffer = new WriteBuffer();
  readonly #handles = new Map<string, TransactionBucketHandle>();
  #committed = false;

  constructor(
    definitions: ReadonlyMap<string, BucketDefinition>,
    refs: ReadonlyMap<string, BucketRef>,
    eventBusRef: EventBusRef,
  ) {
    this.#definitions = definitions;
    this.#refs = refs;
    this.#eventBusRef = eventBusRef;
  }

  /**
   * Obtain a transactional bucket handle. The handle is lazily created
   * on first access and cached for subsequent calls with the same name.
   *
   * Reads through the handle see buffered writes (read-your-own-writes).
   * Write operations are buffered until {@link commit}.
   */
  async bucket(name: string): Promise<TransactionBucketHandle> {
    const existing = this.#handles.get(name);
    if (existing !== undefined) return existing;

    const definition = this.#definitions.get(name);
    if (definition === undefined) {
      throw new Error(`Bucket "${name}" is not defined`);
    }

    const ref = this.#refs.get(name);
    if (ref === undefined) {
      throw new Error(`Bucket "${name}" is not defined`);
    }

    const counter = await GenServer.call(ref, { type: 'getAutoincrementCounter' }) as number;

    const bucketBuffer = this.#buffer.forBucket(name);
    const handle = new TransactionBucketHandle(name, ref, bucketBuffer, definition, counter);
    this.#handles.set(name, handle);
    return handle;
  }

  /**
   * Commit all buffered writes atomically across all touched buckets.
   *
   * Buckets are committed sequentially. If any bucket fails, all
   * previously committed buckets are rolled back (best-effort).
   * Events are published only after ALL buckets succeed.
   */
  async commit(): Promise<void> {
    if (this.#committed) {
      throw new Error('Transaction already committed');
    }
    this.#committed = true;

    if (this.#buffer.isEmpty) return;

    const bucketNames = this.#buffer.getBucketNames();
    const committed: Array<{ ref: BucketRef; undoOps: readonly UndoOp[] }> = [];
    const allEvents: BucketEvent[] = [];

    try {
      for (const name of bucketNames) {
        const bucketBuffer = this.#buffer.getBucket(name);
        if (bucketBuffer === undefined || bucketBuffer.isEmpty) continue;

        const ref = this.#refs.get(name)!;
        const handle = this.#handles.get(name);

        const operations = this.#buildCommitOps(name);

        const msg: { type: 'commitBatch'; operations: CommitBatchOp[]; autoincrementUpdate?: number } = {
          type: 'commitBatch',
          operations,
        };
        if (handle !== undefined) {
          msg.autoincrementUpdate = handle.autoincrementCounter;
        }

        const result = await GenServer.call(ref, msg) as CommitBatchResult;

        committed.push({ ref, undoOps: result.undoOps });
        allEvents.push(...result.events);
      }

      for (const event of allEvents) {
        EventBus.publish(this.#eventBusRef, `bucket.${event.bucket}.${event.type}`, event);
      }
    } catch (error) {
      for (let i = committed.length - 1; i >= 0; i--) {
        const { ref, undoOps } = committed[i]!;
        try {
          await GenServer.call(ref, { type: 'rollbackBatch', undoOps });
        } catch {
          // Best-effort rollback — swallow failures to continue
          // rolling back remaining buckets.
        }
      }
      throw error;
    }
  }

  #buildCommitOps(bucketName: string): CommitBatchOp[] {
    const bucketBuffer = this.#buffer.getBucket(bucketName)!;
    const ops: CommitBatchOp[] = [];

    for (const [key, record] of bucketBuffer.inserts) {
      ops.push({ type: 'insert', key, record });
    }

    for (const [key, newRecord] of bucketBuffer.updates) {
      // Find the first update op for this key — its expectedVersion
      // reflects the real store version at the time of first read.
      const firstOp = bucketBuffer.ops.find(
        (op) => op.type === 'update' && op.key === key,
      );
      const expectedVersion = firstOp?.type === 'update' ? firstOp.expectedVersion : 0;
      ops.push({ type: 'update', key, newRecord, expectedVersion });
    }

    for (const [key, record] of bucketBuffer.deletes) {
      ops.push({ type: 'delete', key, expectedVersion: record._version });
    }

    return ops;
  }
}
