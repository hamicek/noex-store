import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store } from '../../src/core/store.js';
import type { BucketDefinition, StoreRecord, DeclarativeQueryConfig } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const usersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string' },
    age: { type: 'number' },
    active: { type: 'boolean' },
  },
  indexes: ['role'],
};

// ── Helpers ──────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

async function createStore(): Promise<Store> {
  store = await Store.start({ ttlCheckIntervalMs: 0 });
  await store.defineBucket('users', usersDef);
  return store;
}

async function seedUsers(s: Store): Promise<void> {
  const b = s.bucket('users');
  await b.insert({ name: 'Alice', role: 'admin', age: 30, active: true });
  await b.insert({ name: 'Bob', role: 'user', age: 25, active: true });
  await b.insert({ name: 'Charlie', role: 'admin', age: 40, active: false });
  await b.insert({ name: 'Diana', role: 'user', age: 22, active: true });
  await b.insert({ name: 'Eve', role: 'editor', age: 35, active: true });
}

// ── Basic — just bucket ──────────────────────────────────────────

describe('declarative query: basic', () => {
  it('returns all records when only bucket is specified', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('all-users', { bucket: 'users' });
    const result = await s.runQuery<StoreRecord[]>('all-users');

    expect(result).toHaveLength(5);
  });
});

// ── Filter ───────────────────────────────────────────────────────

describe('declarative query: filter', () => {
  it('filters records by field value', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('admins', {
      bucket: 'users',
      filter: { role: 'admin' },
    });

    const result = await s.runQuery<StoreRecord[]>('admins');
    expect(result).toHaveLength(2);
    expect(result.every(r => r.role === 'admin')).toBe(true);
  });

  it('filters by multiple fields', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('active-admins', {
      bucket: 'users',
      filter: { role: 'admin', active: true },
    });

    const result = await s.runQuery<StoreRecord[]>('active-admins');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Alice');
  });

  it('returns empty array when no records match', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('ghosts', {
      bucket: 'users',
      filter: { role: 'ghost' },
    });

    const result = await s.runQuery<StoreRecord[]>('ghosts');
    expect(result).toHaveLength(0);
  });
});

// ── Sort ─────────────────────────────────────────────────────────

describe('declarative query: sort', () => {
  it('sorts ascending by string field', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('sorted-name', {
      bucket: 'users',
      sort: { name: 'asc' },
    });

    const result = await s.runQuery<StoreRecord[]>('sorted-name');
    const names = result.map(r => r.name);
    expect(names).toEqual(['Alice', 'Bob', 'Charlie', 'Diana', 'Eve']);
  });

  it('sorts descending by number field', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('sorted-age-desc', {
      bucket: 'users',
      sort: { age: 'desc' },
    });

    const result = await s.runQuery<StoreRecord[]>('sorted-age-desc');
    const ages = result.map(r => r.age);
    expect(ages).toEqual([40, 35, 30, 25, 22]);
  });

  it('sorts by multiple fields', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('sorted-role-name', {
      bucket: 'users',
      sort: { role: 'asc', name: 'asc' },
    });

    const result = await s.runQuery<StoreRecord[]>('sorted-role-name');
    const pairs = result.map(r => `${r.role as string}:${r.name as string}`);
    expect(pairs).toEqual([
      'admin:Alice',
      'admin:Charlie',
      'editor:Eve',
      'user:Bob',
      'user:Diana',
    ]);
  });
});

// ── Limit & Offset ───────────────────────────────────────────────

describe('declarative query: limit & offset', () => {
  it('limits number of results', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('top-3', {
      bucket: 'users',
      sort: { age: 'desc' },
      limit: 3,
    });

    const result = await s.runQuery<StoreRecord[]>('top-3');
    expect(result).toHaveLength(3);
    expect(result[0]!.age).toBe(40);
    expect(result[2]!.age).toBe(30);
  });

  it('offset skips records', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('page-2', {
      bucket: 'users',
      sort: { age: 'desc' },
      offset: 2,
      limit: 2,
    });

    const result = await s.runQuery<StoreRecord[]>('page-2');
    expect(result).toHaveLength(2);
    expect(result[0]!.age).toBe(30);
    expect(result[1]!.age).toBe(25);
  });

  it('offset beyond records returns empty', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('beyond', {
      bucket: 'users',
      offset: 100,
    });

    const result = await s.runQuery<StoreRecord[]>('beyond');
    expect(result).toHaveLength(0);
  });
});

