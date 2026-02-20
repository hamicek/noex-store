import type { BucketDefinition, OnDeleteAction } from '../types/index.js';
import type { BucketHandle } from './bucket-handle.js';

// ── Error ────────────────────────────────────────────────────────────

export class ReferentialIntegrityError extends Error {
  override readonly name = 'ReferentialIntegrityError';
  readonly sourceBucket: string;
  readonly sourceField: string;
  readonly targetBucket: string;
  readonly targetKey: unknown;

  constructor(
    message: string,
    sourceBucket: string,
    sourceField: string,
    targetBucket: string,
    targetKey: unknown,
  ) {
    super(message);
    this.sourceBucket = sourceBucket;
    this.sourceField = sourceField;
    this.targetBucket = targetBucket;
    this.targetKey = targetKey;
  }
}

// ── Key serialization ────────────────────────────────────────────────

function serializeKey(key: unknown): string {
  if (typeof key === 'number') return `n:${key}`;
  if (typeof key === 'string') return `s:${key}`;
  return `o:${JSON.stringify(key)}`;
}

function deserializeKey(serialized: string): unknown {
  if (serialized.startsWith('n:')) return Number(serialized.slice(2));
  if (serialized.startsWith('s:')) return serialized.slice(2);
  if (serialized.startsWith('o:')) return JSON.parse(serialized.slice(2)) as unknown;
  return serialized;
}

// ── Types ────────────────────────────────────────────────────────────

interface RefFieldInfo {
  readonly targetBucket: string;
  readonly onDelete: OnDeleteAction;
}

// ── RefManager ───────────────────────────────────────────────────────

/**
 * Manages referential integrity across buckets.
 *
 * Maintains forward and reverse reference indexes in-memory and
 * validates ref constraints on insert/update/delete operations.
 *
 * - Forward index: source record → Map<field, serialized target key>
 * - Reverse index: target bucket → target key → Set<source references>
 */
export class RefManager {
  /** bucket → Map<field, RefFieldInfo> */
  readonly #refFields = new Map<string, Map<string, RefFieldInfo>>();
  /** bucket → key field name */
  readonly #keyFields = new Map<string, string>();

  /**
   * Forward index: `${bucket}\0${serializedKey}` → Map<field, serializedTargetKey>
   * Tracks which refs each source record holds.
   */
  readonly #forwardIndex = new Map<string, Map<string, string>>();

  /**
   * Reverse index: targetBucket → Map<serializedTargetKey, Set<`${srcBucket}\0${serializedSrcKey}\0${field}`>>
   * Tracks who references a given target record.
   */
  readonly #reverseIndex = new Map<string, Map<string, Set<string>>>();

  /** Returns a raw BucketHandle (without RefManager) for cascade operations. */
  readonly #getRawBucket: (name: string) => BucketHandle;

  constructor(getRawBucket: (name: string) => BucketHandle) {
    this.#getRawBucket = getRawBucket;
  }

  // ── Registration ─────────────────────────────────────────────────

  registerBucket(name: string, definition: BucketDefinition): void {
    this.#keyFields.set(name, definition.key);

    const refs = new Map<string, RefFieldInfo>();
    for (const [field, def] of Object.entries(definition.schema)) {
      if (def.ref === undefined) continue;

      if (def.onDelete === 'set_null' && def.required === true) {
        throw new Error(
          `Invalid schema for bucket "${name}": field "${field}" has onDelete "set_null" but is required`,
        );
      }

      refs.set(field, {
        targetBucket: def.ref,
        onDelete: def.onDelete ?? 'restrict',
      });
    }

    if (refs.size > 0) {
      this.#refFields.set(name, refs);
    }
  }

  unregisterBucket(name: string): void {
    // Remove forward index entries for this bucket
    for (const [fwdKey, fields] of this.#forwardIndex) {
      if (!fwdKey.startsWith(`${name}\0`)) continue;
      const refs = this.#refFields.get(name);
      if (refs !== undefined) {
        for (const [field, serializedTargetKey] of fields) {
          const info = refs.get(field);
          if (info !== undefined) {
            this.#removeReverseEntry(
              info.targetBucket, serializedTargetKey,
              name, fwdKey.slice(name.length + 1), field,
            );
          }
        }
      }
      this.#forwardIndex.delete(fwdKey);
    }

    // Remove reverse index entries where this bucket is a target
    this.#reverseIndex.delete(name);

