import { describe, expect, it } from 'vitest';
import { EventBus } from './bus.ts';

describe('EventBus', () => {
  it('delivers events to subscribers until they unsubscribe', () => {
    const bus = new EventBus(() => 0);
    const seen: string[] = [];
    const off = bus.subscribe((event) => seen.push(event.type));
    bus.publish('resync', {});
    off();
    bus.publish('resync', {});
    expect(seen).toEqual(['resync']);
  });

  it('replays what a reconnecting client missed and asks for a resync otherwise', () => {
    const clock = { now: 0 };
    const bus = new EventBus(() => clock.now);
    const ids: string[] = [];
    bus.subscribe((event) => ids.push(event.id));
    for (let i = 0; i < 3; i++) bus.publish('metrics', { seriesIds: [i], until: i });
    const [first, second, third] = ids as [string, string, string];

    expect(bus.since(first)?.map((e) => e.id)).toEqual([second, third]);
    expect(bus.since(third)).toEqual([]);
    // Unknown boot (restart), future sequence, garbage.
    expect(bus.since(`00000000-${first.split('-')[1]}`)).toBeNull();
    expect(bus.since(`${first.split('-')[0]}-99`)).toBeNull();
    expect(bus.since('not-an-id')).toBeNull();

    // Older than five minutes: evicted, so the client has to resync.
    clock.now = 6 * 60_000;
    bus.publish('resync', {});
    expect(bus.since(first)).toBeNull();
    expect(bus.since(third)?.map((e) => e.type)).toEqual(['resync']);
  });
});
