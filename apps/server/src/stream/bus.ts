import { randomBytes } from 'node:crypto';
import type { StreamEventData, StreamEventType } from '@rxf/contracts';

const REPLAY_WINDOW_MS = 5 * 60_000;
const REPLAY_MAX_EVENTS = 5_000;

export interface BusEvent {
  /** `<boot>-<sequence>`: ids from before a restart never match, so those clients get a `resync`. */
  id: string;
  type: StreamEventType;
  data: unknown;
  ts: number;
  sequence: number;
}

type Listener = (event: BusEvent) => void;

/**
 * In-process fan-out for live updates with a five-minute replay buffer (ADR 0007). Events carry no entity
 * payloads, only what changed, so every subscriber may see every event.
 */
export class EventBus {
  readonly #boot = randomBytes(4).toString('hex');
  readonly #now: () => number;
  readonly #listeners = new Set<Listener>();
  readonly #buffer: BusEvent[] = [];
  #sequence = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  publish<T extends StreamEventType>(type: T, data: StreamEventData<T>): void {
    const ts = this.#now();
    this.#sequence += 1;
    const event: BusEvent = { id: `${this.#boot}-${this.#sequence}`, type, data, ts, sequence: this.#sequence };
    this.#buffer.push(event);
    while (this.#buffer.length > REPLAY_MAX_EVENTS || (this.#buffer[0] as BusEvent).ts < ts - REPLAY_WINDOW_MS) {
      this.#buffer.shift();
    }
    for (const listener of this.#listeners) listener(event);
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Events after `lastEventId`, or null when they are no longer known (other boot, too old, malformed):
   * the client then has to resync.
   */
  since(lastEventId: string): BusEvent[] | null {
    const match = /^([0-9a-f]{8})-(\d{1,15})$/.exec(lastEventId);
    if (!match || match[1] !== this.#boot) return null;
    const sequence = Number(match[2]);
    if (sequence > this.#sequence) return null;
    if (sequence === this.#sequence) return [];
    const first = this.#buffer[0];
    if (!first || first.sequence > sequence + 1) return null;
    return this.#buffer.filter((event) => event.sequence > sequence);
  }
}
