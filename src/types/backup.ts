export interface BackupInfo {
  /** Unique identifier (same as name). */
  readonly id: string;
  /** User-provided or auto-generated name. */
  readonly name: string;
  /** Unix timestamp (ms) when the backup was created. */
  readonly createdAt: number;
  /** Names of buckets included in the backup. */
  readonly bucketNames: readonly string[];
  /** Total number of records across all backed-up buckets. */
  readonly totalRecords: number;
}
