/* Main Dashboard view — composes Header, Overview cards, Service grid,
   Container table, Network panel, Backup + Cert section. */

const { useState, useEffect, useRef, useMemo } = React;

// ----- Header -----
function Header({ servicesUp, servicesTotal, lastRefresh, onRefresh, refreshing, theme, onTheme, email, wanIp, accent, onAccent }) {
  const allUp = servicesUp === servicesTotal;
  return (
    <header className="dash-header">
      <div className="hdr-left">
        <div className="logo">
          <span className="logo-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22"><defs><linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="var(--indigo)"/><stop offset="100%" stopColor="var(--peach)"/></linearGradient></defs><rect x="2" y="2" width="20" height="20" rx="5" fill="url(#lg1)"/><path d="M7 8h6a3 3 0 0 1 0 6H10l4 4M7 8v10" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round"/></svg>
          </span>
          <div className="logo-text">
            <span className="logo-title">rxf-sys</span>
            <span className="logo-sub">admin</span>
          </div>
        </div>
        <span className="hdr-sep" />
        <span className="hdr-crumb mono">admin.rxf-sys.de</span>
      </div>

      <div className="hdr-mid">
        <div className={`global-status ${allUp ? 'ok' : 'warn'}`}>
          <span className={`dot ${allUp ? 'ok' : 'warn'}`} />
          <span className="gs-label">{allUp ? 'Alle Systeme operational' : `${servicesTotal - servicesUp} von ${servicesTotal} Services degraded`}</span>
        </div>
      </div>

      <div className="hdr-right">
        <div className="hdr-meta">
          <span className="dimmer" style={{ fontSize: 11 }}>Last refresh</span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>{lastRefresh}</span>
        </div>
        <button className={`btn icon ${refreshing ? 'spin' : ''}`} onClick={onRefresh} title="Refresh">{ICONS.refresh}</button>
        <div className="accent-swatches" title="Accent">
          {['peach','indigo','cyan','green'].map(a => (
            <button key={a} className={`swatch ${accent===a?'active':''}`} data-a={a} onClick={() => onAccent(a)} aria-label={a}/>
          ))}
        </div>
        <button className="btn icon" onClick={onTheme} title="Theme">{theme === 'dark' ? ICONS.sun : ICONS.moon}</button>
        <div className="hdr-user">
          <div className="avatar">RF</div>
          <div className="hdr-user-meta">
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{email}</span>
            <span className="dimmer mono" style={{ fontSize: 10 }}>via Cloudflare Access</span>
          </div>
        </div>
      </div>
    </header>
  );
}

