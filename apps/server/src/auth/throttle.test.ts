import { describe, expect, it } from 'vitest';
import { loginAttempts } from '../db/schema.ts';
import { testDatabase } from '../test-support.ts';
import { Throttle } from './throttle.ts';

function setup() {
  const clock = { now: 1_000_000 };
  const { db } = testDatabase();
  return { db, clock, throttle: new Throttle(db, () => clock.now) };
}

describe('Throttle', () => {
  it('locks an account after five failures, doubling up to 15 minutes, never for good', () => {
    const { throttle, clock } = setup();
    for (let i = 0; i < 4; i++) throttle.recordAccountFailure('account:a');
    expect(throttle.accountWait('account:a')).toBe(0);
    throttle.recordAccountFailure('account:a');
    expect(throttle.accountWait('account:a')).toBe(30_000);
    throttle.recordAccountFailure('account:a');
    expect(throttle.accountWait('account:a')).toBe(60_000);
    for (let i = 0; i < 10; i++) throttle.recordAccountFailure('account:a');
    expect(throttle.accountWait('account:a')).toBe(15 * 60_000);
    clock.now += 15 * 60_000;
    expect(throttle.accountWait('account:a')).toBe(0);
  });

  it('blocks a key once the window is full and frees it when the window ends', () => {
    const { throttle, clock } = setup();
    const rule = { limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) throttle.recordWindowFailure('ip:1', rule);
    expect(throttle.windowWait('ip:1', rule)).toBe(60_000);
    clock.now += 60_000;
    expect(throttle.windowWait('ip:1', rule)).toBe(0);
    throttle.recordWindowFailure('ip:1', rule);
    expect(throttle.windowWait('ip:1', rule)).toBe(0);
  });

  it('clears on success and prunes stale rows', () => {
    const { throttle, clock, db } = setup();
    throttle.recordAccountFailure('account:a');
    throttle.recordAccountFailure('account:b');
    throttle.clear('account:a');
    clock.now += 25 * 60 * 60_000;
    throttle.prune();
    expect(db.select().from(loginAttempts).all()).toEqual([]);
  });
});
