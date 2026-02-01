export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date';

export type GeneratedType = 'uuid' | 'cuid' | 'autoincrement' | 'timestamp';

export type FormatType = 'email' | 'url' | 'iso-date';

export type EtsTableType = 'set' | 'ordered_set' | 'bag' | 'duplicate_bag';

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
  readonly unique?: boolean;
}

export type SchemaDefinition = Readonly<Record<string, FieldDefinition>>;

export interface BucketDefinition {
  readonly key: string;
  readonly schema: SchemaDefinition;
  readonly indexes?: readonly string[];
  readonly etsType?: EtsTableType;
}
