import type { BucketDefinition, FieldDefinition, FieldType } from './schema.js';

// ── Migration definition ────────────────────────────────────────

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (ctx: MigrationContext) => Promise<void>;
  readonly down?: (ctx: MigrationContext) => Promise<void>;
}

// ── Context provided to each migration ──────────────────────────

export interface MigrationContext {
  bucket(name: string): MigrationBucketHandle;
  createBucket(name: string, definition: BucketDefinition): Promise<void>;
  dropBucket(name: string): Promise<void>;
}

// ── Per-bucket operations available during migration ────────────

export interface MigrationBucketHandle {
  addField(name: string, definition: FieldDefinition, defaultValue?: unknown): Promise<void>;
  removeField(name: string): Promise<void>;
  renameField(oldName: string, newName: string): Promise<void>;
  changeFieldType(name: string, newType: FieldType, transform: (value: unknown) => unknown): Promise<void>;
  addIndex(field: string): Promise<void>;
  removeIndex(field: string): Promise<void>;
  transformAll(fn: (record: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
}

// ── Result of running migrations ────────────────────────────────

export interface MigrationResult {
  readonly applied: number;
  readonly currentVersion: number;
}
