/* Service detail drawer + Restart confirm modal + Toast system */

function Drawer({ open, svc, status, sparks, onClose, vms }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!svc) return null;
  const vm = vms.find(v => v.service.includes(svc.id) || v.name === svc.id);
  const cert = CERTS.find(c => c.domain.includes(svc.id) || c.domain === '*.rxf-sys.de');
  const incidents = svc.id === 'media' ? [
    { when: 'jetzt',     level: 'warn', text: 'Response zeit > 300ms (jellyfin transcode)' },
    { when: 'vor 2h',    level: 'ok',   text: 'Service recovered' },
    { when: 'vor 2h',    level: 'err',  text: 'HTTP 503 für 4 min' },
  ] : [
    { when: 'vor 32d',   level: 'ok',   text: 'Service deployed' },
  ];

  return (
    <>
      <div className={`drawer-backdrop ${open?'open':''}`} onClick={onClose}/>
      <aside className={`drawer ${open?'open':''}`}>
        <div className="drawer-h">
          <span className="svc-icon" style={{ width: 36, height: 36 }}>{ICONS[svc.icon]}</span>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>{svc.name}</h2>
              <Dot status={status.status}/>
              <span className={`badge ${status.status}`}>{status.status==='ok'?'HEALTHY':status.status==='warn'?'DEGRADED':'DOWN'}</span>
            </div>
            <a className="mono drawer-link" href={`https://${svc.sub}`} target="_blank" rel="noreferrer">
              {svc.sub} {ICONS.external}
            </a>
          </div>
          <button className="btn icon" onClick={onClose} title="Close">{ICONS.close}</button>
        </div>

        <div className="drawer-body">
          <div className="drawer-summary">
            <div><span className="dim" style={{fontSize:11, textTransform:'uppercase', letterSpacing:0.4}}>Response</span><div><Num value={Math.round(status.ms)} unit="ms" size="lg"/></div></div>
            <div><span className="dim" style={{fontSize:11, textTransform:'uppercase', letterSpacing:0.4}}>Uptime</span><div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{status.uptime}</div></div>
            <div><span className="dim" style={{fontSize:11, textTransform:'uppercase', letterSpacing:0.4}}>SLA 30d</span><div><Num value="99.94" unit="%" size="lg"/></div></div>
            <div><span className="dim" style={{fontSize:11, textTransform:'uppercase', letterSpacing:0.4}}>Reachability</span><div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <span className={`reach ${status.ext?'ok':'off'}`} style={{ padding: '3px 8px' }}>EXT</span>
              <span className={`reach ${status.int?'ok':'off'}`} style={{ padding: '3px 8px' }}>INT</span>
            </div></div>
          </div>

          <div className="drawer-section">
            <h3>Response time · 24h</h3>
            <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 6, padding: 14 }}>
              <Sparkline data={sparks} color={status.status==='warn'?'var(--warn)':'var(--accent)'} width={520} height={70}/>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>
                <span className="mono">min {Math.round(Math.min(...sparks))}ms</span>
                <span className="mono">avg {Math.round(sparks.reduce((a,b)=>a+b,0)/sparks.length)}ms</span>
                <span className="mono">p95 {Math.round([...sparks].sort((a,b)=>a-b)[Math.floor(sparks.length*0.95)])}ms</span>
                <span className="mono">max {Math.round(Math.max(...sparks))}ms</span>
              </div>
            </div>
          </div>

          {vm && (
            <div className="drawer-section">
              <h3>Container</h3>
              <div className="kv-grid">
                <div><span className="dim">ID</span><span className="mono">{vm.id}</span></div>
                <div><span className="dim">Type</span><span className={`type-pill type-${vm.type.toLowerCase()}`}>{vm.type}</span></div>
                <div><span className="dim">IP</span><span className="mono">{vm.ip}</span></div>
                <div><span className="dim">Uptime</span><span className="mono">{vm.uptime}</span></div>
                <div><span className="dim">CPU</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="bar" style={{ flex: 1 }}><div className="bar-fill" style={{ width: `${vm.cpu}%`, background: 'var(--ok)' }}/></div>
                    <span className="mono" style={{ fontSize: 12, width: 30 }}>{vm.cpu}%</span>
                  </div>
                </div>
                <div><span className="dim">RAM</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="bar" style={{ flex: 1 }}><div className="bar-fill" style={{ width: `${vm.ram}%`, background: 'var(--ok)' }}/></div>
                    <span className="mono" style={{ fontSize: 12, width: 30 }}>{vm.ram}%</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="drawer-section">
            <h3>Recent events</h3>
            <div className="event-list">
              {incidents.map((e, i) => (
                <div key={i} className="event-row">
                  <Dot status={e.level}/>
                  <span style={{ fontSize: 13, flex: 1 }}>{e.text}</span>
                  <span className="mono dim" style={{ fontSize: 11 }}>{e.when}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="drawer-section">
            <h3>Logs · tail</h3>
            <pre className="log-pre mono">
{`[2026-05-05 06:42:17] INFO  ${svc.id}: GET / 200 (${Math.round(status.ms)}ms)
[2026-05-05 06:42:08] INFO  ${svc.id}: GET /api/health 200 (12ms)
[2026-05-05 06:41:51] INFO  ${svc.id}: GET / 200 (${Math.round(status.ms*0.9)}ms)
[2026-05-05 06:41:33] DEBUG ${svc.id}: cache hit ratio 94.2%
[2026-05-05 06:41:12] INFO  ${svc.id}: scheduled task complete
[2026-05-05 06:40:55] INFO  ${svc.id}: GET /static/app.js 304 (4ms)`}
            </pre>
          </div>

          <div className="drawer-section">
            <h3>Cert</h3>
            {cert && (
              <div className="kv-grid">
                <div><span className="dim">Domain</span><span className="mono">{svc.sub}</span></div>
                <div><span className="dim">Issuer</span><span>{cert.issuer}</span></div>
                <div><span className="dim">Valid for</span><span className="mono" style={{ color: cert.daysLeft < 30 ? 'var(--warn)' : 'var(--ok)' }}>{cert.daysLeft} days</span></div>
                <div><span className="dim">SAN</span><span className="mono dim">*.rxf-sys.de</span></div>
              </div>
            )}
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn">{ICONS.logs} Open Logs</button>
          <button className="btn danger">{ICONS.restart} Restart Service</button>
          <a className="btn primary" href={`https://${svc.sub}`} target="_blank" rel="noreferrer">{ICONS.external} Open</a>
        </div>
      </aside>
    </>
  );
}

function ConfirmModal({ open, vm, onConfirm, onCancel }) {
  if (!open || !vm) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Restart {vm.name}?</h3>
        <p style={{ color: 'var(--text-3)', fontSize: 13 }}>
          Container <span className="mono" style={{ color: 'var(--text-1)' }}>{vm.id}</span> ({vm.type}) wird neu gestartet.
          Service <span style={{ color: 'var(--text-1)' }}>{vm.service}</span> ist für ~30s nicht erreichbar.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel}>Abbrechen</button>
          <button className="btn danger" onClick={onConfirm}>Restart</button>
        </div>
      </div>
    </div>
  );
}

function Toasts({ toasts }) {
  return (
    <div className="toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          <span className="toast-icon">
            {t.level === 'ok' && ICONS.check}
            {t.level === 'warn' && ICONS.warn}
            {t.level === 'err' && ICONS.x}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t.title}</div>
            {t.body && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t.body}</div>}
          </div>
          <span className="mono dimmer" style={{ fontSize: 10 }}>{t.time}</span>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { Drawer, ConfirmModal, Toasts });
