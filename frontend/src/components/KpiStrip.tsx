import type { Guest, ServiceStatus } from '../types';
import { Sparkline } from './primitives';

interface Props {
  guests: Guest[];
  services: ServiceStatus[];
  /** Optional sparkline series for the worst-offender service's response-time. */
  worstSpark?: number[];
}

export function KpiStrip({ guests, services, worstSpark }: Props) {
  const running = guests.filter((g) => g.running).length;
  const total = guests.length;
  const svcOk = services.filter((s) => s.status === 'ok').length;
  const svcTotal = services.length;
  const avgMs = svcTotal > 0
    ? Math.round(services.reduce((a, s) => a + s.ms, 0) / svcTotal)
    : 0;
  const uptimeValues = services.map((s) => s.uptime_pct).filter((v): v is number => v != null);
  const sla = uptimeValues.length > 0
    ? (uptimeValues.reduce((a, b) => a + b, 0) / uptimeValues.length).toFixed(2)
    : '—';
  const containersHealthy = total > 0 && running === total;
  const servicesHealthy = svcTotal > 0 && svcOk === svcTotal;
  const worst = services
    .filter((s) => s.status !== 'ok')
    .sort((a, b) => b.ms - a.ms)[0];
  const spark = worstSpark && worstSpark.length > 0
    ? worstSpark
    : worst
      ? [worst.ms * 0.7, worst.ms * 0.8, worst.ms * 0.95, worst.ms]
      : null;

  return (
    <div className="kpi-strip">
      <div className="kpi">
        <span className="kpi-label">Container Up</span>
        <span className={`kpi-value ${containersHealthy ? '' : 'warn'}`}>
          {running}<span className="unit">/ {total}</span>
        </span>
        <span className="kpi-meta">
          {containersHealthy
            ? <><span className="pct-up">▲ 100%</span> running</>
            : <><span className="pct-down">{total - running} down</span></>}
        </span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Services Healthy</span>
        <span className={`kpi-value ${servicesHealthy ? '' : svcOk < svcTotal / 2 ? 'err' : 'warn'}`}>
          {svcOk}<span className="unit">/ {svcTotal}</span>
        </span>
        <span className="kpi-meta">
          {servicesHealthy ? 'alle OK' : `${svcTotal - svcOk} betroffen`}
        </span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Avg Response</span>
        <span className={`kpi-value ${avgMs > 1000 ? 'err' : avgMs > 300 ? 'warn' : ''}`}>
          {avgMs}<span className="unit">ms</span>
        </span>
        <span className="kpi-meta">
          {worst ? <>spike: {worst.name}</> : 'stabil'}
        </span>
        {spark && (
          <span className="kpi-spark" aria-hidden="true">
            <Sparkline data={spark} color={worst?.status === 'err' ? 'var(--err)' : 'var(--warn)'} width={60} height={20} stroke={1} />
          </span>
        )}
      </div>
      <div className="kpi">
        <span className="kpi-label">SLA · 30d</span>
        <span className="kpi-value">{sla}<span className="unit">%</span></span>
        <span className="kpi-meta">Target: 99.9%</span>
      </div>
    </div>
  );
}
