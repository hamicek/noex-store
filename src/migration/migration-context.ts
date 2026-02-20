import type { Store } from '../core/store.js';
import type {
  BucketDefinition,
  FieldDefinition,
  FieldType,
  SchemaDefinition,
  StoreRecord,
} from '../types/index.js';
import type { MigrationContext, MigrationBucketHandle } from '../types/migration.js';

// ── MigrationContext ────────────────────────────────────────────

export class MigrationContextImpl implements MigrationContext {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  bucket(name: string): MigrationBucketHandle {
    return new MigrationBucketHandleImpl(this.#store, name);
  }

  async createBucket(name: string, definition: BucketDefinition): Promise<void> {
    await this.#store.defineBucket(name, definition);
  }

  async dropBucket(name: string): Promise<void> {
    await this.#store.dropBucket(name);
  }
}

// ── MigrationBucketHandle ───────────────────────────────────────

class MigrationBucketHandleImpl implements MigrationBucketHandle {
  readonly #store: Store;
  readonly #name: string;

  constructor(store: Store, name: string) {
    this.#store = store;
    this.#name = name;
  }

  async addField(
    name: string,
    definition: FieldDefinition,
    defaultValue?: unknown,
  ): Promise<void> {
    const def = this.#getDefinition();

    if (name in def.schema) {
      throw new Error(`Field "${name}" already exists in bucket "${this.#name}"`);
    }

    const newSchema: Record<string, FieldDefinition> = { ...def.schema, [name]: definition };
    const newDef = buildDefinition(def, { schema: newSchema as SchemaDefinition });

    const transform = defaultValue !== undefined
      ? (records: ReadonlyArray<readonly [unknown, StoreRecord]>) =>
          records.map(([key, record]) =>
            [key, { ...record, [name]: defaultValue }] as [unknown, StoreRecord],
          )
      : undefined;

    await this.#store.rebuildBucket(this.#name, newDef, transform);
  }

  async removeField(name: string): Promise<void> {
    const def = this.#getDefinition();

    if (!(name in def.schema)) {
      throw new Error(`Field "${name}" does not exist in bucket "${this.#name}"`);
    }
    if (name === def.key) {
      throw new Error(`Cannot remove key field "${name}" from bucket "${this.#name}"`);
    }

    const { [name]: _, ...remainingSchema } = def.schema;
    const newIndexes = (def.indexes ?? []).filter(i => i !== name);
    const newDef = buildDefinition(def, {
      schema: remainingSchema as SchemaDefinition,
      indexes: newIndexes,
    });

    const transform = (records: ReadonlyArray<readonly [unknown, StoreRecord]>) =>
      records.map(([key, record]) => {
        const { [name]: _, ...rest } = record as Record<string, unknown>;
        return [key, rest as StoreRecord] as [unknown, StoreRecord];
      });

    await this.#store.rebuildBucket(this.#name, newDef, transform);
  }

  async renameField(oldName: string, newName: string): Promise<void> {
    const def = this.#getDefinition();

    if (!(oldName in def.schema)) {
      throw new Error(`Field "${oldName}" does not exist in bucket "${this.#name}"`);
    }
    if (oldName === def.key) {
      throw new Error(`Cannot rename key field "${oldName}" in bucket "${this.#name}"`);
    }
    if (newName in def.schema) {
      throw new Error(`Field "${newName}" already exists in bucket "${this.#name}"`);
    }

    // Rebuild schema with the field under its new name, preserving field order
    const newSchema: Record<string, FieldDefinition> = {};
    for (const [field, fieldDef] of Object.entries(def.schema)) {
      if (field === oldName) {
        newSchema[newName] = fieldDef;
      } else {
        newSchema[field] = fieldDef;
      }
    }

    const newIndexes = (def.indexes ?? []).map(i => i === oldName ? newName : i);
    const newDef = buildDefinition(def, {
      schema: newSchema as SchemaDefinition,
      indexes: newIndexes,
    });

    const transform = (records: ReadonlyArray<readonly [unknown, StoreRecord]>) =>
      records.map(([key, record]) => {
        const rec = record as Record<string, unknown>;
        const { [oldName]: value, ...rest } = rec;
        return [key, { ...rest, [newName]: value } as StoreRecord] as [unknown, StoreRecord];
      });

    await this.#store.rebuildBucket(this.#name, newDef, transform);
  }

