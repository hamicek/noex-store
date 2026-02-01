import { GenServer } from '@hamicek/noex';
import type { BucketRef } from '../core/bucket-server.js';

// ── Internal types ──────────────────────────────────────────────

interface TtlBucketEntry {
  readonly ref: BucketRef;
  readonly ttlMs: number;
}

// ── TtlManager ──────────────────────────────────────────────────

/**
 * Periodically scans TTL-enabled buckets and purges expired records.
 *
 * Uses `setTimeout` chaining (not `setInterval`) to prevent overlapping
 * ticks when a purge cycle takes longer than the check interval.
 */
export class TtlManager {
  readonly #buckets = new Map<string, TtlBucketEntry>();
  readonly #checkIntervalMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(checkIntervalMs: number = 1_000) {
    this.#checkIntervalMs = checkIntervalMs;
  }

  get bucketCount(): number {
    return this.#buckets.size;
  }

  get enabled(): boolean {
    return this.#running;
  }

  get checkIntervalMs(): number {
    return this.#checkIntervalMs;
  }

  registerBucket(name: string, ref: BucketRef, ttlMs: number): void {
    this.#buckets.set(name, { ref, ttlMs });
  }

  unregisterBucket(name: string): void {
    this.#buckets.delete(name);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#scheduleNext();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Manually trigger a TTL purge on all registered buckets.
   * Returns the total number of purged records across all buckets.
   */
  async purge(): Promise<number> {
    return this.#tick();
  }

  // ── Private ─────────────────────────────────────────────────

  #scheduleNext(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(async () => {
      await this.#tick();
      this.#scheduleNext();
    }, this.#checkIntervalMs);
  }

  async #tick(): Promise<number> {
    let total = 0;

    for (const [, entry] of this.#buckets) {
      if (!GenServer.isRunning(entry.ref)) continue;

      try {
        const purged = await GenServer.call(entry.ref, { type: 'purgeExpired' });
        total += purged as number;
      } catch {
        // Bucket may have been stopped between the isRunning check and
        // the call — swallow the error to keep other buckets processing.
      }
    }

    return total;
  }
}
