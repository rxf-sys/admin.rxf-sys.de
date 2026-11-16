import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Persistent audit log (ADR 0004). Rows outlive the accounts they mention, so there is no foreign key. */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    actorUserId: integer('actor_user_id'),
    actorIp: text('actor_ip'),
    event: text('event').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    instanceId: text('instance_id'),
    detailsJson: text('details_json').notNull().default('{}'),
    result: text('result', { enum: ['success', 'failure', 'denied'] }).notNull(),
  },
  (table) => [index('audit_events_ts').on(table.ts), index('audit_events_event_ts').on(table.event, table.ts)],
);