    this.#refFields.delete(name);
    this.#keyFields.delete(name);
  }

  /**
   * Populate indexes from existing records (e.g., after loading from persistence).
   */
  async indexExistingRecords(bucket: string): Promise<void> {
    if (!this.#refFields.has(bucket)) return;
    const records = await this.#getRawBucket(bucket).all();
    for (const record of records) {
      this.onRecordInserted(bucket, record as Record<string, unknown>);
    }
  }

  // ── Queries ──────────────────────────────────────────────────────

  hasRefFields(bucket: string): boolean {
    return this.#refFields.has(bucket);
  }

  isRefTarget(bucket: string): boolean {
    for (const refs of this.#refFields.values()) {
      for (const info of refs.values()) {
        if (info.targetBucket === bucket) return true;
      }
    }
    return false;
  }

  // ── Validation (insert / update) ─────────────────────────────────

  async validateInsertRefs(
    bucket: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const refs = this.#refFields.get(bucket);
    if (refs === undefined) return;

    for (const [field, info] of refs) {
      const value = data[field];
      if (value === undefined || value === null) continue;

      const target = await this.#getRawBucket(info.targetBucket).get(value);
      if (target === undefined) {
        throw new ReferentialIntegrityError(
          `Foreign key violation in bucket "${bucket}": field "${field}" references ` +
          `bucket "${info.targetBucket}" with key "${String(value)}", but no such record exists`,
          bucket, field, info.targetBucket, value,
        );
      }
    }
  }

  async validateUpdateRefs(
    bucket: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    const refs = this.#refFields.get(bucket);
    if (refs === undefined) return;

    for (const [field, info] of refs) {
      if (!(field in changes)) continue;
      const value = changes[field];
      if (value === undefined || value === null) continue;

      const target = await this.#getRawBucket(info.targetBucket).get(value);
      if (target === undefined) {
        throw new ReferentialIntegrityError(
          `Foreign key violation in bucket "${bucket}": field "${field}" references ` +
          `bucket "${info.targetBucket}" with key "${String(value)}", but no such record exists`,
          bucket, field, info.targetBucket, value,
        );
      }
    }
  }

  // ── Delete handling ──────────────────────────────────────────────

  /**
   * Process referential integrity constraints before deleting a record.
   *
   * - `restrict`: throws if any record references the target
   * - `cascade`: recursively deletes referencing records
   * - `set_null`: nulls out the referencing field
   *
   * Tracks visited records to prevent infinite loops on circular refs.
   */
  async handleDelete(
    bucket: string,
    key: unknown,
    visited = new Set<string>(),
  ): Promise<void> {
    const recordId = `${bucket}\0${serializeKey(key)}`;
    if (visited.has(recordId)) return;
    visited.add(recordId);

    const targetIndex = this.#reverseIndex.get(bucket);
    if (targetIndex === undefined) return;

    const serializedKey = serializeKey(key);
    const incoming = targetIndex.get(serializedKey);
    if (incoming === undefined || incoming.size === 0) return;

    // Snapshot the set — cascade/set_null mutates it via onRecordDeleted/Updated
    for (const refStr of [...incoming]) {
      const sepFirst = refStr.indexOf('\0');
      const sepSecond = refStr.indexOf('\0', sepFirst + 1);
      const sourceBucket = refStr.slice(0, sepFirst);
      const serializedSourceKey = refStr.slice(sepFirst + 1, sepSecond);
      const sourceField = refStr.slice(sepSecond + 1);
      const sourceKey = deserializeKey(serializedSourceKey);

      const refs = this.#refFields.get(sourceBucket);
      const onDelete = refs?.get(sourceField)?.onDelete ?? 'restrict';

      switch (onDelete) {
        case 'restrict':
          throw new ReferentialIntegrityError(
            `Cannot delete from bucket "${bucket}" (key "${String(key)}"): ` +
            `referenced by bucket "${sourceBucket}" (key "${String(sourceKey)}") via field "${sourceField}"`,
            sourceBucket, sourceField, bucket, key,
          );
        case 'cascade':
          // First resolve cascades for the referencing record itself
          await this.handleDelete(sourceBucket, sourceKey, visited);
          // Then delete it
          await this.#getRawBucket(sourceBucket).delete(sourceKey);
          this.onRecordDeleted(sourceBucket, sourceKey);
          break;
        case 'set_null':
          await this.#getRawBucket(sourceBucket).update(sourceKey, { [sourceField]: null });
          this.onRecordUpdated(sourceBucket, sourceKey, { [sourceField]: null });
          break;
      }
    }
  }

  /**
   * Handle deleteMany: pre-query affected records, process cascades, then
   * let BucketHandle perform the actual batch delete.
   *
   * Returns the keys of records that will be deleted (for index cleanup).
   */
  async handleDeleteMany(
    bucket: string,
    records: readonly Record<string, unknown>[],
  ): Promise<void> {
    const keyField = this.#keyFields.get(bucket)!;
    const visited = new Set<string>();

    for (const record of records) {
      const key = record[keyField];
      await this.handleDelete(bucket, key, visited);
    }
  }

  // ── Index maintenance ────────────────────────────────────────────

  onRecordInserted(bucket: string, record: Record<string, unknown>): void {
    const refs = this.#refFields.get(bucket);
    if (refs === undefined) return;

    const keyField = this.#keyFields.get(bucket)!;
    const key = record[keyField];
    const serializedKey = serializeKey(key);
    const fwdKey = `${bucket}\0${serializedKey}`;
    const forward = new Map<string, string>();

    for (const [field, info] of refs) {
      const value = record[field];
      if (value === undefined || value === null) continue;

      const serializedTargetKey = serializeKey(value);
      forward.set(field, serializedTargetKey);
      this.#addReverseEntry(info.targetBucket, serializedTargetKey, bucket, serializedKey, field);
    }

    if (forward.size > 0) {
      this.#forwardIndex.set(fwdKey, forward);
    }
  }

  onRecordUpdated(
    bucket: string,
    key: unknown,
    changes: Record<string, unknown>,
  ): void {
    const refs = this.#refFields.get(bucket);
    if (refs === undefined) return;

    const serializedKey = serializeKey(key);
    const fwdKey = `${bucket}\0${serializedKey}`;
    const forward = this.#forwardIndex.get(fwdKey) ?? new Map<string, string>();

    for (const [field, info] of refs) {
      if (!(field in changes)) continue;

      const oldSerializedTarget = forward.get(field);
      const newValue = changes[field];

      // Remove old reverse entry
      if (oldSerializedTarget !== undefined) {
        this.#removeReverseEntry(info.targetBucket, oldSerializedTarget, bucket, serializedKey, field);
        forward.delete(field);
      }

      // Add new reverse entry
      if (newValue !== undefined && newValue !== null) {
        const newSerializedTarget = serializeKey(newValue);
        forward.set(field, newSerializedTarget);
        this.#addReverseEntry(info.targetBucket, newSerializedTarget, bucket, serializedKey, field);
      }
    }

    if (forward.size > 0) {
      this.#forwardIndex.set(fwdKey, forward);
    } else {
      this.#forwardIndex.delete(fwdKey);
    }
  }

  onRecordDeleted(bucket: string, key: unknown): void {
    const refs = this.#refFields.get(bucket);
    if (refs === undefined) return;

    const serializedKey = serializeKey(key);
    const fwdKey = `${bucket}\0${serializedKey}`;
    const forward = this.#forwardIndex.get(fwdKey);
    if (forward === undefined) return;

    for (const [field, serializedTargetKey] of forward) {
      const info = refs.get(field);
      if (info !== undefined) {
        this.#removeReverseEntry(info.targetBucket, serializedTargetKey, bucket, serializedKey, field);
      }
    }

    this.#forwardIndex.delete(fwdKey);
  }

  /**
   * Handle upsert: remove old entries and add new ones.
   * Works for both insert and update cases.
   */
  onRecordUpserted(bucket: string, record: Record<string, unknown>): void {
    const keyField = this.#keyFields.get(bucket)!;
    const key = record[keyField];
    this.onRecordDeleted(bucket, key);
    this.onRecordInserted(bucket, record);
  }

  extractKey(bucket: string, record: Record<string, unknown>): unknown {
    return record[this.#keyFields.get(bucket)!];
  }

  // ── Private helpers ──────────────────────────────────────────────

  #addReverseEntry(
    targetBucket: string,
    serializedTargetKey: string,
    sourceBucket: string,
    serializedSourceKey: string,
    field: string,
  ): void {
    let bucketIndex = this.#reverseIndex.get(targetBucket);
    if (bucketIndex === undefined) {
      bucketIndex = new Map();
      this.#reverseIndex.set(targetBucket, bucketIndex);
    }

    let refs = bucketIndex.get(serializedTargetKey);
    if (refs === undefined) {
      refs = new Set();
      bucketIndex.set(serializedTargetKey, refs);
    }

    refs.add(`${sourceBucket}\0${serializedSourceKey}\0${field}`);
  }

  #removeReverseEntry(
    targetBucket: string,
    serializedTargetKey: string,
    sourceBucket: string,
    serializedSourceKey: string,
    field: string,
  ): void {
    const bucketIndex = this.#reverseIndex.get(targetBucket);
    if (bucketIndex === undefined) return;

    const refs = bucketIndex.get(serializedTargetKey);
    if (refs === undefined) return;

    refs.delete(`${sourceBucket}\0${serializedSourceKey}\0${field}`);
    if (refs.size === 0) {
      bucketIndex.delete(serializedTargetKey);
    }
  }
}