// ── Projection ───────────────────────────────────────────────────

describe('declarative query: projection', () => {
  it('returns only specified fields', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('names-only', {
      bucket: 'users',
      fields: ['name', 'role'],
      sort: { name: 'asc' },
    });

    const result = await s.runQuery<StoreRecord[]>('names-only');
    expect(result).toHaveLength(5);

    for (const record of result) {
      expect(Object.keys(record).sort()).toEqual(['name', 'role']);
    }

    expect(result[0]!.name).toBe('Alice');
    expect(result[0]!.role).toBe('admin');
  });

  it('ignores fields that do not exist', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('partial', {
      bucket: 'users',
      fields: ['name', 'nonexistent'],
      sort: { name: 'asc' },
    });

    const result = await s.runQuery<StoreRecord[]>('partial');
    expect(Object.keys(result[0]!)).toEqual(['name']);
  });
});

// ── Aggregation ──────────────────────────────────────────────────

describe('declarative query: aggregation', () => {
  it('count returns number of records', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('count-admins', {
      bucket: 'users',
      filter: { role: 'admin' },
      aggregate: { function: 'count' },
    });

    const result = await s.runQuery<number>('count-admins');
    expect(result).toBe(2);
  });

  it('sum computes total', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('total-age', {
      bucket: 'users',
      aggregate: { function: 'sum', field: 'age' },
    });

    const result = await s.runQuery<number>('total-age');
    expect(result).toBe(30 + 25 + 40 + 22 + 35);
  });

  it('avg computes average', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('avg-age', {
      bucket: 'users',
      aggregate: { function: 'avg', field: 'age' },
    });

    const result = await s.runQuery<number>('avg-age');
    expect(result).toBeCloseTo((30 + 25 + 40 + 22 + 35) / 5);
  });

  it('min returns minimum value', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('min-age', {
      bucket: 'users',
      aggregate: { function: 'min', field: 'age' },
    });

    const result = await s.runQuery<number>('min-age');
    expect(result).toBe(22);
  });

  it('max returns maximum value', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('max-age', {
      bucket: 'users',
      aggregate: { function: 'max', field: 'age' },
    });

    const result = await s.runQuery<number>('max-age');
    expect(result).toBe(40);
  });

  it('count on empty result returns 0', async () => {
    const s = await createStore();

    s.defineDeclarativeQuery('count-empty', {
      bucket: 'users',
      filter: { role: 'ghost' },
      aggregate: { function: 'count' },
    });

    const result = await s.runQuery<number>('count-empty');
    expect(result).toBe(0);
  });

  it('min on empty result returns undefined', async () => {
    const s = await createStore();

    s.defineDeclarativeQuery('min-empty', {
      bucket: 'users',
      filter: { role: 'ghost' },
      aggregate: { function: 'min', field: 'age' },
    });

    const result = await s.runQuery<number | undefined>('min-empty');
    expect(result).toBeUndefined();
  });
});

// ── Parameter interpolation ──────────────────────────────────────

describe('declarative query: parameter interpolation', () => {
  it('interpolates params into filter', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('by-role', {
      bucket: 'users',
      filter: { role: '{{ params.role }}' },
      sort: { name: 'asc' },
    });

    const admins = await s.runQuery<StoreRecord[]>('by-role', { role: 'admin' });
    expect(admins).toHaveLength(2);
    expect(admins[0]!.name).toBe('Alice');

    const users = await s.runQuery<StoreRecord[]>('by-role', { role: 'user' });
    expect(users).toHaveLength(2);
    expect(users[0]!.name).toBe('Bob');
  });

  it('works with subscribe and params', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('by-role-sub', {
      bucket: 'users',
      filter: { role: '{{ params.role }}' },
    });

    const callback = vi.fn();
    await s.subscribe('by-role-sub', { role: 'admin' }, callback);

    // Insert a new admin → should trigger callback
    await s.bucket('users').insert({ name: 'Frank', role: 'admin', age: 28, active: true });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(3);
  });

  it('non-matching param values return empty', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('by-role-nomatch', {
      bucket: 'users',
      filter: { role: '{{ params.role }}' },
    });

    const result = await s.runQuery<StoreRecord[]>('by-role-nomatch', { role: 'ghost' });
    expect(result).toHaveLength(0);
  });
});

