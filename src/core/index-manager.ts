import type { SchemaDefinition } from '../types/index.js';
import { UniqueConstraintError } from './store.js';

// ── Internal index structures ─────────────────────────────────────

interface UniqueIndex {
  readonly kind: 'unique';
  /** value → primaryKey (1:1) */
  readonly valueToKey: Map<unknown, unknown>;
}

interface NonUniqueIndex {
  readonly kind: 'non-unique';
  /** value → Set<primaryKey> (1:N) */
  readonly valueToKeys: Map<unknown, Set<unknown>>;
}

type IndexStore = UniqueIndex | NonUniqueIndex;

// ── IndexManager ──────────────────────────────────────────────────

export class IndexManager {
  readonly #bucketName: string;
  readonly #indexes: Map<string, IndexStore>;

  constructor(
    bucketName: string,
    indexedFields: readonly string[],
    schema: SchemaDefinition,
  ) {
    this.#bucketName = bucketName;
    this.#indexes = new Map();

    const indexedSet = new Set(indexedFields);

    // Create indexes for explicitly listed fields
    for (const field of indexedFields) {
      const def = schema[field];
      this.#indexes.set(
        field,
        def?.unique === true ? createUniqueIndex() : createNonUniqueIndex(),
      );
    }

    // Create UniqueIndex for fields with unique: true that aren't already indexed
    for (const [field, def] of Object.entries(schema)) {
      if (def.unique === true && !indexedSet.has(field)) {
        this.#indexes.set(field, createUniqueIndex());
      }
    }
  }

  /**
   * Add a record to all indexes.
   *
   * Two-phase approach:
   * 1. Check ALL unique constraints first
   * 2. Write to ALL indexes only if every check passed
   *
   * This prevents partial index updates on constraint violation.
   */
  addRecord(primaryKey: unknown, record: Record<string, unknown>): void {
    // Phase 1 — validate unique constraints
    for (const [field, index] of this.#indexes) {
      if (index.kind !== 'unique') continue;
      const value = record[field];
      if (value == null) continue; // null/undefined are not indexed

      const existingKey = index.valueToKey.get(value);
      if (existingKey !== undefined) {
        throw new UniqueConstraintError(this.#bucketName, field, value);
      }
    }

    // Phase 2 — write to all indexes
    for (const [field, index] of this.#indexes) {
      const value = record[field];
      if (value == null) continue;

      if (index.kind === 'unique') {
        index.valueToKey.set(value, primaryKey);
      } else {
        let keys = index.valueToKeys.get(value);
        if (keys === undefined) {
          keys = new Set();
          index.valueToKeys.set(value, keys);
        }
        keys.add(primaryKey);
      }
    }
  }

  /** Remove a record from all indexes. */
  removeRecord(primaryKey: unknown, record: Record<string, unknown>): void {
    for (const [field, index] of this.#indexes) {
      const value = record[field];
      if (value == null) continue;

      if (index.kind === 'unique') {
        index.valueToKey.delete(value);
      } else {
        const keys = index.valueToKeys.get(value);
        if (keys !== undefined) {
          keys.delete(primaryKey);
          if (keys.size === 0) {
            index.valueToKeys.delete(value);
          }
        }
      }
    }
  }

  /**
   * Update indexes when a record changes.
   *
   * Skips fields where the value hasn't changed (===).
   * For unique indexes, the check ignores the record's own key (excludeKey).
   */
  updateRecord(
    primaryKey: unknown,
    oldRecord: Record<string, unknown>,
    newRecord: Record<string, unknown>,
  ): void {
    // Phase 1 — validate unique constraints for changed fields
    for (const [field, index] of this.#indexes) {
      if (index.kind !== 'unique') continue;

      const oldValue = oldRecord[field];
      const newValue = newRecord[field];
      if (newValue === oldValue) continue; // no change — skip
      if (newValue == null) continue; // clearing to null — always allowed

      const existingKey = index.valueToKey.get(newValue);
      if (existingKey !== undefined && existingKey !== primaryKey) {
        throw new UniqueConstraintError(this.#bucketName, field, newValue);
      }
    }

    // Phase 2 — update all indexes for changed fields
    for (const [field, index] of this.#indexes) {
      const oldValue = oldRecord[field];
      const newValue = newRecord[field];
      if (newValue === oldValue) continue;

      // Remove old entry
      if (oldValue != null) {
        if (index.kind === 'unique') {
          index.valueToKey.delete(oldValue);
        } else {
          const keys = index.valueToKeys.get(oldValue);
          if (keys !== undefined) {
            keys.delete(primaryKey);
            if (keys.size === 0) {
              index.valueToKeys.delete(oldValue);
            }
          }
        }
      }

      // Add new entry
      if (newValue != null) {
        if (index.kind === 'unique') {
          index.valueToKey.set(newValue, primaryKey);
        } else {
          let keys = index.valueToKeys.get(newValue);
          if (keys === undefined) {
            keys = new Set();
            index.valueToKeys.set(newValue, keys);
          }
          keys.add(primaryKey);
        }
      }
    }
  }

  /**
   * Validate unique constraints for a new record without modifying indexes.
   * Throws UniqueConstraintError if any constraint would be violated.
   */
  validateInsert(_primaryKey: unknown, record: Record<string, unknown>): void {
    for (const [field, index] of this.#indexes) {
      if (index.kind !== 'unique') continue;
      const value = record[field];
      if (value == null) continue;

      const existingKey = index.valueToKey.get(value);
      if (existingKey !== undefined) {
        throw new UniqueConstraintError(this.#bucketName, field, value);
      }
    }
  }

  /**
   * Validate unique constraints for an update without modifying indexes.
   * Only checks fields whose value changed. Allows self-reference (same primary key).
   * Throws UniqueConstraintError if any constraint would be violated.
   */
  validateUpdate(
    primaryKey: unknown,
    oldRecord: Record<string, unknown>,
    newRecord: Record<string, unknown>,
  ): void {
    for (const [field, index] of this.#indexes) {
      if (index.kind !== 'unique') continue;

      const oldValue = oldRecord[field];
      const newValue = newRecord[field];
      if (newValue === oldValue) continue;
      if (newValue == null) continue;

      const existingKey = index.valueToKey.get(newValue);
      if (existingKey !== undefined && existingKey !== primaryKey) {
        throw new UniqueConstraintError(this.#bucketName, field, newValue);
      }
    }
  }

  /**
   * Look up primary keys by indexed field value.
   *
   * Returns an array of primary keys, or `undefined` if the field is not indexed
   * (signaling that the caller should fall back to a full scan).
   */
  lookup(fieldName: string, value: unknown): unknown[] | undefined {
    const index = this.#indexes.get(fieldName);
    if (index === undefined) return undefined;

    if (value == null) return [];

    if (index.kind === 'unique') {
      const key = index.valueToKey.get(value);
      return key !== undefined ? [key] : [];
    }

    const keys = index.valueToKeys.get(value);
    return keys !== undefined ? [...keys] : [];
  }

  /** Whether a field has an index. */
  isIndexed(fieldName: string): boolean {
    return this.#indexes.has(fieldName);
  }

  /** Clear all indexes. */
  clear(): void {
    for (const index of this.#indexes.values()) {
      if (index.kind === 'unique') {
        index.valueToKey.clear();
      } else {
        index.valueToKeys.clear();
      }
    }
  }
}

// ── Factories ─────────────────────────────────────────────────────

function createUniqueIndex(): UniqueIndex {
  return { kind: 'unique', valueToKey: new Map() };
}

function createNonUniqueIndex(): NonUniqueIndex {
  return { kind: 'non-unique', valueToKeys: new Map() };
}