  async changeFieldType(
    name: string,
    newType: FieldType,
    transform: (value: unknown) => unknown,
  ): Promise<void> {
    const def = this.#getDefinition();

    if (!(name in def.schema)) {
      throw new Error(`Field "${name}" does not exist in bucket "${this.#name}"`);
    }
    if (name === def.key) {
      throw new Error(`Cannot change type of key field "${name}" in bucket "${this.#name}"`);
    }

    const oldFieldDef = def.schema[name]!;
    const newFieldDef: FieldDefinition = { ...oldFieldDef, type: newType };
    const newSchema: Record<string, FieldDefinition> = { ...def.schema, [name]: newFieldDef };
    const newDef = buildDefinition(def, { schema: newSchema as SchemaDefinition });

    const recordTransform = (records: ReadonlyArray<readonly [unknown, StoreRecord]>) =>
      records.map(([key, record]) => {
        const rec = record as Record<string, unknown>;
        const oldValue = rec[name];
        const newValue = oldValue !== undefined && oldValue !== null
          ? transform(oldValue)
          : oldValue;
        return [key, { ...rec, [name]: newValue } as StoreRecord] as [unknown, StoreRecord];
      });

    await this.#store.rebuildBucket(this.#name, newDef, recordTransform);
  }

  async addIndex(field: string): Promise<void> {
    await this.#store.updateBucket(this.#name, { addIndexes: [field] });
  }

  async removeIndex(field: string): Promise<void> {
    const def = this.#getDefinition();

    const currentIndexes = def.indexes ?? [];
    if (!currentIndexes.includes(field)) {
      throw new Error(`Index on field "${field}" does not exist in bucket "${this.#name}"`);
    }

    const newIndexes = currentIndexes.filter(i => i !== field);
    const newDef = buildDefinition(def, { indexes: newIndexes });

    await this.#store.rebuildBucket(this.#name, newDef);
  }

  async transformAll(
    fn: (record: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const def = this.#getDefinition();
    const keyField = def.key;

    const transform = (records: ReadonlyArray<readonly [unknown, StoreRecord]>) =>
      records.map(([_key, record]) => {
        const transformed = fn(record as Record<string, unknown>);
        return [transformed[keyField], transformed as StoreRecord] as [unknown, StoreRecord];
      });

    await this.#store.rebuildBucket(this.#name, def, transform);
  }

  #getDefinition(): BucketDefinition {
    const def = this.#store.getBucketSchema(this.#name);
    if (!def) {
      throw new Error(`Bucket "${this.#name}" does not exist`);
    }
    return def;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Build a BucketDefinition from a base, overriding specific fields.
 * Uses a plain object + cast to satisfy exactOptionalPropertyTypes.
 */
function buildDefinition(
  base: BucketDefinition,
  overrides: {
    schema?: SchemaDefinition;
    indexes?: readonly string[];
  },
): BucketDefinition {
  const result: Record<string, unknown> = {
    key: base.key,
    schema: overrides.schema ?? base.schema,
  };

  const indexes = overrides.indexes ?? base.indexes;
  if (indexes !== undefined && indexes.length > 0) {
    result['indexes'] = indexes;
  }

  if (base.etsType !== undefined) result['etsType'] = base.etsType;
  if (base.persistent !== undefined) result['persistent'] = base.persistent;
  if (base.ttl !== undefined) result['ttl'] = base.ttl;
  if (base.maxSize !== undefined) result['maxSize'] = base.maxSize;

  return result as unknown as BucketDefinition;
}
