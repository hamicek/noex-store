import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store, BucketNotDefinedError } from '../../src/core/store.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const cacheDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
};

const sessionsDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
  },
};

// ── Helpers ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

// ── TTL expirace ────────────────────────────────────────────────

describe('TTL lifecycle', () => {
  it('insert with TTL → purgeTtl → expired record removed', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('cache', { ...cacheDef, ttl: 100 });

    const record = await store.bucket('cache').insert({ name: 'temp' });
    expect(record._expiresAt).toBeDefined();
    expect(record._expiresAt).toBe(record._createdAt + 100);

    await sleep(150);

    const purged = await store.purgeTtl();
    expect(purged).toBe(1);
    expect(await store.bucket('cache').get(record.id)).toBeUndefined();
  });

  it('non-expired records survive purgeTtl', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('cache', { ...cacheDef, ttl: 10_000 });

    const record = await store.bucket('cache').insert({ name: 'fresh' });

    const purged = await store.purgeTtl();
    expect(purged).toBe(0);
    expect(await store.bucket('cache').get(record.id)).toBeDefined();
  });

  it('per-record _expiresAt override is respected', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    // Bucket TTL is 1 hour, but we override per-record to 50ms
    await store.defineBucket('cache', { ...cacheDef, ttl: '1h' });

    const longLived = await store.bucket('cache').insert({ name: 'long' });
    const shortLived = await store.bucket('cache').insert({
      name: 'short',
      _expiresAt: Date.now() + 50,
    });

    expect(longLived._expiresAt).toBe(longLived._createdAt + 3_600_000);

    await sleep(100);

    const purged = await store.purgeTtl();
    expect(purged).toBe(1);
    expect(await store.bucket('cache').get(longLived.id)).toBeDefined();
    expect(await store.bucket('cache').get(shortLived.id)).toBeUndefined();
  });

  it('TTL expiration triggers reactive query re-evaluation', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('cache', { ...cacheDef, ttl: 100 });

    store.defineQuery('allCache', async (ctx) =>
      ctx.bucket('cache').all(),
    );

    const snapshots: StoreRecord[][] = [];
    await store.subscribe('allCache', (result: StoreRecord[]) => {
      snapshots.push(result);
    });

    await store.bucket('cache').insert({ name: 'will-expire' });
    await store.settle();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toHaveLength(1);

    await sleep(150);
    await store.purgeTtl();
    await store.settle();

    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toHaveLength(0);
  });

  it('TTL string format sets correct _expiresAt', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('sessions', { ...sessionsDef, ttl: '1h' });

    const record = await store.bucket('sessions').insert({ userId: 'u1' });
    expect(record._expiresAt).toBe(record._createdAt + 3_600_000);
  });

  it('bucket without TTL — records have no _expiresAt', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('cache', cacheDef);

    const record = await store.bucket('cache').insert({ name: 'no-ttl' });
    expect((record as Record<string, unknown>)._expiresAt).toBeUndefined();
  });

  it('purgeTtl on bucket with no expired records returns 0', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('cache', { ...cacheDef, ttl: '1h' });

    await store.bucket('cache').insert({ name: 'alive' });
    await store.bucket('cache').insert({ name: 'also-alive' });

    const purged = await store.purgeTtl();
    expect(purged).toBe(0);
  });

  it('mixed expired and non-expired — only expired are purged', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('cache', { ...cacheDef, ttl: '1h' });

    const alive = await store.bucket('cache').insert({ name: 'alive' });
    const expiring1 = await store.bucket('cache').insert({
      name: 'expiring-1',
      _expiresAt: Date.now() + 50,
    });
    const expiring2 = await store.bucket('cache').insert({
      name: 'expiring-2',
      _expiresAt: Date.now() + 50,
    });

    await sleep(100);

    const purged = await store.purgeTtl();
    expect(purged).toBe(2);
    expect(await store.bucket('cache').get(alive.id)).toBeDefined();
    expect(await store.bucket('cache').get(expiring1.id)).toBeUndefined();
    expect(await store.bucket('cache').get(expiring2.id)).toBeUndefined();
  });
});

// ── maxSize eviction ─────────────────────────────────────────────

