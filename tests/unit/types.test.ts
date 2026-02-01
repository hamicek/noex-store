import { describe, it, expect } from 'vitest';
import type {
  FieldType,
  GeneratedType,
  FormatType,
  EtsTableType,
  FieldDefinition,
  SchemaDefinition,
  BucketDefinition,
  RecordMeta,
  StoreRecord,
  BucketEventType,
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
  BucketEvent,
} from '../../src/types/index.js';

describe('types', () => {
  describe('schema types', () => {
    it('FieldDefinition accepts valid field configurations', () => {
      const stringField: FieldDefinition = {
        type: 'string',
        required: true,
        minLength: 1,
        maxLength: 255,
      };
      expect(stringField.type).toBe('string');
      expect(stringField.required).toBe(true);

      const generatedField: FieldDefinition = {
        type: 'string',
        generated: 'uuid',
      };
      expect(generatedField.generated).toBe('uuid');

      const enumField: FieldDefinition = {
        type: 'string',
        enum: ['active', 'inactive'] as const,
      };
      expect(enumField.enum).toEqual(['active', 'inactive']);

      const formattedField: FieldDefinition = {
        type: 'string',
        format: 'email',
      };
      expect(formattedField.format).toBe('email');

      const numberField: FieldDefinition = {
        type: 'number',
        min: 0,
        max: 100,
      };
      expect(numberField.min).toBe(0);
      expect(numberField.max).toBe(100);

      const patternField: FieldDefinition = {
        type: 'string',
        pattern: '^[A-Z]+$',
      };
      expect(patternField.pattern).toBe('^[A-Z]+$');

      const refField: FieldDefinition = {
        type: 'string',
        ref: 'users',
        unique: true,
      };
      expect(refField.ref).toBe('users');
      expect(refField.unique).toBe(true);

      const defaultField: FieldDefinition = {
        type: 'string',
        default: 'hello',
      };
      expect(defaultField.default).toBe('hello');

      const defaultFnField: FieldDefinition = {
        type: 'date',
        default: () => Date.now(),
      };
      expect(typeof defaultFnField.default).toBe('function');
    });

    it('SchemaDefinition is a readonly record of FieldDefinition', () => {
      const schema: SchemaDefinition = {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true, minLength: 1 },
        age: { type: 'number', min: 0 },
        active: { type: 'boolean', default: true },
        tags: { type: 'array' },
        meta: { type: 'object' },
        createdAt: { type: 'date', generated: 'timestamp' },
      };
      expect(Object.keys(schema)).toHaveLength(7);
    });

    it('BucketDefinition accepts valid configurations', () => {
      const bucket: BucketDefinition = {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      };
      expect(bucket.key).toBe('id');

      const bucketWithIndexes: BucketDefinition = {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          email: { type: 'string', format: 'email', unique: true },
        },
        indexes: ['email'],
        etsType: 'set',
      };
      expect(bucketWithIndexes.indexes).toEqual(['email']);
      expect(bucketWithIndexes.etsType).toBe('set');
    });
  });

  describe('record types', () => {
    it('StoreRecord merges data with RecordMeta', () => {
      const record: StoreRecord<{ id: string; name: string }> = {
        id: 'abc',
        name: 'Test',
        _version: 1,
        _createdAt: 1000,
        _updatedAt: 1000,
      };
      expect(record.id).toBe('abc');
      expect(record.name).toBe('Test');
      expect(record._version).toBe(1);
      expect(record._createdAt).toBe(1000);
      expect(record._updatedAt).toBe(1000);
    });

    it('StoreRecord defaults to Record<string, unknown>', () => {
      const record: StoreRecord = {
        foo: 'bar',
        _version: 2,
        _createdAt: 1000,
        _updatedAt: 2000,
      };
      expect(record.foo).toBe('bar');
      expect(record._version).toBe(2);
    });
  });

  describe('event types', () => {
    it('BucketInsertedEvent has correct shape', () => {
      const event: BucketInsertedEvent = {
        type: 'inserted',
        bucket: 'users',
        key: 'abc',
        record: { id: 'abc', _version: 1, _createdAt: 1000, _updatedAt: 1000 },
      };
      expect(event.type).toBe('inserted');
      expect(event.bucket).toBe('users');
    });

    it('BucketUpdatedEvent has correct shape', () => {
      const event: BucketUpdatedEvent = {
        type: 'updated',
        bucket: 'users',
        key: 'abc',
        oldRecord: { id: 'abc', name: 'Old', _version: 1, _createdAt: 1000, _updatedAt: 1000 },
        newRecord: { id: 'abc', name: 'New', _version: 2, _createdAt: 1000, _updatedAt: 2000 },
      };
      expect(event.type).toBe('updated');
      expect(event.oldRecord).not.toEqual(event.newRecord);
    });

    it('BucketDeletedEvent has correct shape', () => {
      const event: BucketDeletedEvent = {
        type: 'deleted',
        bucket: 'users',
        key: 'abc',
        record: { id: 'abc', _version: 2, _createdAt: 1000, _updatedAt: 2000 },
      };
      expect(event.type).toBe('deleted');
    });

    it('BucketEvent discriminated union narrows correctly', () => {
      const event: BucketEvent = {
        type: 'inserted',
        bucket: 'orders',
        key: 1,
        record: { _version: 1, _createdAt: 1000, _updatedAt: 1000 },
      };

      switch (event.type) {
        case 'inserted':
          expect(event.record).toBeDefined();
          break;
        case 'updated':
          expect(event.oldRecord).toBeDefined();
          expect(event.newRecord).toBeDefined();
          break;
        case 'deleted':
          expect(event.record).toBeDefined();
          break;
      }
    });
  });

  describe('type literal values', () => {
    it('FieldType covers all expected values', () => {
      const types: FieldType[] = ['string', 'number', 'boolean', 'object', 'array', 'date'];
      expect(types).toHaveLength(6);
    });

    it('GeneratedType covers all expected values', () => {
      const types: GeneratedType[] = ['uuid', 'cuid', 'autoincrement', 'timestamp'];
      expect(types).toHaveLength(4);
    });

    it('FormatType covers all expected values', () => {
      const types: FormatType[] = ['email', 'url', 'iso-date'];
      expect(types).toHaveLength(3);
    });

    it('EtsTableType covers all expected values', () => {
      const types: EtsTableType[] = ['set', 'ordered_set', 'bag', 'duplicate_bag'];
      expect(types).toHaveLength(4);
    });

    it('BucketEventType covers all expected values', () => {
      const types: BucketEventType[] = ['inserted', 'updated', 'deleted'];
      expect(types).toHaveLength(3);
    });
  });
});
