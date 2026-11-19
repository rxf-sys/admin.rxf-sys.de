import { backupCodesResponse, sessionListResponse } from '@rxf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import * as z from 'zod/mini';
import { getJson, okResponse, sendJson } from '../api.ts';
import { formatDateTime, t } from '../i18n.ts';
import { BackupCodes } from '../ui/BackupCodes.tsx';
import { errorText } from '../ui/errors.ts';
import { FormError } from '../ui/Field.tsx';
import { useElevated } from '../ui/reauth.tsx';
import ui from '../ui/ui.module.css';
import { describeAgent } from './agent.ts';
import styles from './app.module.css';

const revokedResponse = z.object({ revoked: z.number() });

function SessionList() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getJson('/api/auth/sessions', sessionListResponse),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });
  const revoke = useMutation({
    mutationFn: (id: string) => sendJson('DELETE', `/api/auth/sessions/${id}`, okResponse),
    onSettled: refresh,
  });
  const revokeOthers = useMutation({
    mutationFn: () => sendJson('POST', '/api/auth/sessions/revoke-others', revokedResponse),
    onSettled: refresh,
  });
  const failure = revoke.error ?? revokeOthers.error;

  return (
    <section className={ui.card} aria-labelledby="sessions-title">
      <div className={ui.field}>
        <h2 id="sessions-title" className={ui.cardTitle}>
          {t('security.sessions')}
        </h2>
        <p className={ui.muted}>{t('security.sessionsIntro')}</p>
      </div>
      <FormError message={failure ? errorText(failure) : null} />
      {revokeOthers.isSuccess ? (
        <p className={`${ui.callout} ${ui.ok}`} role="status">
          {t('security.othersRevoked', { count: revokeOthers.data.revoked })}
        </p>
      ) : null}
      {sessions.data ? (
        <ul className={styles.list}>
          {sessions.data.sessions.map((session) => {
            const device = session.userAgent ? describeAgent(session.userAgent) : t('security.unknownDevice');
            return (
              <li key={session.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>
                    {device}
                    {session.current ? <span className={styles.badge}>{t('security.current')}</span> : null}
                  </span>
                  <span className={styles.rowMeta}>
                    {session.ip ?? t('security.unknownIp')} ·{' '}
                    {t('security.lastSeen', { time: formatDateTime(session.lastSeenAt) })}
                  </span>
                </div>
                {session.current ? null : (
                  <button
                    type="button"
                    className={`${ui.btn} ${ui.outline} ${ui.small}`}
                    aria-label={t('security.revokeNamed', { device })}
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(session.id)}
                  >
                    {t('security.revoke')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={ui.muted} role="status">
          {sessions.isError ? errorText(sessions.error) : t('app.loading')}
        </p>
      )}
      {sessions.data && sessions.data.sessions.length > 1 ? (
        <div className={ui.actions}>
          <button
            type="button"
            className={`${ui.btn} ${ui.outline}`}
            disabled={revokeOthers.isPending}
            onClick={() => revokeOthers.mutate()}
          >
            {t('security.revokeOthers')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function BackupCodeRenewal() {
  const elevated = useElevated();
  const [codes, setCodes] = useState<string[] | null>(null);
  const renew = useMutation({
    mutationFn: () => elevated(() => sendJson('POST', '/api/auth/backup-codes', backupCodesResponse)),
    onSuccess: (result) => {
      if (result) setCodes(result.backupCodes);
    },
  });
  return (
    <section className={ui.card} aria-labelledby="backup-title">
      <div className={ui.field}>
        <h2 id="backup-title" className={ui.cardTitle}>
          {t('security.backupTitle')}
        </h2>
        <p className={ui.muted}>{codes ? t('enrol.backupIntro') : t('security.backupIntro')}</p>
      </div>
      <FormError message={renew.isError ? errorText(renew.error) : null} />
      {codes ? <BackupCodes codes={codes} /> : null}
      <div className={ui.actions}>
        <button
          type="button"
          className={`${ui.btn} ${ui.outline}`}
          disabled={renew.isPending}
          onClick={() => renew.mutate()}
        >
          {t('security.backupRenew')}
        </button>
      </div>
    </section>
  );
}

export function SecurityPage() {
  return (
    <>
      <h1>{t('security.title')}</h1>
      <SessionList />
      <BackupCodeRenewal />
    </>
  );
}
