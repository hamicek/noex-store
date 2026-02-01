import { describe, it, expect, vi } from 'vitest';
import { bridgeStoreToRules, type EventReceiver, type BridgeOptions } from '../../src/bridge/rules-bridge.js';
import type { Store } from '../../src/core/store.js';
import type { BucketEvent, BucketInsertedEvent, BucketUpdatedEvent, BucketDeletedEvent } from '../../src/types/events.js';

// ── Helpers ──────────────────────────────────────────────────────

type BucketEventHandler = (event: BucketEvent, topic: string) => void;

function createMockStore() {
  let handler: BucketEventHandler | undefined;
  let unsubCalled = false;

  const store = {
    on: vi.fn(async (_pattern: string, h: BucketEventHandler) => {
      handler = h;
      return async () => {
        unsubCalled = true;
        handler = undefined;
      };
    }),
  } as unknown as Store;

  return {
    store,
    emit(event: BucketEvent, topic: string) {
      handler?.(event, topic);
    },
    get unsubCalled() {
      return unsubCalled;
    },
  };
}

function createMockReceiver(): EventReceiver & {
  readonly calls: ReadonlyArray<{ topic: string; data: Record<string, unknown> }>;
} {
  const calls: Array<{ topic: string; data: Record<string, unknown> }> = [];
  return {
    calls,
    emit: vi.fn(async (topic: string, data: Record<string, unknown>) => {
      calls.push({ topic, data });
    }),
  };
}

const insertedEvent: BucketInsertedEvent = {
  type: 'inserted',
  bucket: 'customers',
  key: '1',
  record: { id: '1', name: 'Jan', _version: 1, _createdAt: 1000, _updatedAt: 1000 },
};

const updatedEvent: BucketUpdatedEvent = {
  type: 'updated',
  bucket: 'customers',
  key: '1',
  oldRecord: { id: '1', name: 'Jan', _version: 1, _createdAt: 1000, _updatedAt: 1000 },
  newRecord: { id: '1', name: 'Eva', _version: 2, _createdAt: 1000, _updatedAt: 2000 },
};

const deletedEvent: BucketDeletedEvent = {
  type: 'deleted',
  bucket: 'orders',
  key: 'o-42',
  record: { id: 'o-42', total: 100, _version: 1, _createdAt: 1000, _updatedAt: 1000 },
};

// ── Tests ────────────────────────────────────────────────────────

