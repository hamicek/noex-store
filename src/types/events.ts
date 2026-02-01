import type { StoreRecord } from './record.js';

export type BucketEventType = 'inserted' | 'updated' | 'deleted';

export interface BucketInsertedEvent {
  readonly type: 'inserted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord;
}

export interface BucketUpdatedEvent {
  readonly type: 'updated';
  readonly bucket: string;
  readonly key: unknown;
  readonly oldRecord: StoreRecord;
  readonly newRecord: StoreRecord;
}

export interface BucketDeletedEvent {
  readonly type: 'deleted';
  readonly bucket: string;
  readonly key: unknown;
  readonly record: StoreRecord;
}

export type BucketEvent = BucketInsertedEvent | BucketUpdatedEvent | BucketDeletedEvent;
