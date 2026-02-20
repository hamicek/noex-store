import type { StorageAdapter } from '@hamicek/noex';

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date';

export type GeneratedType = 'uuid' | 'cuid' | 'autoincrement' | 'timestamp';

export type FormatType = 'email' | 'url' | 'iso-date';

export type EtsTableType = 'set' | 'ordered_set' | 'bag' | 'duplicate_bag';

export type OnDeleteAction = 'restrict' | 'cascade' | 'set_null';

export interface FieldDefinition {
  readonly type: FieldType;
  readonly required?: boolean;
  readonly default?: unknown | (() => unknown);
  readonly generated?: GeneratedType;
  readonly enum?: readonly unknown[];
  readonly format?: FormatType;
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly ref?: string;
  readonly onDelete?: OnDeleteAction;
  readonly unique?: boolean;
  /** Nested schema for `type: 'object'` — validates properties of the object. */
  readonly properties?: SchemaDefinition;
  /** Item schema for `type: 'array'` — validates each element of the array. */
  readonly items?: FieldDefinition;
}

export type SchemaDefinition = Readonly<Record<string, FieldDefinition>>;

export interface BucketDefinition {
  readonly key: string;
  readonly schema: SchemaDefinition;
  readonly indexes?: readonly string[];
  readonly etsType?: EtsTableType;
  /** Opt-out of persistence. Default: `true` when store has persistence configured. */
  readonly persistent?: boolean;
  /** Time-to-live per record. Number = ms, string = human-readable ("1s", "30m", "1h", "7d", "90d"). */
  readonly ttl?: number | string;
  /** Maximum number of records. Oldest records (by _createdAt) are evicted on overflow. */
  readonly maxSize?: number;
}

export interface BucketSchemaUpdate {
  /** Add new fields to the schema. Cannot overwrite existing fields. */
  readonly addFields?: Readonly<Record<string, FieldDefinition>>;
  /** Add new indexes. Fields must exist in the schema. */
  readonly addIndexes?: readonly string[];
  /** Change TTL. `null` removes TTL. */
  readonly ttl?: number | string | null;
}

export interface StorePersistenceConfig {
  /** Storage adapter (MemoryAdapter, FileAdapter, SQLiteAdapter from @hamicek/noex). */
  readonly adapter: StorageAdapter;
  /** Debounce interval for batched writes in ms. Default: 100. */
  readonly debounceMs?: number;
  /** Callback for non-fatal persistence errors. */
  readonly onError?: (error: Error) => void;
}

