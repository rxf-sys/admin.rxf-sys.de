/* App shell — wires header, sections, drawer, modal, toasts, simulation */

function useSimulation({ enabled, statuses, sparks, netUp, netDown, setStatuses, setSparks, setNetUp, setNetDown, pushToast }) {
  useEffect(() => {
    if (!enabled) return;
    const tick = setInterval(() => {
      // Sparkline tick
      setSparks(prev => {
        const next = {};
        for (const id of Object.keys(prev)) {
          const arr = prev[id];
          const last = arr[arr.length - 1];
          const target = INITIAL_STATUS[id].ms;
          const drift = (target - last) * 0.15 + (Math.random() - 0.5) * target * 0.25;
          const v = Math.max(8, last + drift);
          next[id] = [...arr.slice(1), v];
        }
        return next;
      });
      // Network tick
      setNetUp(prev => [...prev.slice(1), Math.max(2, prev[prev.length-1] + (Math.random() - 0.5) * 6)]);
      setNetDown(prev => [...prev.slice(1), Math.max(8, prev[prev.length-1] + (Math.random() - 0.5) * 14)]);

      // Update status ms
      setStatuses(prev => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          // pull from latest spark — done via sparks state, but simpler: jitter
          next[id] = { ...next[id], ms: Math.max(8, next[id].ms + (Math.random() - 0.5) * 30) };
        }
        return next;
      });
    }, 2000);

    // Status change toast simulation
    const eventTimers = [];
    eventTimers.push(setTimeout(() => {
      pushToast({ level: 'err', title: 'photos · DOWN', body: 'HTTP 503 — Connection refused', time: 'now' });
      setStatuses(prev => ({ ...prev, photos: { ...prev.photos, status: 'err', ms: 0 } }));
    }, 9000));
    eventTimers.push(setTimeout(() => {
      pushToast({ level: 'ok', title: 'photos · RECOVERED', body: 'Service is back · 142ms', time: 'now' });
      setStatuses(prev => ({ ...prev, photos: { ...prev.photos, status: 'ok', ms: 142 } }));
    }, 18000));
    eventTimers.push(setTimeout(() => {
      pushToast({ level: 'warn', title: 'media · degraded', body: 'p95 response 380ms (jellyfin transcode)', time: 'now' });
    }, 26000));

    return () => { clearInterval(tick); eventTimers.forEach(clearTimeout); };
  }, [enabled]);
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(1);
  const push = (t) => {
    const id = idRef.current++;
    setToasts(s => [...s, { id, ...t }]);
    setTimeout(() => setToasts(s => s.filter(x => x.id !== id)), 4500);
  };
  return [toasts, push];
}

