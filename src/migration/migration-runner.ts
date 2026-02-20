import type { Store } from '../core/store.js';
import type { BucketDefinition } from '../types/index.js';
import type { Migration, MigrationResult } from '../types/migration.js';
import { MigrationContextImpl } from './migration-context.js';

// ── Constants ───────────────────────────────────────────────────

const MIGRATIONS_BUCKET = '_migrations';

const MIGRATIONS_DEFINITION: BucketDefinition = {
  key: 'version',
  schema: {
    version: { type: 'number', required: true },
    name: { type: 'string', required: true },
    appliedAt: { type: 'number', required: true },
  },
};

// ── Public API ──────────────────────────────────────────────────

/**
 * Run pending migrations against a store.
 *
 * Migrations are sorted by version and executed sequentially.
 * Each successfully applied migration is recorded in a `_migrations` bucket
 * so that subsequent calls are idempotent.
 */
export async function runMigrations(
  store: Store,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  validateMigrations(migrations);

  // Ensure the tracking bucket exists
  if (!store.hasBucket(MIGRATIONS_BUCKET)) {
    await store.defineBucket(MIGRATIONS_BUCKET, MIGRATIONS_DEFINITION);
  }

  // Determine which versions have already been applied
  const appliedRecords = await store.bucket(MIGRATIONS_BUCKET).all();
  const appliedVersions = new Set(appliedRecords.map(r => r.version as number));

  // Sort ascending by version
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  // Execute pending migrations
  let appliedCount = 0;
  for (const migration of sorted) {
    if (appliedVersions.has(migration.version)) continue;

    const ctx = new MigrationContextImpl(store);
    await migration.up(ctx);

    await store.bucket(MIGRATIONS_BUCKET).insert({
      version: migration.version,
      name: migration.name,
      appliedAt: Date.now(),
    });

    appliedCount++;
  }

  // Compute current version
  const allApplied = await store.bucket(MIGRATIONS_BUCKET).all();
  const currentVersion = allApplied.length > 0
    ? Math.max(...allApplied.map(r => r.version as number))
    : 0;

  return { applied: appliedCount, currentVersion };
}

// ── Validation ──────────────────────────────────────────────────

function validateMigrations(migrations: readonly Migration[]): void {
  const versions = new Set<number>();

  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(
        `Migration version must be a positive integer, got ${String(m.version)}`,
      );
    }
    if (versions.has(m.version)) {
      throw new Error(`Duplicate migration version: ${m.version}`);
    }
    if (!m.name || typeof m.name !== 'string') {
      throw new Error(
        `Migration version ${m.version} must have a non-empty name`,
      );
    }
    versions.add(m.version);
  }
}