describe('maxSize lifecycle', () => {
  it('insert beyond maxSize evicts oldest record', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('lru', { ...cacheDef, maxSize: 3 });

    const r1 = await store.bucket('lru').insert({ name: 'first' });
    const r2 = await store.bucket('lru').insert({ name: 'second' });
    const r3 = await store.bucket('lru').insert({ name: 'third' });

    expect(await store.bucket('lru').count()).toBe(3);

    const r4 = await store.bucket('lru').insert({ name: 'fourth' });

    expect(await store.bucket('lru').count()).toBe(3);
    expect(await store.bucket('lru').get(r1.id)).toBeUndefined();
    expect(await store.bucket('lru').get(r2.id)).toBeDefined();
    expect(await store.bucket('lru').get(r3.id)).toBeDefined();
    expect(await store.bucket('lru').get(r4.id)).toBeDefined();
  });

  it('insert under maxSize does not evict', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('lru', { ...cacheDef, maxSize: 5 });

    const r1 = await store.bucket('lru').insert({ name: 'a' });
    const r2 = await store.bucket('lru').insert({ name: 'b' });
    const r3 = await store.bucket('lru').insert({ name: 'c' });

    expect(await store.bucket('lru').count()).toBe(3);
    expect(await store.bucket('lru').get(r1.id)).toBeDefined();
    expect(await store.bucket('lru').get(r2.id)).toBeDefined();
    expect(await store.bucket('lru').get(r3.id)).toBeDefined();
  });

  it('maxSize: 1 — only the latest record survives', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('single', { ...cacheDef, maxSize: 1 });

    const r1 = await store.bucket('single').insert({ name: 'first' });
    expect(await store.bucket('single').count()).toBe(1);

    const r2 = await store.bucket('single').insert({ name: 'second' });
    expect(await store.bucket('single').count()).toBe(1);
    expect(await store.bucket('single').get(r1.id)).toBeUndefined();
    expect(await store.bucket('single').get(r2.id)).toBeDefined();

    const r3 = await store.bucket('single').insert({ name: 'third' });
    expect(await store.bucket('single').count()).toBe(1);
    expect(await store.bucket('single').get(r2.id)).toBeUndefined();
    expect(await store.bucket('single').get(r3.id)).toBeDefined();
  });

  it('maxSize eviction triggers reactive query update', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('lru', { ...cacheDef, maxSize: 2 });

    store.defineQuery('allLru', async (ctx) =>
      ctx.bucket('lru').all(),
    );

    const snapshots: StoreRecord[][] = [];
    await store.subscribe('allLru', (result: StoreRecord[]) => {
      snapshots.push(result);
    });

    await store.bucket('lru').insert({ name: 'a' });
    await store.settle();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toHaveLength(1);

    await store.bucket('lru').insert({ name: 'b' });
    await store.settle();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toHaveLength(2);

    // This insert evicts 'a' and adds 'c' — still 2 records but different content
    await store.bucket('lru').insert({ name: 'c' });
    await store.settle();
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]).toHaveLength(2);

    const names = snapshots[2]!.map((r) => r.name);
    expect(names).toContain('b');
    expect(names).toContain('c');
    expect(names).not.toContain('a');
  });

  it('maxSize eviction emits deleted events', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('lru', { ...cacheDef, maxSize: 2 });

    const deletedEvents: unknown[] = [];
    await store.on('bucket.lru.deleted', (event) => {
      deletedEvents.push(event);
    });

    await store.bucket('lru').insert({ name: 'a' });
    await store.bucket('lru').insert({ name: 'b' });

    // This should evict 'a'
    await store.bucket('lru').insert({ name: 'c' });
    await store.settle();

    expect(deletedEvents).toHaveLength(1);
    expect((deletedEvents[0] as Record<string, unknown>).type).toBe('deleted');
  });
});

// ── TTL + maxSize kombinace ──────────────────────────────────────

describe('TTL + maxSize combined', () => {
  it('TTL and maxSize work together', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('combo', { ...cacheDef, ttl: 100, maxSize: 3 });

    // Fill up to maxSize
    const r1 = await store.bucket('combo').insert({ name: 'a' });
    const r2 = await store.bucket('combo').insert({ name: 'b' });
    const r3 = await store.bucket('combo').insert({ name: 'c' });

    // Insert beyond maxSize → evict oldest
    const r4 = await store.bucket('combo').insert({ name: 'd' });
    expect(await store.bucket('combo').count()).toBe(3);
    expect(await store.bucket('combo').get(r1.id)).toBeUndefined();

    // Wait for TTL to expire on remaining records
    await sleep(150);
    const purged = await store.purgeTtl();
    expect(purged).toBe(3);
    expect(await store.bucket('combo').count()).toBe(0);
  });
});

// ── dropBucket ───────────────────────────────────────────────────

describe('dropBucket', () => {
  it('removes a bucket — accessing it afterwards throws', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('temp', {
      key: 'id',
      schema: { id: { type: 'string', generated: 'uuid' } },
    });

    await store.bucket('temp').insert({});
    await store.dropBucket('temp');

    expect(() => store.bucket('temp')).toThrow(BucketNotDefinedError);
  });

  it('throws BucketNotDefinedError for non-existent bucket', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });

    await expect(store.dropBucket('nonexistent')).rejects.toThrow(BucketNotDefinedError);
  });

  it('bucket can be re-defined after drop — starts empty', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('reusable', cacheDef);

    await store.bucket('reusable').insert({ name: 'v1' });
    expect(await store.bucket('reusable').count()).toBe(1);

    await store.dropBucket('reusable');

    // Re-define
    await store.defineBucket('reusable', cacheDef);
    expect(await store.bucket('reusable').count()).toBe(0);
  });

  it('dropping a TTL-enabled bucket unregisters from TtlManager', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('ttl-temp', { ...cacheDef, ttl: 100 });

    await store.bucket('ttl-temp').insert({ name: 'will-be-dropped' });
    await store.dropBucket('ttl-temp');

    // purgeTtl should not fail — bucket is unregistered
    const purged = await store.purgeTtl();
    expect(purged).toBe(0);
  });

  it('dropping a bucket does not affect other buckets', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('keep', cacheDef);
    await store.defineBucket('drop', {
      key: 'id',
      schema: { id: { type: 'string', generated: 'uuid' } },
    });

    const kept = await store.bucket('keep').insert({ name: 'safe' });
    await store.bucket('drop').insert({});

    await store.dropBucket('drop');

    expect(await store.bucket('keep').get(kept.id)).toBeDefined();
    expect(await store.bucket('keep').count()).toBe(1);
  });
});
