import type { Db } from './db/database.ts';
import { auditEvents } from './db/schema.ts';
import { redactValue } from './log/redact.ts';

export interface AuditEntry {
  event: string;
  result: 'success' | 'failure' | 'denied';
  actorUserId?: number | null;
  actorIp?: string | null;
  targetType?: string;
  targetId?: string;
  instanceId?: string;
  details?: Record<string, unknown>;
}

/** Writes one audit row. Details pass through the log redaction, so a secret can never land here. */
export function recordAudit(db: Db, entry: AuditEntry, now: () => number = Date.now): void {
  db.insert(auditEvents)
    .values({
      ts: now(),
      event: entry.event,
      result: entry.result,
      actorUserId: entry.actorUserId ?? null,
      actorIp: entry.actorIp ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      instanceId: entry.instanceId ?? null,
      detailsJson: JSON.stringify(redactValue(entry.details ?? {})),
    })
    .run();
}
