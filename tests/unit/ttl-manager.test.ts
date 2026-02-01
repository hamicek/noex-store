import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, EventBus, type EventBusRef } from '@hamicek/noex';
import { TtlManager } from '../../src/lifecycle/ttl-manager.js';
import {
  createBucketBehavior,
  type BucketRef,
} from '../../src/core/bucket-server.js';
import type { BucketDefinition, StoreRecord } from '../../src/types/index.js';

// ── Helpers ──────────────────────────────────────────────────────

const ttlDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
  ttl: 50, // 50ms TTL for fast test expiration
};

const noTtlDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

let eventBusRef: EventBusRef;
const activeRefs: BucketRef[] = [];

async function startBucket(
  bucketName: string,
  definition: BucketDefinition,
): Promise<BucketRef> {
  const behavior = createBucketBehavior(bucketName, definition, eventBusRef);
  const ref = await GenServer.start(behavior) as BucketRef;
  activeRefs.push(ref);
  return ref;
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(async () => {
  eventBusRef = await EventBus.start();
});

afterEach(async () => {
  for (const ref of activeRefs) {
    if (GenServer.isRunning(ref)) {
      await GenServer.stop(ref);
    }
  }
  activeRefs.length = 0;

  if (EventBus.isRunning(eventBusRef)) {
    await EventBus.stop(eventBusRef);
  }
});

// ── Registration ─────────────────────────────────────────────────

describe('TtlManager registration', () => {
  it('starts with zero buckets', () => {
    const manager = new TtlManager();
    expect(manager.bucketCount).toBe(0);
  });

  it('increments bucketCount on registerBucket', async () => {
    const manager = new TtlManager();
    const ref = await startBucket('a', ttlDef);

    manager.registerBucket('a', ref, 5000);
    expect(manager.bucketCount).toBe(1);
  });

  it('decrements bucketCount on unregisterBucket', async () => {
    const manager = new TtlManager();
    const ref = await startBucket('a', ttlDef);

    manager.registerBucket('a', ref, 5000);
    manager.unregisterBucket('a');
    expect(manager.bucketCount).toBe(0);
  });

  it('unregisterBucket for unknown name is a no-op', () => {
    const manager = new TtlManager();
    expect(() => manager.unregisterBucket('nonexistent')).not.toThrow();
    expect(manager.bucketCount).toBe(0);
  });

  it('overwrites existing entry on duplicate registerBucket', async () => {
    const manager = new TtlManager();
    const ref1 = await startBucket('a', ttlDef);
    const ref2 = await startBucket('b', ttlDef);

    manager.registerBucket('x', ref1, 1000);
    manager.registerBucket('x', ref2, 2000);
    expect(manager.bucketCount).toBe(1);
  });
});

// ── purge() ──────────────────────────────────────────────────────

describe('TtlManager purge', () => {
  it('returns 0 when no buckets registered', async () => {
    const manager = new TtlManager();
    const purged = await manager.purge();
    expect(purged).toBe(0);
  });

  it('purges expired records from registered buckets', async () => {
    const manager = new TtlManager();
    const ref = await startBucket('cache', ttlDef);
    manager.registerBucket('cache', ref, 50);

    await GenServer.call(ref, { type: 'insert', data: { name: 'Temp' } });

    await delay(80);
    const purged = await manager.purge();
    expect(purged).toBe(1);

    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(0);
  });

  it('returns total purged across multiple buckets', async () => {
    const manager = new TtlManager();
    const refA = await startBucket('a', ttlDef);
    const refB = await startBucket('b', ttlDef);
    manager.registerBucket('a', refA, 50);
    manager.registerBucket('b', refB, 50);

    await GenServer.call(refA, { type: 'insert', data: { name: 'A1' } });
    await GenServer.call(refB, { type: 'insert', data: { name: 'B1' } });
    await GenServer.call(refB, { type: 'insert', data: { name: 'B2' } });

    await delay(80);
    const purged = await manager.purge();
    expect(purged).toBe(3);
  });

  it('skips stopped bucket without throwing', async () => {
    const manager = new TtlManager();
    const ref = await startBucket('stopped', ttlDef);
    manager.registerBucket('stopped', ref, 50);

    await GenServer.call(ref, { type: 'insert', data: { name: 'Will stop' } });
    await GenServer.stop(ref);

    const purged = await manager.purge();
    expect(purged).toBe(0);
  });

  it('does not purge non-expired records', async () => {
    const manager = new TtlManager();
    const longTtlDef: BucketDefinition = { ...ttlDef, ttl: 60_000 };
    const ref = await startBucket('long', longTtlDef);
    manager.registerBucket('long', ref, 60_000);

    await GenServer.call(ref, { type: 'insert', data: { name: 'Fresh' } });

    const purged = await manager.purge();
    expect(purged).toBe(0);

    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(1);
  });

  it('handles unregisterBucket between purge calls gracefully', async () => {
    const manager = new TtlManager();
    const ref = await startBucket('temp', ttlDef);
    manager.registerBucket('temp', ref, 50);

    await GenServer.call(ref, { type: 'insert', data: { name: 'X' } });
    manager.unregisterBucket('temp');

    await delay(80);
    const purged = await manager.purge();
    expect(purged).toBe(0);
  });
});

// ── start / stop lifecycle ───────────────────────────────────────

describe('TtlManager lifecycle', () => {
  it('automatic purge runs after start()', async () => {
    const manager = new TtlManager(30); // 30ms interval
    const ref = await startBucket('auto', ttlDef);
    manager.registerBucket('auto', ref, 50);

    await GenServer.call(ref, { type: 'insert', data: { name: 'Auto' } });

    manager.start();
    // Wait for TTL expiration + at least one tick
    await delay(150);
    manager.stop();

    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(0);
  });

  it('stop() prevents further ticks', async () => {
    const manager = new TtlManager(20);
    const ref = await startBucket('stop-test', ttlDef);
    manager.registerBucket('stop-test', ref, 50);

    manager.start();
    manager.stop();

    // Insert after stop — should not be purged automatically
    await GenServer.call(ref, { type: 'insert', data: { name: 'After stop' } });
    await delay(100);

    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(1);
  });

  it('stop() is idempotent', () => {
    const manager = new TtlManager();
    manager.start();
    expect(() => {
      manager.stop();
      manager.stop();
      manager.stop();
    }).not.toThrow();
  });

  it('start() is idempotent — no duplicate timers', async () => {
    const manager = new TtlManager(20);
    const ref = await startBucket('idem', ttlDef);
    manager.registerBucket('idem', ref, 50);

    manager.start();
    manager.start();
    manager.start();

    await GenServer.call(ref, { type: 'insert', data: { name: 'X' } });
    await delay(100);
    manager.stop();

    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(0);
  });

  it('can restart after stop', async () => {
    const manager = new TtlManager(20);
    const ref = await startBucket('restart', ttlDef);
    manager.registerBucket('restart', ref, 50);

    manager.start();
    manager.stop();

    await GenServer.call(ref, { type: 'insert', data: { name: 'Restarted' } });

    manager.start();
    await delay(150);
    manager.stop();

    const count = await GenServer.call(ref, { type: 'count' });
    expect(count).toBe(0);
  });
});
