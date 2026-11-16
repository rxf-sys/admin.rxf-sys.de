import { describe, expect, it } from 'vitest';
import { recordAudit } from './audit.ts';
import { auditEvents } from './db/schema.ts';
import { testDatabase } from './test-support.ts';

describe('recordAudit', () => {
  it('stores the event with redacted details', () => {
    const { db } = testDatabase();
    recordAudit(
      db,
      {
        event: 'instance.updated',
        result: 'success',
        actorUserId: 1,
        actorIp: '192.168.2.10',
        targetType: 'plugin_instance',
        targetId: 'pve-1',
        details: { changed: ['host', 'tokenSecret'], tokenSecret: 'cfut_secret', note: 'Bearer abcdefghijkl' },
      },
      () => 1_792_400_000_000,
    );
    const [row] = db.select().from(auditEvents).all();
    expect(row).toMatchObject({ ts: 1_792_400_000_000, event: 'instance.updated', result: 'success', actorUserId: 1 });
    expect(JSON.parse(row?.detailsJson ?? '')).toEqual({
      changed: ['host', 'tokenSecret'],
      tokenSecret: '[redacted]',
      note: '[redacted]',
    });
  });

  it('fills optional columns with null', () => {
    const { db } = testDatabase();
    recordAudit(db, { event: 'setup.code_issued', result: 'success' });
    expect(db.select().from(auditEvents).all()[0]).toMatchObject({
      actorUserId: null,
      actorIp: null,
      targetType: null,
      instanceId: null,
      detailsJson: '{}',
    });
  });
});