// ── Reactivity ───────────────────────────────────────────────────

describe('declarative query: reactivity', () => {
  it('re-evaluates on insert', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('all-reactive', {
      bucket: 'users',
      sort: { name: 'asc' },
    });

    const callback = vi.fn();
    await s.subscribe('all-reactive', callback);

    await s.bucket('users').insert({ name: 'Zara', role: 'user', age: 20, active: true });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    const result = callback.mock.calls[0]![0] as StoreRecord[];
    expect(result).toHaveLength(6);
    expect(result[5]!.name).toBe('Zara');
  });

  it('re-evaluates on update', async () => {
    const s = await createStore();

    const b = s.bucket('users');
    const alice = await b.insert({ name: 'Alice', role: 'admin', age: 30, active: true });

    s.defineDeclarativeQuery('admins-reactive', {
      bucket: 'users',
      filter: { role: 'admin' },
    });

    const callback = vi.fn();
    await s.subscribe('admins-reactive', callback);

    // Change Alice's role → she no longer matches
    await b.update(alice.id, { role: 'user' });
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toHaveLength(0);
  });

  it('re-evaluates on delete', async () => {
    const s = await createStore();

    const b = s.bucket('users');
    const alice = await b.insert({ name: 'Alice', role: 'admin', age: 30, active: true });
    await b.insert({ name: 'Bob', role: 'admin', age: 25, active: true });

    s.defineDeclarativeQuery('admins-del', {
      bucket: 'users',
      filter: { role: 'admin' },
    });

    const callback = vi.fn();
    await s.subscribe('admins-del', callback);

    await b.delete(alice.id);
    await s.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toHaveLength(1);
  });
});

// ── Validation ───────────────────────────────────────────────────

describe('declarative query: validation', () => {
  it('throws BucketNotDefinedError for nonexistent bucket', async () => {
    const s = await createStore();

    expect(() => {
      s.defineDeclarativeQuery('bad', { bucket: 'nonexistent' });
    }).toThrow('Bucket "nonexistent" is not defined');
  });

  it('throws QueryAlreadyDefinedError for duplicate name', async () => {
    const s = await createStore();

    s.defineDeclarativeQuery('dup', { bucket: 'users' });

    expect(() => {
      s.defineDeclarativeQuery('dup', { bucket: 'users' });
    }).toThrow('Query "dup" is already defined');
  });

  it('conflicts with programmatic query name', async () => {
    const s = await createStore();

    s.defineQuery('existing', async (ctx) => ctx.bucket('users').all());

    expect(() => {
      s.defineDeclarativeQuery('existing', { bucket: 'users' });
    }).toThrow('Query "existing" is already defined');
  });
});

// ── Combined: filter + sort + limit + projection ─────────────────

describe('declarative query: combined operations', () => {
  it('applies filter, sort, limit, and projection together', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('combined', {
      bucket: 'users',
      filter: { active: true },
      sort: { age: 'desc' },
      limit: 2,
      fields: ['name', 'age'],
    });

    const result = await s.runQuery<StoreRecord[]>('combined');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'Eve', age: 35 });
    expect(result[1]).toEqual({ name: 'Alice', age: 30 });
  });

  it('aggregation ignores sort/limit/fields', async () => {
    const s = await createStore();
    await seedUsers(s);

    s.defineDeclarativeQuery('agg-combined', {
      bucket: 'users',
      filter: { active: true },
      sort: { age: 'desc' },
      limit: 2,
      fields: ['name'],
      aggregate: { function: 'count' },
    });

    const result = await s.runQuery<number>('agg-combined');
    // count is 4 (all active users), not limited by limit: 2
    expect(result).toBe(4);
  });
});
