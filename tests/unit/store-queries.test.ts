import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store, QueryNotDefinedError } from '../../src/core/store.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const usersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string' },
  },
};

// ── Helpers ──────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

// ── undefineQuery ────────────────────────────────────────────────

describe('Store.undefineQuery', () => {
  it('removes a declarative query', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    store.defineDeclarativeQuery('q', { bucket: 'users' });
    expect(store.undefineQuery('q')).toBe(true);

    // Query no longer exists
    await expect(store.runQuery('q')).rejects.toThrow(QueryNotDefinedError);
  });

  it('removes a programmatic query', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    store.defineQuery('q', async (ctx) => ctx.bucket('users').all());
    expect(store.undefineQuery('q')).toBe(true);

    await expect(store.runQuery('q')).rejects.toThrow(QueryNotDefinedError);
  });

  it('returns false for nonexistent query', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    expect(store.undefineQuery('nonexistent')).toBe(false);
  });

  it('cancels active subscriptions when query is undefined', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    store.defineDeclarativeQuery('q', { bucket: 'users' });

    const callback = vi.fn();
    await store.subscribe('q', callback);

    // Undefine → subscription should be gone
    store.undefineQuery('q');

    // Insert something — callback should NOT fire
    await store.bucket('users').insert({ name: 'Alice', role: 'admin' });
    await store.settle();

    expect(callback).not.toHaveBeenCalled();
  });

  it('allows re-defining a query after undefine', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    store.defineDeclarativeQuery('q', { bucket: 'users', filter: { role: 'admin' } });
    store.undefineQuery('q');

    // Re-define with different config
    store.defineDeclarativeQuery('q', { bucket: 'users', filter: { role: 'user' } });

    await store.bucket('users').insert({ name: 'Alice', role: 'admin' });
    await store.bucket('users').insert({ name: 'Bob', role: 'user' });

    const result = await store.runQuery<StoreRecord[]>('q');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Bob');
  });
});

// ── getQueries ───────────────────────────────────────────────────

describe('Store.getQueries', () => {
  it('returns empty array when no queries defined', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    expect(store.getQueries()).toEqual([]);
  });

  it('returns info for programmatic and declarative queries', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    store.defineQuery('prog', async (ctx) => ctx.bucket('users').all());
    store.defineDeclarativeQuery('decl', {
      bucket: 'users',
      filter: { role: 'admin' },
    });

    const queries = store.getQueries();
    expect(queries).toHaveLength(2);

    const prog = queries.find(q => q.name === 'prog')!;
    expect(prog.type).toBe('programmatic');
    expect(prog.config).toBeUndefined();
    expect(prog.activeSubscriptions).toBe(0);

    const decl = queries.find(q => q.name === 'decl')!;
    expect(decl.type).toBe('declarative');
    expect(decl.config).toEqual({ bucket: 'users', filter: { role: 'admin' } });
    expect(decl.activeSubscriptions).toBe(0);
  });

  it('reflects active subscriptions count', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    store.defineDeclarativeQuery('q', { bucket: 'users' });

    const unsub1 = await store.subscribe('q', () => {});
    const unsub2 = await store.subscribe('q', () => {});

    let queries = store.getQueries();
    expect(queries[0]!.activeSubscriptions).toBe(2);

    unsub1();

    queries = store.getQueries();
    expect(queries[0]!.activeSubscriptions).toBe(1);

    unsub2();

    queries = store.getQueries();
    expect(queries[0]!.activeSubscriptions).toBe(0);
  });

  it('excludes undefined queries', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    store.defineDeclarativeQuery('q1', { bucket: 'users' });
    store.defineDeclarativeQuery('q2', { bucket: 'users' });

    store.undefineQuery('q1');

    const queries = store.getQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]!.name).toBe('q2');
  });
});

// ── getQueryInfo ─────────────────────────────────────────────────

describe('Store.getQueryInfo', () => {
  it('returns undefined for nonexistent query', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    expect(store.getQueryInfo('nonexistent')).toBeUndefined();
  });

  it('returns info for declarative query', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    const config = { bucket: 'users', filter: { role: 'admin' }, sort: { name: 'asc' as const } };
    store.defineDeclarativeQuery('q', config);

    const info = store.getQueryInfo('q')!;
    expect(info.name).toBe('q');
    expect(info.type).toBe('declarative');
    expect(info.config).toEqual(config);
    expect(info.activeSubscriptions).toBe(0);
  });

  it('returns info for programmatic query', async () => {
    store = await Store.start({ ttlCheckIntervalMs: 0 });
    await store.defineBucket('users', usersDef);

    store.defineQuery('q', async (ctx) => ctx.bucket('users').all());

    const info = store.getQueryInfo('q')!;
    expect(info.name).toBe('q');
    expect(info.type).toBe('programmatic');
    expect(info.config).toBeUndefined();
  });
});