// ----- Overview cards (top row) -----
function OverviewCards({ services, vms, statuses }) {
  const upCount = vms.filter(v => v.status === 'ok').length;
  const conns = 12;
  return (
    <div className="overview-grid">
      {/* Proxmox Host */}
      <div className="card overview-card">
        <div className="card-h">
          <h3>Proxmox Host</h3>
          <span className="badge ok"><span className="dot ok"/> ONLINE</span>
        </div>
        <div className="ov-body">
          <Donut value={28} label="CPU" sublabel="5.6 / 20"/>
          <Donut value={42} label="RAM" sublabel="27 / 64 GB"/>
          <Donut value={61} label="DISK" sublabel="2.4 / 4 TB"/>
        </div>
        <div className="ov-foot mono">pve · 8.2.4 · kernel 6.8.12-1-pve</div>
      </div>

      {/* Containers/VMs */}
      <div className="card overview-card">
        <div className="card-h">
          <h3>Container & VMs</h3>
          <span className="badge ok"><Num value={`${upCount}/${vms.length}`} size="sm"/> RUNNING</span>
        </div>
        <div className="ov-big">
          <Num value={upCount} size="xl"/>
          <span className="dim" style={{ fontSize: 13 }}>von {vms.length} laufen</span>
        </div>
        <div className="ov-mini-list">
          {vms.slice(0, 4).map(v => (
            <div key={v.id} className="mini-row">
              <Dot status={v.status}/>
              <span className="mono dim" style={{ fontSize: 11 }}>{v.id}</span>
              <span style={{ fontSize: 12 }}>{v.name}</span>
              <span className="mono dimmer" style={{ fontSize: 11, marginLeft: 'auto' }}>{v.uptime}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Cloudflare Tunnel */}
      <div className="card overview-card">
        <div className="card-h">
          <h3>Cloudflare Tunnel</h3>
          <span className="badge ok"><span className="dot ok"/> HEALTHY</span>
        </div>
        <div className="ov-rows">
          <div className="ov-row"><span className="dim">Connections</span><Num value="4" unit="active" size="md"/></div>
          <div className="ov-row"><span className="dim">Region</span><span className="mono" style={{ fontSize: 13 }}>FRA · AMS · DUS · WAW</span></div>
          <div className="ov-row"><span className="dim">WAN-IP</span><span className="mono" style={{ fontSize: 13, color: 'var(--text-1)' }}>84.158.213.42</span></div>
          <div className="ov-row"><span className="dim">cloudflared</span><span className="mono dim" style={{ fontSize: 12 }}>2025.10.1</span></div>
        </div>
      </div>

      {/* Backup */}
      <div className="card overview-card">
        <div className="card-h">
          <h3>Backup (PBS)</h3>
          <span className="badge ok"><span className="dot ok"/> 5/5 TONIGHT</span>
        </div>
        <div className="ov-rows">
          <div className="ov-row"><span className="dim">Last successful</span><span className="mono" style={{ fontSize: 13 }}>02:01 · vor 4h</span></div>
          <div className="ov-row"><span className="dim">Datastore</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end' }}>
              <div className="bar"><div className="bar-fill" style={{ width: '54%', background: 'var(--ok)' }}/></div>
              <span className="mono" style={{ fontSize: 12 }}>54%</span>
            </div>
          </div>
          <div className="ov-row"><span className="dim">Free</span><Num value="918" unit="GB" size="md"/></div>
          <div className="ov-row"><span className="dim">Verify queue</span><span className="mono dim" style={{ fontSize: 12 }}>1 pending</span></div>
        </div>
      </div>
    </div>
  );
}

// ----- Service tile -----
function ServiceTile({ svc, status, sparks, onClick, showSpark }) {
  return (
    <button className={`svc-tile status-${status.status}`} onClick={onClick}>
      <div className="svc-head">
        <span className="svc-icon">{ICONS[svc.icon]}</span>
        <div className="svc-name">
          <span className="svc-title">{svc.name}</span>
          <span className="svc-sub mono">{svc.sub}</span>
        </div>
        <Dot status={status.status}/>
      </div>
      <div className="svc-mid">
        {showSpark && <Sparkline data={sparks} color={status.status==='warn'?'var(--warn)':status.status==='err'?'var(--err)':'var(--accent)'} width={140} height={26}/>}
      </div>
      <div className="svc-foot">
        <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{Math.round(status.ms)}<span className="dimmer" style={{fontSize:10, marginLeft:2}}>ms</span></span>
        <div className="svc-reach">
          <span className={`reach ${status.ext?'ok':'off'}`} title={`Extern ${status.ext?'erreichbar':'nicht erreichbar'}`}>EXT</span>
          <span className={`reach ${status.int?'ok':'off'}`} title={`Intern ${status.int?'erreichbar':'nicht erreichbar'}`}>INT</span>
        </div>
      </div>
    </button>
  );
}

// ----- Service grid -----
function ServiceGrid({ services, statuses, sparks, onSelect, showSpark }) {
  return (
    <section className="dash-section">
      <div className="section-head">
        <h2>Services <span className="dim">· {services.length}</span></h2>
        <div className="section-tools">
          <span className="dimmer mono" style={{ fontSize: 11 }}>Antwortzeit · letzte 60 min</span>
        </div>
      </div>
      <div className="svc-grid">
        {services.map(svc => (
          <ServiceTile key={svc.id} svc={svc} status={statuses[svc.id]} sparks={sparks[svc.id]} onClick={() => onSelect(svc.id)} showSpark={showSpark}/>
        ))}
      </div>
    </section>
  );
}

// ----- VM Table -----
function VMTable({ vms, onLogs, onRestart }) {
  const [sort, setSort] = useState({ key: 'id', dir: 'asc' });
  const [filter, setFilter] = useState('');
  const sorted = useMemo(() => {
    const f = filter.trim().toLowerCase();
    let arr = vms.filter(v => !f || v.name.includes(f) || v.service.toLowerCase().includes(f) || String(v.id).includes(f) || v.ip.includes(f));
    arr = [...arr].sort((a, b) => {
      const va = a[sort.key], vb = b[sort.key];
      if (va < vb) return sort.dir === 'asc' ? -1 : 1;
      if (va > vb) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [vms, sort, filter]);
  const toggle = (k) => setSort(s => ({ key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : 'asc' }));
  const Th = ({ k, children, align }) => (
    <th onClick={() => toggle(k)} style={{ textAlign: align || 'left', cursor: 'pointer' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {children}
        {sort.key === k && <span style={{ fontSize: 9, opacity: 0.6 }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
      </span>
    </th>
  );
  return (
    <section className="dash-section">
      <div className="section-head">
        <h2>Container & VMs <span className="dim">· {vms.length}</span></h2>
        <div className="section-tools">
          <input className="input" placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 180 }}/>
          <button className="btn">Bulk Actions</button>
        </div>
      </div>
      <div className="card flat" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="vm-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <Th k="id">ID</Th>
              <Th k="name">Name</Th>
              <th>Type</th>
              <Th k="ip">IP</Th>
              <th>Service</th>
              <Th k="cpu" align="right">CPU</Th>
              <Th k="ram" align="right">RAM</Th>
              <Th k="uptime" align="right">Uptime</Th>
              <th style={{ width: 90, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(v => (
              <tr key={v.id}>
                <td><Dot status={v.status}/></td>
                <td className="mono dim">{v.id}</td>
                <td style={{ fontWeight: 600 }}>{v.name}</td>
                <td><span className={`type-pill type-${v.type.toLowerCase()}`}>{v.type}</span></td>
                <td className="mono">{v.ip}</td>
                <td className="dim">{v.service}</td>
                <td style={{ textAlign: 'right' }}>
                  <div className="cell-bar">
                    <div className="bar"><div className="bar-fill" style={{ width: `${v.cpu}%`, background: v.cpu>80?'var(--err)':v.cpu>60?'var(--warn)':'var(--ok)' }}/></div>
                    <span className="mono" style={{ fontSize: 12, width: 32, textAlign: 'right' }}>{v.cpu}%</span>
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div className="cell-bar">
                    <div className="bar"><div className="bar-fill" style={{ width: `${v.ram}%`, background: v.ram>80?'var(--err)':v.ram>60?'var(--warn)':'var(--ok)' }}/></div>
                    <span className="mono" style={{ fontSize: 12, width: 32, textAlign: 'right' }}>{v.ram}%</span>
                  </div>
                </td>
                <td className="mono dim" style={{ textAlign: 'right' }}>{v.uptime}</td>
                <td style={{ textAlign: 'right' }}>
                  <div className="row-actions">
                    <button className="btn icon" title="Logs" onClick={() => onLogs(v)}>{ICONS.logs}</button>
                    <button className="btn icon danger" title="Restart" onClick={() => onRestart(v)}>{ICONS.restart}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ----- Network Panel -----
function NetworkPanel({ up, down }) {
  const w = 600, h = 120;
  const renderArea = (data, color, fill) => {
    const max = Math.max(...up, ...down) * 1.15;
    const stepX = w / (data.length - 1);
    const pts = data.map((v, i) => [i * stepX, h - (v / max) * (h - 8) - 4]);
    const path = pts.map(([x,y], i) => `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${path} L${w},${h} L0,${h} Z`;
    return (
      <>
        <path d={area} fill={fill}/>
        <path d={path} fill="none" stroke={color} strokeWidth="1.4"/>
      </>
    );
  };
  return (
    <section className="dash-section">
      <div className="section-head">
        <h2>Netzwerk</h2>
        <div className="section-tools">
          <span className="dimmer mono" style={{ fontSize: 11 }}>letzte 60 min · 1 min Auflösung</span>
        </div>
      </div>
      <div className="net-grid">
        <div className="card" style={{ padding: 18, gridColumn: 'span 2' }}>
          <div className="card-h">
            <h3>WAN Throughput</h3>
            <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
              <span style={{ display:'flex', alignItems:'center', gap:6 }}><span style={{ width:8, height:8, borderRadius:2, background:'var(--info)'}}/>DOWN <span className="mono" style={{ color:'var(--text-1)', marginLeft: 4 }}>{down[down.length-1].toFixed(1)} Mbit/s</span></span>
              <span style={{ display:'flex', alignItems:'center', gap:6 }}><span style={{ width:8, height:8, borderRadius:2, background:'var(--accent)'}}/>UP <span className="mono" style={{ color:'var(--text-1)', marginLeft: 4 }}>{up[up.length-1].toFixed(1)} Mbit/s</span></span>
            </div>
          </div>
          <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 140, display: 'block' }}>
            {[0.25,0.5,0.75].map(f => <line key={f} x1="0" x2={w} y1={h*f} y2={h*f} stroke="var(--border)" strokeWidth="1" strokeDasharray="2 4"/>)}
            {renderArea(down, 'var(--info)', 'var(--info-soft)')}
            {renderArea(up, 'var(--accent)', 'var(--accent-soft)')}
          </svg>
        </div>

        <div className="card">
          <div className="card-h"><h3>WAN & DDNS</h3><span className="badge ok"><span className="dot ok"/> SYNC</span></div>
          <div className="ov-rows">
            <div className="ov-row"><span className="dim">Public IP</span><span className="mono" style={{ fontSize: 13 }}>84.158.213.42</span></div>
            <div className="ov-row"><span className="dim">home.rxf-sys.de</span><span className="mono ok-text" style={{ fontSize: 12, color: 'var(--ok)' }}>aktuell · 2 min</span></div>
            <div className="ov-row"><span className="dim">ISP</span><span style={{ fontSize: 13 }}>Deutsche Glasfaser</span></div>
            <div className="ov-row"><span className="dim">Link</span><Num value="1000/200" unit="Mbit" size="md"/></div>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>UniFi Clients</h3><span className="dimmer mono" style={{ fontSize: 11 }}>{NETWORKS.reduce((a,n)=>a+n.clients,0)} total</span></div>
          <div className="net-rows">
            {NETWORKS.map(n => (
              <div key={n.name} className="net-row">
                <span className="net-dot" style={{ background: n.color }}/>
                <span style={{ fontSize: 13 }}>{n.name}</span>
                <span className="mono dim" style={{ fontSize: 11 }}>VLAN {n.vlan}</span>
                <span className="mono" style={{ fontSize: 13, marginLeft: 'auto', fontWeight: 600 }}>{n.clients}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ----- Backups + Certs -----
function BackupsCerts() {
  const certColor = (d) => d < 14 ? 'var(--err)' : d < 30 ? 'var(--warn)' : 'var(--ok)';
  return (
    <section className="dash-section">
      <div className="bc-grid">
        <div className="card">
          <div className="card-h">
            <h3>PBS Jobs <span className="dim" style={{ fontWeight: 400, textTransform:'none' }}>· letzte 10</span></h3>
            <button className="btn">View all</button>
          </div>
          <div className="job-list">
            {PBS_JOBS.map(j => (
              <div key={j.id} className="job-row">
                <Dot status={j.status}/>
                <div className="job-target">
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{j.target}</span>
                  <span className="mono dimmer" style={{ fontSize: 11 }}>{j.id}</span>
                </div>
                <span className="mono dim" style={{ fontSize: 12, width: 70, textAlign: 'right' }}>{j.size}</span>
                <span className={`verify ${j.verify==='ok'?'ok':j.verify==='pending'?'warn':'idle'}`}>
                  {j.verify === 'ok' && ICONS.check}
                  {j.verify === 'pending' && <span className="mono" style={{fontSize:10}}>···</span>}
                  {j.verify === '—' && <span className="dimmer">—</span>}
                  <span style={{ fontSize: 11, marginLeft: 4 }}>{j.verify === 'ok' ? 'verified' : j.verify === 'pending' ? 'pending' : '—'}</span>
                </span>
                <span className="mono dim" style={{ fontSize: 11, width: 80, textAlign: 'right' }}>{j.when}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>SSL Certs <span className="dim" style={{ fontWeight: 400, textTransform:'none' }}>· Cloudflare Edge</span></h3>
            <button className="btn">Manage</button>
          </div>
          <table className="cert-table">
            <thead>
              <tr><th>Domain</th><th>Issuer</th><th style={{ textAlign: 'right' }}>Days left</th></tr>
            </thead>
            <tbody>
              {CERTS.map(c => (
                <tr key={c.domain}>
                  <td className="mono" style={{ fontSize: 13 }}>{c.domain}</td>
                  <td className="dim" style={{ fontSize: 12 }}>{c.issuer}</td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="mono" style={{ color: certColor(c.daysLeft), fontWeight: 600 }}>{c.daysLeft}d</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { Header, OverviewCards, ServiceGrid, ServiceTile, VMTable, NetworkPanel, BackupsCerts });
