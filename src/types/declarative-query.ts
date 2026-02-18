// ── Declarative Query Config ──────────────────────────────────────

export interface DeclarativeQueryConfig {
  /** Bucket to query. */
  readonly bucket: string;

  /** Filter records (passed to bucket.where()). Values may contain `{{ params.x }}` for interpolation. */
  readonly filter?: Readonly<Record<string, unknown>>;

  /** Sort order. Keys are field names, values are 'asc' or 'desc'. */
  readonly sort?: Readonly<Record<string, 'asc' | 'desc'>>;

  /** Maximum number of records to return. */
  readonly limit?: number;

  /** Number of records to skip (applied before limit). */
  readonly offset?: number;

  /** Project only these fields from each record. */
  readonly fields?: readonly string[];

  /** Return an aggregate instead of record list. */
  readonly aggregate?: {
    readonly function: 'count' | 'sum' | 'avg' | 'min' | 'max';
    /** Required for sum/avg/min/max. */
    readonly field?: string;
  };
}

// ── Query Info ───────────────────────────────────────────────────

export type QueryType = 'programmatic' | 'declarative';

export interface QueryInfo {
  readonly name: string;
  readonly type: QueryType;
  /** Present only for declarative queries. */
  readonly config?: DeclarativeQueryConfig;
  readonly activeSubscriptions: number;
}
