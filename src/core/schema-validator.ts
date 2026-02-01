import type {
  FieldDefinition,
  FieldType,
  FormatType,
  GeneratedType,
  SchemaDefinition,
  StoreRecord,
} from '../types/index.js';
import {
  generateCuid,
  generateTimestamp,
  generateUuid,
  isValidEmail,
  isValidIsoDate,
  isValidUrl,
} from '../utils/index.js';

// ── Public types ───────────────────────────────────────────────────

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
  readonly code: string;
}

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  readonly issues: readonly ValidationIssue[];

  constructor(bucketName: string, issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((i) => `${i.field}: ${i.message}`)
      .join('; ');
    super(`Validation failed for bucket "${bucketName}": ${summary}`);
    this.issues = issues;
  }
}

// ── Schema Validator ───────────────────────────────────────────────

export class SchemaValidator {
  readonly #bucketName: string;
  readonly #schema: SchemaDefinition;
  readonly #keyField: string;

  constructor(bucketName: string, schema: SchemaDefinition, keyField: string) {
    this.#bucketName = bucketName;
    this.#schema = schema;
    this.#keyField = keyField;
  }

  /**
   * Prepare a new record for insertion:
   * 1. Generate values for fields marked with `generated`
   * 2. Apply static or functional defaults
   * 3. Attach record metadata (_version, _createdAt, _updatedAt)
   * 4. Validate the complete record
   */
  prepareInsert(
    input: Record<string, unknown>,
    autoincrementCounter: number,
  ): StoreRecord {
    const record: Record<string, unknown> = { ...input };

    // 1. Generate values for fields with `generated` that are missing
    for (const [field, def] of Object.entries(this.#schema)) {
      if (def.generated != null && record[field] === undefined) {
        record[field] = this.#generateValue(def.generated, autoincrementCounter);
      }
    }

    // 2. Apply defaults for still-missing fields
    for (const [field, def] of Object.entries(this.#schema)) {
      if (record[field] === undefined && def.default !== undefined) {
        record[field] = typeof def.default === 'function'
          ? (def.default as () => unknown)()
          : def.default;
      }
    }

    // 3. Attach record metadata
    const now = Date.now();
    record._version = 1;
    record._createdAt = now;
    record._updatedAt = now;

    // 4. Validate the complete record
    this.#validate(record);

    return record as StoreRecord;
  }

  /**
   * Prepare an update to an existing record:
   * 1. Strip meta, generated fields, and primary key from changes
   * 2. Merge existing record with sanitized changes
   * 3. Bump _version and update _updatedAt
   * 4. Validate the merged record
   */
  prepareUpdate(
    existing: StoreRecord,
    changes: Record<string, unknown>,
  ): StoreRecord {
    const sanitized: Record<string, unknown> = { ...changes };

    // 1. Strip meta fields, generated fields, and primary key
    delete sanitized._version;
    delete sanitized._createdAt;
    delete sanitized._updatedAt;
    delete sanitized[this.#keyField];

    for (const [field, def] of Object.entries(this.#schema)) {
      if (def.generated != null) {
        delete sanitized[field];
      }
    }

    // 2. Merge existing record with sanitized changes
    const merged: Record<string, unknown> = {
      ...(existing as unknown as Record<string, unknown>),
      ...sanitized,
    };

    // 3. Bump version and update timestamp
    merged._version = existing._version + 1;
    merged._updatedAt = Date.now();

    // 4. Validate the merged record
    this.#validate(merged);

    return merged as StoreRecord;
  }

  // ── Private helpers ────────────────────────────────────────────

  #generateValue(generated: GeneratedType, autoincrementCounter: number): unknown {
    switch (generated) {
      case 'uuid':
        return generateUuid();
      case 'cuid':
        return generateCuid();
      case 'timestamp':
        return generateTimestamp();
      case 'autoincrement':
        return autoincrementCounter;
    }
  }

  #validate(record: Record<string, unknown>): void {
    const issues: ValidationIssue[] = [];

    for (const [field, def] of Object.entries(this.#schema)) {
      const value = record[field];

      if (def.required === true && (value === undefined || value === null)) {
        issues.push({ field, message: 'Field is required', code: 'required' });
        continue;
      }

      if (value === undefined || value === null) {
        continue;
      }

      if (!this.#matchesType(value, def.type)) {
        issues.push({
          field,
          message: `Expected type "${def.type}", got ${describeType(value)}`,
          code: 'type',
        });
        continue;
      }

      this.#validateConstraints(field, value, def, issues);
    }

    if (issues.length > 0) {
      throw new ValidationError(this.#bucketName, issues);
    }
  }

  #validateConstraints(
    field: string,
    value: unknown,
    def: FieldDefinition,
    issues: ValidationIssue[],
  ): void {
    if (def.enum != null && !def.enum.includes(value)) {
      issues.push({
        field,
        message: `Value must be one of: ${def.enum.map(String).join(', ')}`,
        code: 'enum',
      });
    }

    if (typeof value === 'string') {
      if (def.minLength != null && value.length < def.minLength) {
        issues.push({
          field,
          message: `Minimum length is ${String(def.minLength)}`,
          code: 'minLength',
        });
      }
      if (def.maxLength != null && value.length > def.maxLength) {
        issues.push({
          field,
          message: `Maximum length is ${String(def.maxLength)}`,
          code: 'maxLength',
        });
      }
      if (def.pattern != null && !new RegExp(def.pattern).test(value)) {
        issues.push({
          field,
          message: `Value must match pattern "${def.pattern}"`,
          code: 'pattern',
        });
      }
      if (def.format != null && !this.#matchesFormat(value, def.format)) {
        issues.push({
          field,
          message: `Invalid ${def.format} format`,
          code: 'format',
        });
      }
    }

    if (typeof value === 'number') {
      if (def.min != null && value < def.min) {
        issues.push({
          field,
          message: `Minimum value is ${String(def.min)}`,
          code: 'min',
        });
      }
      if (def.max != null && value > def.max) {
        issues.push({
          field,
          message: `Maximum value is ${String(def.max)}`,
          code: 'max',
        });
      }
    }
  }

  #matchesType(value: unknown, type: FieldType): boolean {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !Number.isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      case 'date':
        if (value instanceof Date) return !Number.isNaN(value.getTime());
        if (typeof value === 'number') return !Number.isNaN(value);
        return typeof value === 'string';
    }
  }

  #matchesFormat(value: string, format: FormatType): boolean {
    switch (format) {
      case 'email':
        return isValidEmail(value);
      case 'url':
        return isValidUrl(value);
      case 'iso-date':
        return isValidIsoDate(value);
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}
