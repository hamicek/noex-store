export interface RecordMeta {
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

export type StoreRecord<T = Record<string, unknown>> = T & RecordMeta;