function FullDashboard({ mobile }) {
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "theme": "dark",
    "accent": "peach",
    "density": "compact",
    "showSparklines": true,
    "liveSimulation": true,
    "showSection_overview": true,
    "showSection_services": true,
    "showSection_vms": true,
    "showSection_network": true,
    "showSection_backups": true
  }/*EDITMODE-END*/;
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const [statuses, setStatuses] = useState(INITIAL_STATUS);
  const [sparks, setSparks] = useState(INITIAL_SPARKS);
  const [netUp, setNetUp] = useState(INITIAL_NET_UP);
  const [netDown, setNetDown] = useState(INITIAL_NET_DOWN);
  const [selectedSvc, setSelectedSvc] = useState(null);
  const [confirmVm, setConfirmVm] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState('06:42:17');
  const [toasts, pushToast] = useToasts();

  useSimulation({
    enabled: tweaks.liveSimulation && !mobile,
    statuses, sparks, netUp, netDown,
    setStatuses, setSparks, setNetUp, setNetDown, pushToast,
  });

  const onRefresh = () => {
    setRefreshing(true);
    setTimeout(() => {
      const d = new Date();
      setLastRefresh(`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`);
      setRefreshing(false);
    }, 800);
  };

  const onLogs = (vm) => pushToast({ level: 'ok', title: `Logs für ${vm.name}`, body: 'Wird geöffnet…', time: 'now' });
  const onRestart = (vm) => setConfirmVm(vm);
  const confirmRestart = () => {
    pushToast({ level: 'warn', title: `${confirmVm.name} restarting`, body: `Container ${confirmVm.id} wird neu gestartet`, time: 'now' });
    setConfirmVm(null);
    setTimeout(() => pushToast({ level: 'ok', title: `${confirmVm?.name || 'Service'} restarted`, body: 'Service ist wieder online', time: 'now' }), 3000);
  };

  const servicesUp = SERVICES.filter(s => statuses[s.id].status === 'ok').length;
  const svc = selectedSvc ? SERVICES.find(s => s.id === selectedSvc) : null;

  return (
    <div className={`dashboard ${mobile ? 'mobile-dashboard' : ''}`}
         data-theme={tweaks.theme} data-accent={tweaks.accent} data-density={tweaks.density}>
      <Header
        servicesUp={servicesUp}
        servicesTotal={SERVICES.length}
        lastRefresh={lastRefresh}
        onRefresh={onRefresh}
        refreshing={refreshing}
        theme={tweaks.theme}
        onTheme={() => setTweak('theme', tweaks.theme === 'dark' ? 'light' : 'dark')}
        email="robin@rxf-sys.de"
        accent={tweaks.accent}
        onAccent={(a) => setTweak('accent', a)}
      />
      <main className="dash-main">
        {tweaks.showSection_overview && <OverviewCards services={SERVICES} vms={VMS} statuses={statuses}/>}
        {tweaks.showSection_services && <ServiceGrid services={SERVICES} statuses={statuses} sparks={sparks} onSelect={setSelectedSvc} showSpark={tweaks.showSparklines}/>}
        {tweaks.showSection_vms && <VMTable vms={VMS} onLogs={onLogs} onRestart={onRestart}/>}
        {tweaks.showSection_network && <NetworkPanel up={netUp} down={netDown}/>}
        {tweaks.showSection_backups && <BackupsCerts/>}
      </main>

      <Drawer open={!!svc} svc={svc} status={svc?statuses[svc.id]:null} sparks={svc?sparks[svc.id]:[]} onClose={() => setSelectedSvc(null)} vms={VMS}/>
      <ConfirmModal open={!!confirmVm} vm={confirmVm} onConfirm={confirmRestart} onCancel={() => setConfirmVm(null)}/>
      <Toasts toasts={toasts}/>

      {!mobile && (
        <TweaksPanel title="Tweaks" defaultPos={{ right: 20, bottom: 20 }}>
          <TweakSection label="Appearance">
            <TweakRadio label="Theme" value={tweaks.theme} onChange={v=>setTweak('theme',v)} options={[{value:'dark',label:'Dark'},{value:'light',label:'Light'}]}/>
            <TweakRadio label="Density" value={tweaks.density} onChange={v=>setTweak('density',v)} options={[{value:'compact',label:'Compact'},{value:'cozy',label:'Cozy'}]}/>
            <TweakSelect label="Accent" value={tweaks.accent} onChange={v=>setTweak('accent',v)} options={[{value:'peach',label:'Peach (Brand)'},{value:'indigo',label:'Indigo'},{value:'cyan',label:'Cyan-Blau'},{value:'green',label:'Grün'}]}/>
          </TweakSection>
          <TweakSection label="Behavior">
            <TweakToggle label="Live simulation" value={tweaks.liveSimulation} onChange={v=>setTweak('liveSimulation',v)}/>
            <TweakToggle label="Sparklines" value={tweaks.showSparklines} onChange={v=>setTweak('showSparklines',v)}/>
          </TweakSection>
          <TweakSection label="Sections">
            <TweakToggle label="Overview" value={tweaks.showSection_overview} onChange={v=>setTweak('showSection_overview',v)}/>
            <TweakToggle label="Services" value={tweaks.showSection_services} onChange={v=>setTweak('showSection_services',v)}/>
            <TweakToggle label="Container/VMs" value={tweaks.showSection_vms} onChange={v=>setTweak('showSection_vms',v)}/>
            <TweakToggle label="Network" value={tweaks.showSection_network} onChange={v=>setTweak('showSection_network',v)}/>
            <TweakToggle label="Backups & Certs" value={tweaks.showSection_backups} onChange={v=>setTweak('showSection_backups',v)}/>
          </TweakSection>
        </TweaksPanel>
      )}
    </div>
  );
}