describe('bridgeStoreToRules', () => {
  it('subscribes to bucket.*.* pattern', async () => {
    const { store } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver);

    expect(store.on).toHaveBeenCalledWith('bucket.*.*', expect.any(Function));
  });

  it('forwards bucket events to receiver with topic as-is', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver);

    emit(insertedEvent, 'bucket.customers.inserted');

    // Wait for fire-and-forget promise
    await vi.waitFor(() => {
      expect(receiver.calls).toHaveLength(1);
    });

    expect(receiver.calls[0]!.topic).toBe('bucket.customers.inserted');
    expect(receiver.calls[0]!.data).toEqual(insertedEvent as unknown as Record<string, unknown>);
  });

  it('forwards updated events', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver);

    emit(updatedEvent, 'bucket.customers.updated');

    await vi.waitFor(() => {
      expect(receiver.calls).toHaveLength(1);
    });

    expect(receiver.calls[0]!.topic).toBe('bucket.customers.updated');
    expect(receiver.calls[0]!.data).toEqual(updatedEvent as unknown as Record<string, unknown>);
  });

  it('forwards deleted events', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver);

    emit(deletedEvent, 'bucket.orders.deleted');

    await vi.waitFor(() => {
      expect(receiver.calls).toHaveLength(1);
    });

    expect(receiver.calls[0]!.topic).toBe('bucket.orders.deleted');
  });

  it('filters out events when filter returns false', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver, {
      filter: () => false,
    });

    emit(insertedEvent, 'bucket.customers.inserted');

    // Give it a tick to ensure nothing arrives
    await new Promise((r) => setTimeout(r, 10));
    expect(receiver.calls).toHaveLength(0);
    expect(receiver.emit).not.toHaveBeenCalled();
  });

  it('passes through events when filter returns true', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver, {
      filter: (e) => e.bucket === 'customers',
    });

    emit(insertedEvent, 'bucket.customers.inserted');

    await vi.waitFor(() => {
      expect(receiver.calls).toHaveLength(1);
    });

    expect(receiver.calls[0]!.topic).toBe('bucket.customers.inserted');
  });

  it('applies selective filter — only matching bucket', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver, {
      filter: (e) => e.bucket === 'vip',
    });

    emit(insertedEvent, 'bucket.customers.inserted');
    emit(deletedEvent, 'bucket.orders.deleted');

    await new Promise((r) => setTimeout(r, 10));
    expect(receiver.calls).toHaveLength(0);
  });

  it('transforms topic with custom mapTopic', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver, {
      mapTopic: (topic) => topic.replaceAll('.', ':'),
    });

    emit(insertedEvent, 'bucket.customers.inserted');

    await vi.waitFor(() => {
      expect(receiver.calls).toHaveLength(1);
    });

    expect(receiver.calls[0]!.topic).toBe('bucket:customers:inserted');
  });

  it('transforms data with custom mapData', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver, {
      mapData: (event) => ({
        bucket: event.bucket,
        eventType: event.type,
      }),
    });

    emit(insertedEvent, 'bucket.customers.inserted');

    await vi.waitFor(() => {
      expect(receiver.calls).toHaveLength(1);
    });

    expect(receiver.calls[0]!.data).toEqual({ bucket: 'customers', eventType: 'inserted' });
  });

  it('does not propagate receiver errors', async () => {
    const { store, emit } = createMockStore();

    const receiver: EventReceiver = {
      emit: vi.fn(async () => {
        throw new Error('receiver boom');
      }),
    };

    await bridgeStoreToRules(store, receiver);

    // Should not throw
    expect(() => emit(insertedEvent, 'bucket.customers.inserted')).not.toThrow();

    // Give the rejected promise a tick to settle
    await new Promise((r) => setTimeout(r, 10));
  });

  it('stops forwarding after unsub is called', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    const unsub = await bridgeStoreToRules(store, receiver);

    emit(insertedEvent, 'bucket.customers.inserted');
    await vi.waitFor(() => {
      expect(receiver.calls).toHaveLength(1);
    });

    await unsub();

    emit(updatedEvent, 'bucket.customers.updated');

    await new Promise((r) => setTimeout(r, 10));
    expect(receiver.calls).toHaveLength(1); // No new events
  });

  it('forwards multiple events in order', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    await bridgeStoreToRules(store, receiver);

    emit(insertedEvent, 'bucket.customers.inserted');
    emit(updatedEvent, 'bucket.customers.updated');
    emit(deletedEvent, 'bucket.orders.deleted');

    await vi.waitFor(() => {
      expect(receiver.calls).toHaveLength(3);
    });

    expect(receiver.calls[0]!.topic).toBe('bucket.customers.inserted');
    expect(receiver.calls[1]!.topic).toBe('bucket.customers.updated');
    expect(receiver.calls[2]!.topic).toBe('bucket.orders.deleted');
  });

  it('combines filter with mapTopic and mapData', async () => {
    const { store, emit } = createMockStore();
    const receiver = createMockReceiver();

    const options: BridgeOptions = {
      filter: (e) => e.type === 'inserted',
      mapTopic: (topic) => topic.replaceAll('.', '/'),
      mapData: (e) => ({ key: e.key }),
    };

    await bridgeStoreToRules(store, receiver, options);

    emit(insertedEvent, 'bucket.customers.inserted');
    emit(updatedEvent, 'bucket.customers.updated'); // filtered out

    await vi.waitFor(() => {
      expect(receiver.calls).toHaveLength(1);
    });

    // Wait a tick to confirm the updated event was really filtered
    await new Promise((r) => setTimeout(r, 10));
    expect(receiver.calls).toHaveLength(1);
    expect(receiver.calls[0]!.topic).toBe('bucket/customers/inserted');
    expect(receiver.calls[0]!.data).toEqual({ key: '1' });
  });
});
