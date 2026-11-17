import { entityKinds, entityStatuses } from '@rxf/contracts';
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

/** Accounts (ADR 0005). `role` is checked on the server only; `status` disables without deleting. */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  role: text('role', { enum: ['admin', 'operator', 'viewer'] }).notNull(),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at').notNull(),
});

export const userPasswords = sqliteTable('user_passwords', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  hash: text('hash').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * TOTP secrets sealed with the master key (ADR 0006). The confirmed secret stays in force while a
 * replacement is pending; `lastStep` blocks replaying a code of the confirmed secret.
 */
export const userTotp = sqliteTable('user_totp', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  ciphertext: blob('ciphertext', { mode: 'buffer' }),
  iv: blob('iv', { mode: 'buffer' }),
  tag: blob('tag', { mode: 'buffer' }),
  keyId: text('key_id'),
  confirmedAt: integer('confirmed_at'),
  lastStep: integer('last_step'),
  pendingCiphertext: blob('pending_ciphertext', { mode: 'buffer' }),
  pendingIv: blob('pending_iv', { mode: 'buffer' }),
  pendingTag: blob('pending_tag', { mode: 'buffer' }),
  pendingKeyId: text('pending_key_id'),
});

export const userBackupCodes = sqliteTable(
  'user_backup_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: integer('used_at'),
  },
  (table) => [index('user_backup_codes_user').on(table.userId)],
);

/** Only the SHA-256 of the session token is stored, plus a short prefix to name it in the session list. */
export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    prefix: text('prefix').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    mfaDone: integer('mfa_done', { mode: 'boolean' }).notNull().default(false),
    elevatedUntil: integer('elevated_until'),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [index('sessions_user').on(table.userId)],
);

/** Failed-attempt counters per account and per client IP (ADR 0005), pruned when they go stale. */
export const loginAttempts = sqliteTable('login_attempts', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull(),
  windowStart: integer('window_start').notNull(),
  lockedUntil: integer('locked_until'),
  updatedAt: integer('updated_at').notNull(),
});

/** Single row: the hashed setup code until the first admin exists. */
export const setupState = sqliteTable('setup_state', {
  id: integer('id').primaryKey(),
  codeHash: text('code_hash'),
  expiresAt: integer('expires_at'),
  completedAt: integer('completed_at'),
});

/** One configured plugin (ADR 0003, 0004). Secret fields never land in `config_json`. */
export const pluginInstances = sqliteTable('plugin_instances', {
  id: text('id').primaryKey(),
  pluginId: text('plugin_id').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['draft', 'active', 'paused'] }).notNull(),
  configJson: text('config_json').notNull(),
  createdBy: integer('created_by'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Secret config values, sealed with the master key and bound to instance, slot and field (ADR 0006). */
export const secrets = sqliteTable(
  'secrets',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => pluginInstances.id, { onDelete: 'cascade' }),
    slot: text('slot').notNull(),
    field: text('field').notNull(),
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
    iv: blob('iv', { mode: 'buffer' }).notNull(),
    tag: blob('tag', { mode: 'buffer' }).notNull(),
    keyId: text('key_id').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.slot, table.field] })],
);

/**
 * Normalised entities all plugins write into (ADR 0004). `collector_id` records which collector owns the row,
 * so a snapshot only ages out the entities of its own collector.
 */
export const entities = sqliteTable(
  'entities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instanceId: text('instance_id')
      .notNull()
      .references(() => pluginInstances.id, { onDelete: 'cascade' }),
    collectorId: text('collector_id').notNull(),
    kind: text('kind', { enum: entityKinds }).notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: entityStatuses }).notNull(),
    statusReason: text('status_reason'),
    lastSeen: integer('last_seen'),
    attrsJson: text('attrs_json').notNull().default('{}'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('entities_instance_kind_external').on(table.instanceId, table.kind, table.externalId),
    index('entities_kind_status').on(table.kind, table.status),
  ],
);

export const metricSeries = sqliteTable(
  'metric_series',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityId: integer('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    unit: text('unit').notNull(),
  },
  (table) => [uniqueIndex('metric_series_entity_name').on(table.entityId, table.name)],
);

/** Raw values, kept 48 h. The migration declares the table WITHOUT ROWID (drizzle has no option for it). */
export const metricRaw = sqliteTable(
  'metric_raw',
  {
    seriesId: integer('series_id')
      .notNull()
      .references(() => metricSeries.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    value: real('value').notNull(),
  },
  (table) => [primaryKey({ columns: [table.seriesId, table.ts] })],
);

function rollupColumns() {
  return {
    seriesId: integer('series_id')
      .notNull()
      .references(() => metricSeries.id, { onDelete: 'cascade' }),
    bucket: integer('bucket').notNull(),
    avg: real('avg').notNull(),
    min: real('min').notNull(),
    max: real('max').notNull(),
    count: integer('count').notNull(),
  };
}

/** 5-minute means, kept 30 days; WITHOUT ROWID like `metric_raw`. */
export const metric5m = sqliteTable('metric_5m', rollupColumns(), (table) => [
  primaryKey({ columns: [table.seriesId, table.bucket] }),
]);

/** Hourly means, kept 365 days; WITHOUT ROWID like `metric_raw`. */
export const metric1h = sqliteTable('metric_1h', rollupColumns(), (table) => [
  primaryKey({ columns: [table.seriesId, table.bucket] }),
]);