// ----- Showcase -----
function Showcase() {
  const [demoStatus, setDemoStatus] = useState('ok');
  const sample = INITIAL_SPARKS.cloud;
  return (
    <div className="showcase-grid" data-theme="dark" data-accent="peach">
      <div className="showcase-item">
        <div className="showcase-label">Service Tile · Default</div>
        <div style={{ width: 280 }}>
          <ServiceTile svc={SERVICES[1]} status={INITIAL_STATUS.cloud} sparks={INITIAL_SPARKS.cloud} onClick={()=>{}} showSpark={true}/>
        </div>
      </div>
      <div className="showcase-item">
        <div className="showcase-label">Service Tile · Warning</div>
        <div style={{ width: 280 }}>
          <ServiceTile svc={SERVICES[4]} status={INITIAL_STATUS.media} sparks={INITIAL_SPARKS.media} onClick={()=>{}} showSpark={true}/>
        </div>
      </div>
      <div className="showcase-item">
        <div className="showcase-label">Status Indicators</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Dot status="ok"/> <span style={{ fontSize: 13 }}>Operational</span></span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Dot status="warn"/> <span style={{ fontSize: 13 }}>Degraded</span></span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Dot status="err"/> <span style={{ fontSize: 13 }}>Down</span></span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Dot status="idle"/> <span style={{ fontSize: 13 }}>Idle</span></span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="badge ok"><span className="dot ok"/> HEALTHY</span>
            <span className="badge warn"><span className="dot warn"/> DEGRADED</span>
            <span className="badge err"><span className="dot err"/> DOWN</span>
            <span className="badge info"><span className="dot"/> INFO</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <span className="reach ok">EXT</span><span className="reach ok">INT</span>
            <span className="reach off">EXT</span><span className="reach off">INT</span>
          </div>
        </div>
      </div>

      <div className="showcase-item">
        <div className="showcase-label">Donuts · Resource Meters</div>
        <div style={{ display: 'flex', justifyContent: 'space-around' }}>
          <Donut value={28} label="CPU" sublabel="5.6 / 20"/>
          <Donut value={72} label="RAM" sublabel="46 / 64 GB"/>
          <Donut value={91} label="DISK" sublabel="3.6 / 4 TB"/>
        </div>
      </div>

      <div className="showcase-item" style={{ gridColumn: 'span 2' }}>
        <div className="showcase-label">Sparklines · 60 min response time</div>
        <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
          <div><Sparkline data={sample} color="var(--accent)" width={180} height={32}/><div className="mono dimmer" style={{ fontSize: 10, marginTop: 4 }}>118ms · accent</div></div>
          <div><Sparkline data={INITIAL_SPARKS.media} color="var(--warn)" width={180} height={32}/><div className="mono dimmer" style={{ fontSize: 10, marginTop: 4 }}>312ms · warn</div></div>
          <div><Sparkline data={INITIAL_SPARKS.vault} color="var(--ok)" width={180} height={32}/><div className="mono dimmer" style={{ fontSize: 10, marginTop: 4 }}>42ms · ok</div></div>
        </div>
      </div>

      <div className="showcase-item">
        <div className="showcase-label">Buttons</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary">Primary Action</button>
          <button className="btn">Secondary</button>
          <button className="btn danger">Danger</button>
          <button className="btn icon">{ICONS.refresh}</button>
          <button className="btn icon">{ICONS.logs}</button>
        </div>
      </div>

      <div className="showcase-item">
        <div className="showcase-label">Inputs</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input className="input" placeholder="Filter…"/>
          <input className="input" defaultValue="vault.rxf-sys.de"/>
        </div>
      </div>

      <div className="showcase-item" style={{ gridColumn: 'span 2' }}>
        <div className="showcase-label">Loading & Empty States</div>
        <div style={{ display: 'flex', gap: 22 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="skel" style={{ height: 14, width: '40%' }}/>
            <div className="skel" style={{ height: 12, width: '70%' }}/>
            <div className="skel" style={{ height: 12, width: '55%' }}/>
            <div className="skel" style={{ height: 28, width: '90%', marginTop: 6 }}/>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', justifyContent: 'center', padding: 20, border: '1px dashed var(--border-2)', borderRadius: 8, color: 'var(--text-3)' }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-4)' }}>{ICONS.warn}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>Keine Daten</div>
            <div style={{ fontSize: 11 }}>Prometheus liefert keine Werte für die letzten 60 min.</div>
          </div>
        </div>
      </div>

      <div className="showcase-item" style={{ gridColumn: 'span 2' }}>
        <div className="showcase-label">Toasts</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 380 }}>
          <div className="toast toast-ok"><span className="toast-icon">{ICONS.check}</span><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600 }}>photos · RECOVERED</div><div style={{ fontSize: 12, color: 'var(--text-3)' }}>Service is back · 142ms</div></div><span className="mono dimmer" style={{ fontSize: 10 }}>now</span></div>
          <div className="toast toast-warn"><span className="toast-icon">{ICONS.warn}</span><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600 }}>media · degraded</div><div style={{ fontSize: 12, color: 'var(--text-3)' }}>p95 response 380ms</div></div><span className="mono dimmer" style={{ fontSize: 10 }}>2m</span></div>
          <div className="toast toast-err"><span className="toast-icon">{ICONS.x}</span><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600 }}>photos · DOWN</div><div style={{ fontSize: 12, color: 'var(--text-3)' }}>HTTP 503 — Connection refused</div></div><span className="mono dimmer" style={{ fontSize: 10 }}>now</span></div>
        </div>
      </div>
    </div>
  );
}

