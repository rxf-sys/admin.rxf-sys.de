import { healthResponse } from '@rxf/contracts';
import { useQuery } from '@tanstack/react-query';
import { getJson } from './api.ts';
import styles from './HealthStatus.module.css';
import { t } from './i18n.ts';

export function HealthStatus() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => getJson('/api/healthz', healthResponse),
    retry: false,
  });

  const state = health.isPending ? 'checking' : health.isError ? 'error' : 'ok';
  const text =
    state === 'ok' && health.data
      ? t('health.ok', { version: health.data.version })
      : t(state === 'checking' ? 'health.checking' : 'health.error');

  return (
    <section className={styles.card} aria-labelledby="health-title">
      <h2 id="health-title" className={styles.title}>
        {t('health.title')}
      </h2>
      <p className={styles.status} data-state={state} role="status">
        <span className={styles.dot} aria-hidden="true" />
        {text}
      </p>
    </section>
  );
}
