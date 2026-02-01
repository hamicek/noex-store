export interface RecordMeta {
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
  /** Unix ms timestamp when this record expires. Only set for TTL-enabled buckets. */
  readonly _expiresAt?: number;
}

export type StoreRecord<T = Record<string, unknown>> = T & RecordMeta;