// ----- Tokens artboard -----
function TokensDoc() {
  const colors = [
    ['--bg-0', '#0a0d14', 'Page background'],
    ['--bg-1', '#0f1119', 'Surface base'],
    ['--surface-2', '#1a1d2e', 'Card'],
    ['--surface-3', '#22253a', 'Hover / input'],
    ['--surface-4', '#2a2d3e', 'Elevated'],
    ['--border', '#262a3d', 'Subtle divider'],
    ['--border-2', '#3a3d4e', 'Strong divider'],
    ['--text-1', '#f0f1f5', 'Primary'],
    ['--text-2', '#c5cad6', 'Secondary'],
    ['--text-3', '#8a8f9d', 'Muted'],
    ['--text-4', '#5a5f70', 'Disabled'],
  ];
  const brand = [
    ['--indigo', '#424769', 'RF primary'],
    ['--navy', '#2d3250', 'RF secondary'],
    ['--peach', '#ffb17a', 'RF accent · default'],
    ['--peach-2', '#ffd6b1', 'Logo gradient stop'],
  ];
  const status = [
    ['--ok', '#00d97e', 'Success / healthy'],
    ['--warn', '#ffb020', 'Warning / degraded'],
    ['--err', '#ff4757', 'Error / down'],
    ['--info', '#4f9eff', 'Info / neutral hl'],
  ];
  const Sw = ([name, hex, role]) => (
    <div className="tok-swatch" key={name}>
      <div className="tok-chip" style={{ background: hex }}/>
      <div className="tok-name">{name}</div>
      <div className="tok-val">{hex} · {role}</div>
    </div>
  );
  return (
    <div className="tokens-doc" data-theme="dark">
      <h1>rxf-sys admin · Design Tokens</h1>
      <p className="lead mono">v1.0 · adapted from Robin Frank Design System for admin/data-density context</p>

      <h2>Surface & Text</h2>
      <div className="tok-grid">{colors.map(Sw)}</div>

      <h2>Brand</h2>
      <div className="tok-grid">{brand.map(Sw)}</div>

      <h2>Status</h2>
      <div className="tok-grid">{status.map(Sw)}</div>

      <h2>Brand gradient (signature)</h2>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div style={{ width: 220, height: 50, borderRadius: 6, background: 'var(--grad-brand)' }}/>
        <code className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>linear-gradient(135deg, #424769, #ffb17a)</code>
      </div>

      <h2>Type</h2>
      <table className="tok-table">
        <tbody>
          <tr><td>--font-sans</td><td>'Inter', 'Segoe UI', system-ui, sans-serif</td></tr>
          <tr><td>--font-mono</td><td>'JetBrains Mono', 'SF Mono', Menlo, monospace</td></tr>
          <tr><td>--fs-12 → --fs-2xl</td><td>11 / 12 / 13 / 14 / 15 / 16 / 18 / 22 / 28</td></tr>
        </tbody>
      </table>

      <h2>Spacing & Radius</h2>
      <table className="tok-table">
        <tbody>
          <tr><td>--sp-0..6</td><td>4 / 8 / 12 / 16 / 20 / 24 / 32</td></tr>
          <tr><td>--r-1..4</td><td>4 / 6 / 8 / 12 px</td></tr>
          <tr><td>--r-pill</td><td>999px</td></tr>
          <tr><td>--row-h (compact)</td><td>32px · cozy → 40px</td></tr>
        </tbody>
      </table>

      <h2>Motion</h2>
      <table className="tok-table">
        <tbody>
          <tr><td>--t-fast</td><td>120ms ease — hover, focus</td></tr>
          <tr><td>--t-med</td><td>200ms ease — drawer, modal</td></tr>
          <tr><td>—</td><td>Keine Animation länger als 200ms (per Brief)</td></tr>
        </tbody>
      </table>

      <h2>Komplettes CSS</h2>
      <pre className="tok-pre">{`/* Drop in :root, override per [data-theme], [data-accent], [data-density] */
:root {
  --bg-0: #0a0d14;
  --bg-1: #0f1119;
  --surface-2: #1a1d2e;
  --surface-3: #22253a;
  --surface-4: #2a2d3e;
  --border: #262a3d;
  --border-2: #3a3d4e;

  --text-1: #f0f1f5;
  --text-2: #c5cad6;
  --text-3: #8a8f9d;
  --text-4: #5a5f70;

  --indigo: #424769;
  --navy:   #2d3250;
  --peach:  #ffb17a;
  --accent: var(--peach);

  --ok:   #00d97e;
  --warn: #ffb020;
  --err:  #ff4757;
  --info: #4f9eff;

  --grad-brand: linear-gradient(135deg, #424769, #ffb17a);

  --font-sans: 'Inter','Segoe UI',system-ui,sans-serif;
  --font-mono: 'JetBrains Mono','SF Mono',Menlo,monospace;

  --r-1: 4px; --r-2: 6px; --r-3: 8px; --r-4: 12px; --r-pill: 999px;
  --t-fast: 120ms ease; --t-med: 200ms ease;
}`}</pre>
    </div>
  );
}

Object.assign(window, { FullDashboard, Showcase, TokensDoc, useToasts, useSimulation });
