import { type EntityResponse, queryKeys } from '@rxf/contracts';
import type { DataAccess, Locale, WidgetProps } from '@rxf/web-sdk';
import { useQuery } from '@tanstack/react-query';
import { translator } from '../i18n.ts';
import styles from '../uptime.module.css';
import { Sparkline } from './sparkline.tsx';

const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;

/** Response times of one check over 24 h; the window is rounded to the minute so the query key stays stable. */
function useResponseTimes(data: DataAccess, entityId: number) {
  const series = useQuery({
    queryKey: queryKeys.metricSeries(entityId),
    queryFn: () => data.series(entityId),
  });
  const seriesId = series.data?.find((s) => s.name === 'uptime.response_ms')?.id;
  const to = Math.ceil(Date.now() / MINUTE) * MINUTE;
  return useQuery({
    queryKey: queryKeys.metricPoints(seriesId ?? -1, to - DAY, to),
    queryFn: () => data.points(seriesId as number, { from: to - DAY, to }),
    enabled: seriesId !== undefined,
    placeholderData: (previous) => previous,
  });
}

/** The status in words; a few reasons say more than "slow" or "failing". */
function statusLabel(entity: EntityResponse, t: ReturnType<typeof translator>): string {
  switch (entity.statusReason) {
    case 'TLS_EXPIRING':
      return t('status.expiring');
    case 'TLS_EXPIRED':
      return t('status.expired');
    case 'ICMP_LOSS':
      return t('status.loss');
    case 'ICMP_UNAVAILABLE':
      return t('status.noPing');
    default:
      return t(`status.${entity.status}`);
  }
}

function valueText(entity: EntityResponse, t: ReturnType<typeof translator>): string {
  const { daysLeft, responseMs } = entity.attrs;
  if (entity.attrs.type === 'tls' && typeof daysLeft === 'number') {
    return daysLeft < 0 ? t('widget.expired') : t('widget.daysLeft', { days: daysLeft });
  }
  return typeof responseMs === 'number' ? t('widget.responseTime', { ms: responseMs }) : t('widget.noResponse');
}

function CheckRow({ entity, data, locale }: { entity: EntityResponse; data: DataAccess; locale: Locale }) {
  const t = translator(locale);
  const points = useResponseTimes(data, entity.id);
  const endpoint = typeof entity.attrs.endpoint === 'string' ? entity.attrs.endpoint : '';
  // `target` since Phase 5; older snapshots only carry the URL.
  const host =
    typeof entity.attrs.target === 'string'
      ? entity.attrs.target
      : URL.canParse(endpoint)
        ? new URL(endpoint).host
        : endpoint;
  return (
    <li className={styles.row}>
      <span className={styles.status} data-status={entity.status}>
        <span className={styles.dot} aria-hidden="true" />
        {statusLabel(entity, t)}
      </span>
      <span className={styles.name}>
        <span className={styles.title}>{entity.name}</span>
        <span className={styles.host}>{host}</span>
      </span>
      <Sparkline points={points.data?.points ?? []} locale={locale} />
      <span className={styles.value}>{valueText(entity, t)}</span>
    </li>
  );
}

/** One row per check: status in words and colour, response time now and as a 24-hour sparkline. */
export default function ChecksWidget({ instanceId, data, locale }: WidgetProps) {
  const t = translator(locale);
  const checks = useQuery({
    queryKey: queryKeys.entities(instanceId, 'Service'),
    queryFn: () => data.entities(instanceId, 'Service'),
  });
  if (checks.isPending) return <p className={styles.help}>{t('widget.loading')}</p>;
  if (checks.isError) return <p className={styles.error}>{t('widget.error')}</p>;
  if (checks.data.length === 0) return <p className={styles.help}>{t('widget.empty')}</p>;
  const up = checks.data.filter((check) => check.status === 'ok' || check.status === 'warn').length;
  return (
    <div className={styles.widget}>
      <p className={styles.summary}>{t('widget.summary', { up, total: checks.data.length })}</p>
      <ul className={styles.list}>
        {checks.data.map((entity) => (
          <CheckRow key={entity.id} entity={entity} data={data} locale={locale} />
        ))}
      </ul>
    </div>
  );
}
