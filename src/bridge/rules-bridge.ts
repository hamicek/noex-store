import type { Store } from '../core/store.js';
import type { BucketEvent } from '../types/events.js';

/**
 * Minimal interface matching `RuleEngine.emit()`.
 * Avoids hard dependency on `@hamicek/noex-rules`.
 */
export interface EventReceiver {
  emit(topic: string, data: Record<string, unknown>): Promise<unknown>;
}

export interface BridgeOptions {
  /** Filter which bucket events to forward. If omitted, all events pass through. */
  readonly filter?: (event: BucketEvent) => boolean;

  /** Transform the EventBus topic before forwarding. Default: identity. */
  readonly mapTopic?: (topic: string, event: BucketEvent) => string;

  /** Transform the event data before forwarding. Default: pass BucketEvent as-is. */
  readonly mapData?: (event: BucketEvent) => Record<string, unknown>;
}

/**
 * Bridge noex-store bucket events to an external event receiver
 * (typically a noex-rules RuleEngine).
 *
 * Returns an async teardown function that stops forwarding.
 */
export async function bridgeStoreToRules(
  store: Store,
  receiver: EventReceiver,
  options: BridgeOptions = {},
): Promise<() => Promise<void>> {
  const { filter, mapTopic, mapData } = options;

  return store.on<BucketEvent>('bucket.*.*', (event, topic) => {
    if (filter !== undefined && !filter(event)) return;

    const finalTopic = mapTopic !== undefined ? mapTopic(topic, event) : topic;
    const finalData = mapData !== undefined
      ? mapData(event)
      : (event as unknown as Record<string, unknown>);

    // Fire-and-forget — receiver errors must not affect the store EventBus.
    receiver.emit(finalTopic, finalData).catch(() => {});
  });
}
