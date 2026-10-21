/* rxf-sys admin v2 – clickable preview (vanilla JS, hash routing, no dependencies). */
(function () {
  'use strict';
  const I = window.icon;
  const DATA = window.PREVIEW_DATA;
  const qs = new URLSearchParams(location.search);
  const NOW = new Date('2026-10-18T12:00:00+02:00');

  const state = {
    data: qs.get('data') || 'demo',
    theme: qs.get('theme') || document.documentElement.getAttribute('data-theme') || 'system',
    chrome: qs.get('chrome') !== '0',
    loginState: qs.get('login') || 'normal',
    card: qs.get('card') || 'calm',
    catalogView: qs.get('cat') || 'grid',
    edit: false,
    board: 'overview',
    layout: null,
    undo: [], redo: [],
    grabbed: null,
    catalogFilter: 'Alle', catalogQuery: '',
    selected: new Set(['proxmox-ve', 'proxmox-backup-server', 'cloudflare', 'uptime', 'unifi-network']),
    template: 'overview',
    table: { q: '', type: 'Alle', status: 'Alle', sort: 'vmid', dir: 'asc', page: 0 },
    connect: { tested: false, trusted: false, error: false },
    perms: { 'proxmox-ve': 'actions' },
    navOpen: false,
    chartTable: {},
    haCoffee: null,
  };

  /* ---------- helpers ---------- */
  const D = () => DATA[state.data] || DATA.demo;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('de-DE');
  const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  const pct = (v) => (v == null || isNaN(v) ? 'k. A.' : new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 0 }).format(v));
  const compact = (v) => {
    const a = Math.abs(v);
    if (a >= 1e9) return nf1.format(v / 1e9) + ' Mrd.';
    if (a >= 1e6) return nf1.format(v / 1e6) + ' Mio.';
    if (a >= 1e4) return nf1.format(v / 1e3) + ' Tsd.';
    return nf.format(Math.round(v));
  };
  const bytes = (b) => {
    if (b == null || isNaN(b)) return 'k. A.';
    const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return nf1.format(v) + ' ' + u[i];
  };
  const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
  const ago = (min) => {
    if (min == null) return 'unbekannt';
    if (min < 1) return 'gerade eben';
    if (min < 60) return rtf.format(-Math.round(min), 'minute');
    if (min < 1440) return rtf.format(-Math.round(min / 60), 'hour');
    if (min < 10080) return rtf.format(-Math.round(min / 1440), 'day');
    return 'seit ' + new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(NOW - min * 60000));
  };
  const dur = (s) => {
    if (s == null) return 'k. A.';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' h';
    return nf.format(Math.floor(s / 86400)) + ' d';
  };
  const plural = (n, one, many) => nf.format(n) + ' ' + (n === 1 ? one : many);
  const SEV = {
    ok: { icon: 'ok', label: 'OK' }, warn: { icon: 'warn', label: 'Warnung' }, crit: { icon: 'crit', label: 'Kritisch' },
    unknown: { icon: 'unknown', label: 'Unbekannt' }, paused: { icon: 'paused', label: 'Pausiert' }, off: { icon: 'stop', label: 'Aus' },
  };
  const statusEl = (sev, label) => '<span class="status status-' + sev + '" title="' + esc(label || SEV[sev].label) + '">' + I(SEV[sev].icon) + '<span>' + esc(label || SEV[sev].label) + '</span></span>';
  const badge = (sev, label) => '<span class="badge badge-' + sev + '">' + I(SEV[sev].icon) + esc(label || SEV[sev].label) + '</span>';
  const guestStatus = (s) => ({ running: ['ok', 'läuft'], stopped: ['off', 'gestoppt'], paused: ['paused', 'pausiert'], unknown: ['unknown', 'unbekannt'] }[s] || ['unknown', 'unbekannt']);
  const pluginById = (id) => D().catalog.find((p) => p.id === id) || { name: id, mono: '?' };
  const PLUGIN_ICON = { 'proxmox-ve': 'server', 'proxmox-backup-server': 'backup', 'unifi-network': 'network', fritzbox: 'router', cloudflare: 'cloud', uptime: 'pulse', docker: 'container', tailscale: 'tailnet', pihole: 'shield', 'adguard-home': 'shield', 'home-assistant': 'home' };
  const announce = (msg) => { const el = document.getElementById('live'); el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30); };
  const go = (hash) => { location.hash = hash; };
  const MARK = '<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><rect fill="#1C2125" width="64" height="64" rx="15"/><path fill="#F4F5F2" transform="translate(5.06 38.12) scale(0.0232)" d="M60 0V-528H242L257 -442H266Q285 -477 312 -499Q339 -521 370 -531Q401 -541 432 -541Q454 -541 472 -538Q491 -535 509 -528V-362H406Q375 -362 352 -352Q329 -343 314 -326Q299 -310 292 -288Q284 -265 284 -238V0ZM519 0 780 -280 544 -528H828L941 -396H946L1059 -528H1326L1086 -275L1341 0H1059L926 -158H921L787 0ZM1469 0V-387H1354V-528H1469V-542Q1469 -613 1498 -656Q1528 -698 1580 -718Q1632 -737 1697 -737Q1720 -737 1749 -734Q1778 -732 1806 -728Q1835 -724 1857 -719V-596H1793Q1735 -596 1714 -584Q1693 -573 1693 -543V-528H1857V-387H1693V0Z"/><rect fill="#FFC21A" x="50.55" y="25.88" width="7.00" height="12.25" rx="0.8"/></svg>';

  /* ---------- theme ---------- */
  function applyTheme() {
    const root = document.documentElement;
    if (state.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', state.theme);
  }

  /* ---------- routing ---------- */
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const parts = h.split('/').filter(Boolean);
    return { path: h, parts };
  }

  /* ---------- widgets ---------- */
  const WIDGETS = {
    attention: { title: 'Was braucht Aufmerksamkeit', plugin: null, icon: 'bell', sizes: ['M', 'L', 'XL'], def: 'L' },
    status: { title: 'Status gesamt', plugin: null, icon: 'dashboard', sizes: ['S', 'M'], def: 'S' },
    'pve-node': { title: 'Knotenauslastung', plugin: 'proxmox-ve', sizes: ['S', 'M'], def: 'S' },
    'pve-guests': { title: 'Gäste-Status', plugin: 'proxmox-ve', sizes: ['S', 'M'], def: 'S' },
    'pve-storage': { title: 'Speicherbelegung', plugin: 'proxmox-ve', sizes: ['M', 'L', 'XL'], def: 'M' },
    'pbs-overdue': { title: 'Backups: was ist überfällig', plugin: 'proxmox-backup-server', sizes: ['M', 'L', 'XL'], def: 'M' },
    'uptime-grid': { title: 'Dienste', plugin: 'uptime', sizes: ['M', 'L', 'XL'], def: 'M' },
    'cf-tunnel': { title: 'Tunnel', plugin: 'cloudflare', sizes: ['S', 'M'], def: 'S' },
    'cf-traffic': { title: 'Traffic, 24 Stunden', plugin: 'cloudflare', sizes: ['M', 'L', 'XL'], def: 'M' },
    'unifi-wan': { title: 'Internet (WAN)', plugin: 'unifi-network', sizes: ['S', 'M'], def: 'S' },
    'unifi-clients': { title: 'Clients je Access Point', plugin: 'unifi-network', sizes: ['M', 'L'], def: 'M' },
    'docker-summary': { title: 'Container', plugin: 'docker', sizes: ['S', 'M'], def: 'S' },
    fritz: { title: 'FRITZ!Box Internet', plugin: 'fritzbox', sizes: ['S', 'M'], def: 'S' },
    ha: { title: 'Wohnzimmer', plugin: 'home-assistant', sizes: ['M', 'L'], def: 'M' },
    'pve-cpu': { title: 'CPU-Last rxf-sys', plugin: 'proxmox-ve', sizes: ['M', 'L', 'XL'], def: 'M' },
    'tailscale': { title: 'Tailnet', plugin: 'tailscale', sizes: ['S', 'M'], def: 'S' },
  };
  const TEMPLATES = {
    overview: ['attention', 'status', 'pve-guests', 'cf-tunnel', 'unifi-wan', 'fritz', 'docker-summary', 'pve-storage', 'pbs-overdue', 'uptime-grid', 'cf-traffic', 'unifi-clients', 'ha', 'pve-cpu', 'pve-node', 'tailscale'],
    network: ['attention', 'unifi-wan', 'cf-tunnel', 'tailscale', 'fritz', 'status', 'docker-summary', 'unifi-clients', 'cf-traffic', 'uptime-grid'],
    empty: [],
  };
  const layoutFrom = (ids) => ids.map((id) => ({ id, size: WIDGETS[id].def }));

  function widgetShell(w, body, opts) {
    const meta = WIDGETS[w.id];
    const o = opts || {};
    const plugin = meta.plugin ? pluginById(meta.plugin) : null;
    const updated = o.updated || 'vor 12 Sekunden';
    const chip = o.chip ? '<span class="widget-status-chip">' + o.chip + '</span>' : '';
    const tools = state.edit ? (
      '<div class="edit-tools">' + I('grip') +
      '<div class="segmented" role="group" aria-label="Größe">' + ['S', 'M', 'L', 'XL'].map((s) =>
        '<button type="button" data-action="resize" data-id="' + w.id + '" data-size="' + s + '" aria-pressed="' + (w.size === s) + '"' + (meta.sizes.includes(s) ? '' : ' disabled aria-disabled="true"') + '>' + s + '</button>').join('') + '</div>' +
      '<button class="icon-btn icon-btn-sm" type="button" data-action="remove-widget" data-id="' + w.id + '" aria-label="' + esc(meta.title) + ' entfernen">' + I('trash', 'icon-sm') + '</button></div>'
    ) : '';
    return '<article class="widget w" data-size="' + w.size + '" data-id="' + w.id + '"' + (o.state ? ' data-state="' + o.state + '"' : '') +
      (state.edit ? ' tabindex="0" draggable="true" aria-roledescription="verschiebbares Widget" aria-describedby="drag-help"' : '') +
      ' aria-labelledby="wt-' + w.id + '"' + (state.grabbed === w.id ? ' data-grabbed="true"' : '') + '>' +
      '<header class="widget-head"><span class="widget-icon">' + I(meta.icon || PLUGIN_ICON[meta.plugin] || 'info') + '</span>' +
      '<div class="widget-title"><h2 id="wt-' + w.id + '">' + esc(meta.title) + '</h2><span class="meta">' + esc(plugin ? plugin.name + ', ' : '') + updated + '</span></div>' + chip +
      (state.edit ? '' : '<button class="icon-btn icon-btn-sm" type="button" data-action="widget-menu" data-id="' + w.id + '" aria-label="Menü für ' + esc(meta.title) + '" aria-haspopup="menu">' + I('more') + '</button>') +
      '</header>' + tools + (o.banner || '') + '<div class="widget-body">' + body + '</div>' +
      '<footer class="widget-foot"><span class="src">' + I(PLUGIN_ICON[meta.plugin] || meta.icon || 'info', 'icon-sm') + esc(plugin ? plugin.name : 'Alle Plugins') + '</span><span>' + updated + '</span></footer>' +
      '</article>';
  }

  function renderWidget(w) {
    const d = D();
    if (d.loadingWidget === w.id) {
      return widgetShell(w, '<div class="ha-tiles">' + [1, 2, 3, 4].map(() => '<div class="ha-tile"><div class="skel" style="height:12px;width:60%"></div><div class="skel" style="height:22px;width:45%;margin-top:6px"></div></div>').join('') + '</div><span class="sr-only">Wird geladen</span>', { updated: 'wird geladen' });
    }
    if (d.errorWidget === w.id) {
      return widgetShell(w, '<div class="widget-empty">' + I('crit') + '<b>Daten nicht abrufbar</b><span>Cloudflare meldet: Token abgelaufen am 01.10.2026. Ersetze das Token in den Einstellungen.</span><a href="#/settings/infrastructure">Zu den Einstellungen</a></div>', { updated: 'Fehler', chip: badge('crit', 'Fehler') });
    }
    switch (w.id) {
      case 'attention': {
        const a = d.alerts;
        if (!a.length) return widgetShell(w, '<div class="widget-empty">' + I('ok') + '<b>Alles in Ordnung</b><span>Keine offenen Warnungen. Neue Probleme erscheinen hier, sortiert nach Dringlichkeit.</span></div>', { chip: badge('ok', 'Nichts offen') });
        const shown = a.slice(0, { M: 3, L: 5, XL: 4 }[w.size] || 3);
        const crit = a.filter((x) => x.sev === 'crit').length;
        return widgetShell(w, '<ul class="list attention" data-fit>' + shown.map((x) =>
          '<li><span class="sev">' + statusEl(x.sev) + '</span><div class="grow"><div class="line1">' + esc(x.title) + '</div><div class="line2">' + esc(x.detail) + '</div></div>' +
          '<div class="end">' + ago(x.since) + '<br><a href="#/p/proxmox-ve/guests">' + esc(x.action) + '</a></div></li>').join('') + '</ul>' +
          moreEl(a.length - shown.length, 'weiteres Problem', 'weitere Probleme', ' anzeigen', '#/dashboard'),
          { chip: crit ? badge('crit', crit + ' kritisch') : badge('warn', a.length + ' offen') });
      }
      case 'status': {
        const s = d.summary; const open = s.warn + s.crit;
        return widgetShell(w, '<div style="display:flex;align-items:flex-end;gap:12px"><span class="hero-figure">' + nf.format(open) + '</span><span class="muted" style="padding-bottom:6px">' + (open === 1 ? 'offenes Problem' : 'offene Probleme') + '</span></div>' +
          '<div class="chips chips-status">' + (w.size === 'S' ? ['crit', 'warn'] : ['crit', 'warn', 'ok', 'unknown', 'paused']).map((k) => statusEl(k, SEV[k].label + ' ' + nf.format(s[k]))).join('') + '</div>',
          { chip: open ? badge('crit', 'Handlungsbedarf') : badge('ok', 'Alles OK') });
      }
      case 'pve-node': {
        const n = d.pve.node; const memr = n.mem / n.maxmem;
        return widgetShell(w, meter('CPU', n.cpu) + meter(w.size === 'S' ? 'RAM' : 'RAM, ' + bytes(n.mem) + ' von ' + bytes(n.maxmem), memr) + (w.size === 'S' ? '' : meter('Root-Dateisystem', n.disk)), { chip: statusEl(n.cpu > 0.9 ? 'warn' : 'ok', n.cpu > 0.9 ? 'Hohe Last' : 'Online') });
      }
      case 'pve-guests': {
        const g = d.pve.guests; const run = g.filter((x) => x.status === 'running').length; const stop = g.filter((x) => x.status === 'stopped').length; const other = g.length - run - stop;
        if (!g.length) return widgetShell(w, '<div class="widget-empty"><span>Noch keine Gäste. Lege in Proxmox eine VM oder einen Container an.</span></div>');
        return widgetShell(w, '<div class="stat-row"><div class="stat"><span class="stat-label">Laufen</span><span class="stat-value">' + nf.format(run) + '</span></div><div class="stat"><span class="stat-label">Gestoppt</span><span class="stat-value">' + nf.format(stop) + '</span></div>' + (other && w.size !== 'S' ? '<div class="stat"><span class="stat-label">Sonstige</span><span class="stat-value">' + nf.format(other) + '</span></div>' : '') + '</div>');
      }
      case 'pve-storage': {
        const st = d.pve.storage;
        if (!st.length) return widgetShell(w, '<div class="widget-empty"><span>Kein Speicher sichtbar. Prüfe die Rolle PVEAuditor auf /storage.</span></div>');
        return widgetShell(w, '<div class="meters" data-fit>' + st.slice(0, 4).map((x) => meter(x.id + ' (' + x.type + ')', x.used, x.total ? ' von ' + bytes(x.total) : '')).join('') + '</div>' + moreEl(Math.max(0, st.length - 4), 'weiterer Speicher', 'weitere Speicher', '', '#/p/proxmox-ve/guests'), { chip: st.some((x) => x.used >= 0.85) ? badge('warn', 'Fast voll') : statusEl('ok') });
      }
      case 'pbs-overdue': {
        const o = d.pbs.overdue; const bad = o.filter((x) => x.sev !== 'ok');
        const body = (o.length ? '<ul class="list" data-fit>' + o.slice(0, 4).map((x) => '<li>' + statusEl(x.sev, x.sev === 'ok' ? 'Aktuell' : 'Überfällig') + '<div class="grow truncate"><span class="line1">' + esc(x.name || 'ohne Namen') + '</span> <span class="mono faint">' + esc(x.id) + '</span></div><span class="end">' + esc(x.last) + '</span></li>').join('') + '</ul>' : '<div class="widget-empty">' + I('ok') + '<b>Nichts überfällig</b></div>') +
          (o.length ? moreEl(Math.max(0, o.length - 4), 'weitere Gruppe', 'weitere Gruppen', '') : '') +
          meter('Datastore ' + d.pbs.store + ', Prognose voll: ' + d.pbs.fullAt, d.pbs.used);
        return widgetShell(w, body, { chip: bad.length ? badge('crit', bad.length + ' überfällig') : badge('ok', 'Aktuell') });
      }
      case 'uptime-grid': {
        const u = d.uptime;
        if (!u.length) return widgetShell(w, '<div class="widget-empty"><span>Noch keine Prüfungen. Lege im Plugin Uptime die erste an.</span><a href="#/onboarding/catalog">Prüfung anlegen</a></div>');
        const map = { ok: 'OK', warn: 'Langsam', crit: 'Down', unknown: 'Unbekannt' };
        return widgetShell(w, '<div class="svc-grid" data-fit>' + u.slice(0, w.size === 'XL' ? 16 : w.size === 'L' ? 12 : 9).map((x) => '<div class="svc"><div class="top"><span class="name truncate">' + esc(x.name) + '</span>' + statusEl(x.s, map[x.s]) + '</div><span class="sub">' + (x.ms == null ? 'keine Antwort' : nf.format(x.ms) + ' ms') + '</span></div>').join('') + '</div>' + moreEl(Math.max(0, u.length - (w.size === 'XL' ? 16 : w.size === 'L' ? 12 : 9)), 'weitere Prüfung', 'weitere Prüfungen', ''),
          { chip: u.some((x) => x.s === 'crit') ? badge('crit', u.filter((x) => x.s === 'crit').length + ' down') : statusEl('ok') });
      }
      case 'cf-tunnel': {
        const c = d.cf; const ok = c.status === 'healthy';
        return widgetShell(w, '<div>' + statusEl(ok ? 'ok' : 'warn', ok ? 'Verbunden' : 'Eingeschränkt') + '</div><div class="muted" style="font-size:var(--fs-2)">' + esc(c.tunnel) + ', ' + plural(c.connectors, 'Connector', 'Connectors') + ' (' + esc(c.colos) + ')</div>');
      }
      case 'cf-traffic': {
        const c = d.cf;
        return widgetShell(w, '<div class="stat-row"><div class="stat"><span class="stat-label">Anfragen, 24 h</span><span class="stat-value">' + compact(c.requests24h.reduce((a, b) => a + b, 0)) + '</span></div><div class="stat"><span class="stat-label">Aus dem Cache</span><span class="stat-value">' + pct(c.cacheHit) + '</span></div></div>' + chartSlot('cf-' + w.size, [{ name: 'Anfragen je 30 min', values: c.requests24h, color: 'var(--series-1)' }], { unit: '', compact: true }));
      }
      case 'unifi-wan': {
        const u = d.unifi.wan;
        return widgetShell(w, '<div>' + statusEl(u.status, u.status === 'ok' ? 'Online' : 'Gestört') + '</div><dl class="kv"><dt>Down / Up</dt><dd>' + nf1.format(u.down) + ' / ' + nf1.format(u.up) + ' Mbit/s</dd></dl>' + (w.size === 'S' ? '' : '<div class="mono faint wrap-any" style="font-size:var(--fs-1)">' + esc(u.ip) + '</div>'));
      }
      case 'unifi-clients': {
        const u = d.unifi; const max = Math.max(1, ...u.perAp.map((x) => x.n));
        const banner = d.staleWidget === w.id ? '<div class="widget-banner warn" role="status">' + I('warn', 'icon-sm') + 'Veraltet: letzte Daten vor 6 Minuten, Konsole antwortet nicht</div>' : '';
        return widgetShell(w, '<div class="stat"><span class="stat-label">Clients gesamt</span><span class="stat-value">' + nf.format(u.clients) + '</span></div>' +
          (u.perAp.length ? '<div class="bars" data-fit>' + u.perAp.map((x) => '<div class="hbar"><span class="lbl" title="' + esc(x.name) + '">' + esc(x.name) + '</span><span class="track">' + (x.offline ? '' : '<i class="fill" style="width:' + Math.max(2, (x.n / max) * 100) + '%"></i>') + '</span><span class="val">' + (x.offline ? badge('warn', 'offline') : nf.format(x.n)) + '</span></div>').join('') + '</div>' + moreEl(0, 'weiterer Access Point', 'weitere Access Points', '') : '<span class="muted">Keine Clients verbunden.</span>'),
          { state: banner ? 'stale' : '', banner, updated: banner ? 'vor 6 Minuten' : undefined });
      }
      case 'docker-summary': {
        const dk = d.docker;
        return widgetShell(w, '<div class="stat-row"><div class="stat"><span class="stat-label">Laufen</span><span class="stat-value">' + nf.format(dk.running) + '</span></div><div class="stat"><span class="stat-label">Unhealthy</span><span class="stat-value">' + (dk.unhealthy.length ? '<span class="status-warn">' + I('warn', 'icon-sm') + '</span> ' : '') + nf.format(dk.unhealthy.length) + '</span></div></div>' + (dk.unhealthy.length && w.size !== 'S' ? '<div class="line-status">' + statusEl('warn', dk.unhealthy[0] + (dk.unhealthy.length > 1 ? ' und ' + (dk.unhealthy.length - 1) + ' weitere' : '')) + '</div>' : ''));
      }
      case 'fritz':
        return widgetShell(w, (w.size === 'S' ? '' : '<div class="muted" style="font-size:var(--fs-3)">Sammler gestoppt, Konfiguration bleibt erhalten.</div>') + '<a href="#/settings/infrastructure">Fortsetzen</a>', { banner: '<div class="widget-banner paused" role="status">' + I('paused', 'icon-sm') + 'Plugin pausiert</div>', state: 'paused', updated: 'pausiert seit 12 Tagen', chip: badge('paused') });
      case 'ha': {
        const h = d.ha; const coffee = state.haCoffee == null ? h.coffee : state.haCoffee;
        return widgetShell(w, '<div class="ha-tiles"><div class="ha-tile"><span class="muted" style="font-size:var(--fs-2)">Temperatur</span><span class="v">' + (h.temp == null ? 'k. A.' : nf1.format(h.temp) + ' °C') + '</span></div>' +
          '<div class="ha-tile"><span class="muted" style="font-size:var(--fs-2)">Luftfeuchte</span><span class="v">' + pct(h.humid / 100) + '</span></div>' +
          '<div class="ha-tile"><label class="switch"><input type="checkbox" data-action="ha-toggle"' + (coffee ? ' checked' : '') + '><span class="switch-track"></span><span>Kaffeemaschine<br><span class="muted" style="font-size:var(--fs-2)">' + (coffee ? 'an' : 'aus') + '</span></span></label></div>' +
          '<div class="ha-tile"><span class="muted" style="font-size:var(--fs-2)">Bad, Soll</span><span class="v">' + nf1.format(h.bathTarget) + ' °C</span></div></div>');
      }
      case 'pve-cpu':
        return widgetShell(w, chartSlot('pvecpu-' + w.size, [{ name: 'CPU', values: d.pve.cpu24h, color: 'var(--series-1)' }], { unit: '%' }));
      case 'tailscale': {
        const t = d.tailscale;
        return widgetShell(w, '<div class="stat"><span class="stat-label">Online</span><span class="stat-value">' + nf.format(t.online) + '<small>von ' + nf.format(t.total) + '</small></span></div><div class="line-status">' + statusEl('warn', 'Schlüssel: ' + t.expiring) + '</div>');
      }
    }
    return widgetShell(w, '');
  }

  /* "N more" line under a fitted list; fitWidgets() adds the items it had to hide */
  function moreEl(extra, one, many, suffix, href) {
    const attrs = ' data-fit-more data-extra="' + extra + '" data-one="' + esc(one) + '" data-many="' + esc(many) + '" data-suffix="' + esc(suffix || '') + '"' + (extra ? '' : ' hidden');
    const txt = extra ? plural(extra, one, many) + (suffix || '') : '';
    return href ? '<a href="' + href + '" class="muted more-line"' + attrs + '>' + txt + '</a>' : '<span class="muted more-line"' + attrs + '>' + txt + '</span>';
  }
  function meter(label, v, suffix) {
    const lvl = v == null ? 'unknown' : v >= 0.9 ? 'crit' : v >= 0.8 ? 'warn' : 'ok';
    const width = v == null ? 0 : Math.min(100, Math.max(0, v * 100));
    return '<div class="meter" data-level="' + lvl + '"><div class="meter-top"><span title="' + esc(label) + '">' + esc(label) + esc(suffix || '') + '</span><b>' + (lvl === 'warn' || lvl === 'crit' ? I(SEV[lvl].icon, 'icon-sm') + ' ' : '') + pct(v) + '</b></div>' +
      '<div class="meter-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(width) + '" aria-label="' + esc(label) + '"><i class="meter-fill" style="width:' + width + '%"></i></div></div>';
  }

  /* ---------- charts ---------- */
  const charts = {};
  function chartSlot(id, series, opts) {
    charts[id] = { series, opts: opts || {} };
    const tbl = state.chartTable[id];
    const legend = series.length > 1 ? '<div class="chart-legend">' + series.map((s) => '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>').join('') + '</div>' : '';
    return legend + (tbl ? chartTable(id) : '<div class="chart" data-chart="' + id + '" tabindex="0" role="group" aria-label="' + esc(series.map((s) => s.name).join(', ')) + ', letzte 24 Stunden. Pfeiltasten wählen einen Zeitpunkt."></div>') +
      '<button class="linkish" style="align-self:flex-start;justify-self:start;font-size:var(--fs-2)" type="button" data-action="chart-table" data-id="' + id + '">' + (tbl ? 'Als Diagramm' : 'Als Tabelle') + '</button>';
  }
  const tLabel = (i, n) => { const d = new Date(NOW - (n - 1 - i) * 30 * 60000); return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); };
  function chartTable(id) {
    const c = charts[id]; const n = c.series[0].values.length;
    const rows = [];
    for (let i = n - 1; i >= Math.max(0, n - 12); i--) rows.push('<tr><td>' + tLabel(i, n) + '</td>' + c.series.map((s) => '<td class="num">' + fmtVal(s.values[i], c.opts) + '</td>').join('') + '</tr>');
    return '<div style="overflow:auto;flex:1;min-height:0"><table class="data"><thead><tr><th>Zeit</th>' + c.series.map((s) => '<th class="num">' + esc(s.name) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }
  const fmtVal = (v, o) => (v == null ? 'k. A.' : o.unit === '%' ? nf1.format(v) + ' %' : o.compact ? compact(v) : nf.format(Math.round(v)));
  function drawCharts() {
    document.querySelectorAll('.chart[data-chart]').forEach((el) => {
      const c = charts[el.dataset.chart]; if (!c) return;
      const W = Math.max(120, el.clientWidth); const H = Math.max(80, el.clientHeight || 160);
      const padL = 40, padR = 8, padT = 8, padB = 22;
      const n = c.series[0].values.length;
      const all = c.series.flatMap((s) => s.values);
      const maxRaw = Math.max(...all); const step = niceStep(maxRaw / 3); const max = Math.max(step, Math.ceil(maxRaw / step) * step);
      const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
      const y = (v) => padT + (1 - v / max) * (H - padT - padB);
      let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">';
      for (let t = 0; t <= max + 1e-9; t += step) svg += '<line class="grid-line" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(t) + '" y2="' + y(t) + '"/><text class="tick" x="' + (padL - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + fmtTick(t, c.opts) + '</text>';
      svg += '<line class="axis-line" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
      [0, Math.floor(n / 2), n - 1].forEach((i) => { svg += '<text class="tick" x="' + x(i) + '" y="' + (H - 4) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + (i === n - 1 ? 'jetzt' : tLabel(i, n)) + '</text>'; });
      c.series.forEach((s) => {
        const pts = s.values.map((v, i) => x(i) + ',' + y(v)).join(' ');
        if (c.series.length === 1) svg += '<polygon class="wash" fill="' + s.color + '" style="opacity:var(--chart-wash)" points="' + padL + ',' + y(0) + ' ' + pts + ' ' + x(n - 1) + ',' + y(0) + '"/>';
        svg += '<polyline class="series" stroke="' + s.color + '" points="' + pts + '"/>';
        svg += '<circle class="dot" r="4" cx="' + x(n - 1) + '" cy="' + y(s.values[n - 1]) + '" fill="' + s.color + '"/>';
      });
      svg += '<line class="xhair" data-x x1="0" x2="0" y1="' + padT + '" y2="' + y(0) + '" style="display:none"/>';
      svg += '</svg><div class="tooltip" style="display:none"></div>';
      el.innerHTML = svg;
      const tip = el.querySelector('.tooltip'); const xh = el.querySelector('[data-x]');
      let idx = n - 1;
      const show = (i) => {
        idx = Math.max(0, Math.min(n - 1, i));
        xh.style.display = ''; xh.setAttribute('x1', x(idx)); xh.setAttribute('x2', x(idx));
        tip.style.display = ''; tip.style.left = Math.min(W - 70, Math.max(70, x(idx))) + 'px'; tip.style.top = padT + 'px';
        tip.innerHTML = '<div class="when">' + (idx === n - 1 ? 'jetzt' : tLabel(idx, n)) + '</div>' + c.series.map((s) => '<div class="row"><i class="key" style="background:' + s.color + '"></i><b>' + fmtVal(s.values[idx], c.opts) + '</b><span>' + esc(s.name) + '</span></div>').join('');
      };
      const hide = () => { xh.style.display = 'none'; tip.style.display = 'none'; };
      el.onpointermove = (e) => { const r = el.getBoundingClientRect(); show(Math.round(((e.clientX - r.left - padL) / (W - padL - padR)) * (n - 1))); };
      el.onpointerleave = hide;
      el.onkeydown = (e) => { if (e.key === 'ArrowLeft') { show(idx - 1); e.preventDefault(); } else if (e.key === 'ArrowRight') { show(idx + 1); e.preventDefault(); } else if (e.key === 'Escape') hide(); };
      el.onfocus = () => show(idx); el.onblur = hide;
    });
  }
  function niceStep(raw) { if (raw <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(raw))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
  const fmtTick = (t, o) => (o.unit === '%' ? nf.format(Math.round(t)) + ' %' : compact(t));

  /* ---------- shell ---------- */
  function sidebar(active) {
    const d = D();
    const inst = d.instances;
    const health = (pid) => { const i = inst.find((x) => x.plugin === pid); return i ? i.health : null; };
    const plugins = ['proxmox-ve', 'proxmox-backup-server', 'cloudflare', 'unifi-network', 'uptime', 'docker', 'tailscale', 'fritzbox'].filter((p) => inst.some((i) => i.plugin === p));
    const navItem = (href, ic, label, cur, meta) => '<a class="nav-item" href="' + href + '"' + (cur ? ' aria-current="page"' : '') + '>' + I(ic) + '<span class="truncate">' + esc(label) + '</span>' + (meta ? '<span class="nav-meta">' + meta + '</span>' : '') + '</a>';
    const hMeta = (h) => (h === 'crit' || h === 'warn' || h === 'paused' ? '<span class="status status-' + h + '" title="' + SEV[h].label + '">' + I(SEV[h].icon, 'icon-sm') + '<span class="sr-only">' + SEV[h].label + '</span></span>' : '');
    return '<aside class="sidebar" aria-label="Navigation">' +
      '<a class="brand" href="#/dashboard">' + MARK + '' +
      '<span class="truncate" title="' + esc(d.instanceName) + '"><span class="brand-name">' + esc(d.instanceName) + '</span><span class="brand-sub">admin.rxf-sys.de</span></span></a>' +
      '<nav class="nav" aria-label="Hauptnavigation">' +
      navItem('#/dashboard', 'dashboard', 'Dashboard', active === 'dashboard') +
      '<div class="nav-heading">Infrastruktur</div>' +
      (plugins.length ? plugins.map((p) => {
        const pl = pluginById(p);
        let html = navItem(p === 'proxmox-ve' ? '#/p/proxmox-ve/guests' : '#/dashboard', PLUGIN_ICON[p], pl.name, active === p && p !== 'proxmox-ve', hMeta(health(p)));
        if (active === p && p === 'proxmox-ve') html = html.replace('<a class="nav-item"', '<a class="nav-item" data-open="true"');
        if (p === 'proxmox-ve' && active === 'proxmox-ve') {
          html += '<div class="nav-sub">' + [['Übersicht', ''], ['Knoten', ''], ['Gäste', 'guests'], ['Speicher', ''], ['Aufgaben', '']].map(([l, k]) => '<a class="nav-item" href="#/p/proxmox-ve/' + (k || 'guests') + '"' + (k === 'guests' ? ' aria-current="page"' : '') + '><span>' + l + '</span></a>').join('') + '</div>';
        }
        return html;
      }).join('') : '<p class="faint" style="padding:0 12px;font-size:var(--fs-2)">Noch kein Plugin verbunden.</p>') +
      navItem('#/onboarding/catalog', 'plus', 'Plugin hinzufügen', false) +
      '<div class="nav-heading">Verwaltung</div>' +
      navItem('#/settings/infrastructure', 'plug', 'Infrastruktur', active === 'settings') +
      navItem('#/settings/infrastructure', 'bell', 'Alarme', false) +
      navItem('#/settings/infrastructure', 'task', 'Audit-Log', false) +
      navItem('#/settings/infrastructure', 'key', 'Konten', false) +
      '</nav><div class="sidebar-foot"><div class="user-chip"><span class="avatar" aria-hidden="true">' + esc(initials(d.user.name)) + '</span><span class="truncate"><span class="ink" style="font-weight:700;font-size:var(--fs-3)">' + esc(d.user.name) + '</span><br><span class="faint" style="font-size:var(--fs-1)">' + esc(d.user.role) + '</span></span><a class="icon-btn icon-btn-sm" href="#/login" aria-label="Abmelden" style="margin-left:auto">' + I('logout', 'icon-sm') + '</a></div></div></aside>';
  }
  function initials(name) {
    const seg = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('de', { granularity: 'grapheme' }) : null;
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    const first = (w) => (seg ? [...seg.segment(w)][0].segment : w[0]).toUpperCase();
    if (!words.length) return '?';
    return words.length === 1 ? first(words[0]) : first(words[0]) + first(words[words.length - 1]);
  }
  function topbar(crumbs) {
    const d = D(); const open = d.alerts.length;
    const themeIcon = state.theme === 'light' ? 'sun' : state.theme === 'dark' ? 'moon' : 'monitor';
    const themeLabel = { system: 'System', light: 'Hell', dark: 'Dunkel' }[state.theme];
    return '<header class="topbar"><button class="icon-btn menu-btn" type="button" data-action="nav" aria-label="Navigation öffnen" aria-expanded="' + state.navOpen + '">' + I('menu') + '</button>' +
      '<div class="crumbs truncate">' + crumbs + '</div><div class="topbar-actions">' +
      '<button class="search-trigger" type="button" data-action="palette" aria-keyshortcuts="Control+K Meta+K">' + I('search', 'icon-sm') + '<span>Suchen, springen, ausführen</span><kbd>Strg K</kbd></button>' +
      '<a class="icon-btn" href="#/dashboard" aria-label="' + plural(open, 'offenes Problem', 'offene Probleme') + '" style="position:relative">' + I('bell') + (open ? '<span class="badge badge-crit" style="position:absolute;top:2px;right:-2px;min-height:18px;padding:0 6px;font-size:11px">' + nf.format(open) + '</span>' : '') + '</a>' +
      '<button class="icon-btn" type="button" data-action="theme" aria-label="Farbschema: ' + themeLabel + '. Wechseln">' + I(themeIcon) + '</button>' +
      '</div></header>';
  }
  function shell(active, crumbs, content) {
    return '<div class="app" data-nav="' + (state.navOpen ? 'open' : 'closed') + '">' + sidebar(active) + '<div class="main">' + topbar(crumbs) + '<main class="content" id="main" tabindex="-1">' + content + '</main></div></div>';
  }

  /* ---------- views ---------- */
  function viewIndex() {
    const views = [
      ['#/login', 'Anmeldung', 'Login mit Passwort, zweitem Faktor, Fehlern, Sperre und Ersteinrichtung per Setup-Code'],
      ['#/onboarding/catalog', 'Onboarding: Katalog', 'Infrastruktur wählen, drei Varianten im Picker'],
      ['#/onboarding/connect', 'Onboarding: Verbinden', 'Formular aus dem Schema, Anleitung, Verbindungstest, Zertifikat bestätigen'],
      ['#/onboarding/permissions', 'Onboarding: Berechtigungen', 'Nur lesen oder Aktionen erlauben, je Plugin'],
      ['#/onboarding/layout', 'Onboarding: Startlayout', 'Vorlage wählen oder leer starten'],
      ['#/dashboard', 'Dashboard', 'Widgets mit allen Zuständen, drei Kartenvarianten im Picker'],
      ['#/dashboard/edit', 'Dashboard bearbeiten', 'Widgets hinzufügen, verschieben per Maus und Tastatur, Größen, Rückgängig, Export'],
      ['#/p/proxmox-ve/guests', 'Proxmox VE: Gäste', 'Tabelle mit Suche, Filtern, Sortierung'],
      ['#/p/proxmox-ve/guests/104', 'Proxmox VE: Gast-Detail', 'Verläufe, Snapshots, Aktionen mit Bestätigung und Audit'],
      ['#/settings/infrastructure', 'Einstellungen: Infrastruktur', 'Instanzen bearbeiten, testen, pausieren, entfernen'],
    ];
    return '<main class="onb-main" id="main" tabindex="-1" style="max-width:920px"><div class="onb-head"><h1>Vorschau v2</h1><p>Klickbare Vorschau der Schlüsselansichten. Unten links lassen sich Daten (Demo, Worst case, Leer) und Farbschema umschalten. Alle Inhalte sind Demodaten.</p></div>' +
      '<div class="catalog-list">' + views.map(([h, t, s], i) => '<a class="row" href="' + h + '" style="grid-template-columns:auto minmax(0,1fr) auto;text-decoration:none;color:inherit"><span class="type-tag">' + (i + 1) + '</span><span><b class="ink">' + esc(t) + '</b><br><span class="muted" style="font-size:var(--fs-3)">' + esc(s) + '</span></span>' + I('chevronRight') + '</a>').join('') + '</div></main>';
  }

  function viewLogin() {
    const s = state.loginState; const d = D();
    let form;
    if (s === 'setup') {
      form = '<div><h1>Ersteinrichtung</h1><p class="sub">Den Setup-Code findest du im Server-Log (<code class="mono">docker compose logs server</code>). Er gilt 24 Stunden.</p></div>' +
        '<form data-action="login-submit" novalidate><div class="field"><label class="field-label" for="code">Setup-Code</label><input class="input mono" id="code" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"></div>' +
        '<div class="field"><label class="field-label" for="u">Benutzername für das Admin-Konto</label><input class="input" id="u" autocomplete="username"></div>' +
        '<div class="field"><label class="field-label" for="p">Passwort</label><input class="input" id="p" type="password" autocomplete="new-password"><span class="field-hint">Mindestens 12 Zeichen. Danach richtest du den zweiten Faktor ein.</span></div>' +
        '<button class="btn btn-primary btn-block" type="submit">Admin-Konto anlegen</button></form>';
    } else if (s === '2fa') {
      form = '<div><h1>Zweiter Faktor</h1><p class="sub">Gib den 6-stelligen Code aus deiner Authenticator-App ein.</p></div>' +
        '<form data-action="login-submit" novalidate><div class="field"><label class="field-label" for="otp">Code</label><input class="input input-otp" id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></div>' +
        '<button class="btn btn-primary btn-block" type="submit">Bestätigen</button></form>' +
        '<div class="divider">oder</div><button class="btn btn-outline btn-block" type="button" data-action="go" data-href="#/dashboard">' + I('passkey') + 'Mit Passkey bestätigen</button>' +
        '<p class="muted" style="font-size:var(--fs-3)">Kein Zugriff auf die App? <button class="linkish" type="button">Backup-Code verwenden</button></p>';
    } else {
      const err = s === 'error' ? '<div class="callout crit" role="alert">' + I('crit') + '<div><b>Anmeldung fehlgeschlagen.</b> Benutzername oder Passwort stimmt nicht.</div></div>' : '';
      const lock = s === 'locked' ? '<div class="callout warn" role="alert">' + I('lock') + '<div><b>Zu viele Fehlversuche.</b> Nächster Versuch in 4 Minuten. Die Wartezeit verdoppelt sich mit jedem weiteren Fehlversuch.</div></div>' : '';
      form = '<div><h1>Anmelden</h1><p class="sub">' + esc(d.instanceName) + '</p></div>' + err + lock +
        '<form data-action="login-submit" novalidate><div class="field"><label class="field-label" for="u">Benutzername</label><input class="input" id="u" autocomplete="username" value="admin"' + (s === 'error' ? ' aria-invalid="true"' : '') + '></div>' +
        '<div class="field"><label class="field-label" for="p">Passwort</label><div class="input-group"><input class="input" id="p" type="password" autocomplete="current-password" value="geheimes-passwort"' + (s === 'error' ? ' aria-invalid="true"' : '') + '><button class="icon-btn" type="button" data-action="toggle-pw" aria-label="Passwort anzeigen">' + I('eye') + '</button></div></div>' +
        '<button class="btn btn-primary btn-block" type="submit"' + (s === 'locked' ? ' disabled' : '') + '>Anmelden</button></form>' +
        '<div class="divider">oder</div><button class="btn btn-outline btn-block" type="button" data-action="go" data-href="#/dashboard">' + I('passkey') + 'Mit Passkey anmelden</button>';
    }
    return '<div class="auth"><section class="auth-side" aria-label="Über diese Instanz"><a class="brand" href="#/" style="padding:0">' + MARK + '<span class="brand-name">rxf-sys Control</span></a>' +
      '<h2>Deine Infrastruktur auf einen Blick.</h2><div class="health"><div class="health-row">' + I('server', 'icon-sm') + '<span style="flex:1">Proxmox, Backups, Netzwerk und Dienste an einem Ort</span></div><div class="health-row">' + I('bell', 'icon-sm') + '<span style="flex:1">Was Aufmerksamkeit braucht, steht ganz oben</span></div><div class="health-row">' + I('lock', 'icon-sm') + '<span style="flex:1">Zugang nur mit zweitem Faktor</span></div></div><span class="band" aria-hidden="true"></span></section>' +
      '<main class="auth-main" id="main" tabindex="-1"><div class="auth-card">' + form + '<p class="faint" style="font-size:var(--fs-2)">Sitzungen enden nach 12 Stunden ohne Aktivität.</p></div></main></div>';
  }

  function onbFrame(step, main, foot) {
    const steps = ['Willkommen', 'Infrastruktur', 'Verbinden', 'Berechtigungen', 'Startlayout', 'Fertig'];
    return '<div class="onb"><header class="onb-top"><a class="brand" href="#/" aria-label="rxf-sys Control, Übersicht der Vorschau">' + MARK + '</a>' +
      '<ol class="stepper" aria-label="Fortschritt">' + steps.map((s, i) => (i ? '<li class="sep" aria-hidden="true"></li>' : '') + '<li' + (i + 1 === step ? ' aria-current="step"' : i + 1 < step ? ' data-state="done"' : '') + '><span class="n">' + (i + 1 < step ? I('check', 'icon-sm') : i + 1) + '</span><span class="lbl">' + s + '</span>' + (i + 1 === step ? '<span class="step-of">Schritt ' + step + ' von ' + steps.length + '</span>' : '') + (i + 1 < step ? '<span class="sr-only">, erledigt</span>' : '') + '</li>').join('') + '</ol>' +
      '<button class="icon-btn" type="button" data-action="theme" aria-label="Farbschema wechseln">' + I(state.theme === 'light' ? 'sun' : state.theme === 'dark' ? 'moon' : 'monitor') + '</button></header>' +
      '<main class="onb-main" id="main" tabindex="-1">' + main + '</main><footer class="onb-foot">' + foot + '</footer></div>';
  }

  function viewCatalog() {
    const d = D();
    const cats = ['Alle', 'Virtualisierung', 'Netzwerk', 'Router', 'Backup', 'DNS/Edge', 'Container', 'Smart Home', 'Monitoring'];
    const q = state.catalogQuery.toLowerCase();
    const list = d.catalog.filter((p) => (state.catalogFilter === 'Alle' || p.category === state.catalogFilter) && (!q || (p.name + ' ' + p.desc).toLowerCase().includes(q)));
    const sel = state.selected;
    const tile = (p) => '<button class="pl-tile" type="button" data-action="pick" data-id="' + p.id + '" aria-pressed="' + sel.has(p.id) + '"><span class="logo" aria-hidden="true">' + esc(p.mono) + '</span><span class="t-title">' + esc(p.name) + '</span><span class="cat">' + esc(p.category) + '</span><span class="desc">' + esc(p.desc) + '</span><span class="pick" aria-hidden="true">' + I('check', 'icon-sm') + '</span></button>';
    let body;
    if (!list.length) body = '<div class="card card-pad" style="text-align:center"><b class="ink">Kein Plugin passt zu „' + esc(state.catalogQuery) + '“.</b><p class="muted">Prüfe die Schreibweise oder wähle „Alle“. Fehlt etwas? Plugins lassen sich später ergänzen.</p></div>';
    else if (state.catalogView === 'list') body = '<div class="catalog-list" role="group" aria-label="Plugins">' + list.map((p) => '<div class="row" role="checkbox" tabindex="0" data-action="pick" data-id="' + p.id + '" aria-checked="' + sel.has(p.id) + '"><span class="pick-box" aria-hidden="true">' + (sel.has(p.id) ? '<span class="badge badge-ok" style="padding:0 6px">' + I('check') + '</span>' : '<span class="badge badge-neutral" style="padding:0 6px">' + I('plus') + '</span>') + '</span><span class="logo logo-sm" aria-hidden="true">' + esc(p.mono) + '</span><span><b class="ink">' + esc(p.name) + '</b><br><span class="muted" style="font-size:var(--fs-3)">' + esc(p.desc) + '</span></span><span class="needs">Du brauchst: ' + esc(p.needs) + '</span><span class="cat faint" style="font-size:var(--fs-2)">' + esc(p.category) + '</span></div>').join('') + '</div>';
    else if (state.catalogView === 'groups') {
      const groups = cats.slice(1).map((c) => [c, list.filter((p) => p.category === c)]).filter((g) => g[1].length);
      body = '<div class="catalog-groups">' + groups.map(([c, ps]) => '<section><h2>' + esc(c) + ' <span>' + ps.length + '</span></h2><div class="catalog">' + ps.map(tile).join('') + '</div></section>').join('') + '</div>';
    } else body = '<div class="catalog">' + list.map(tile).join('') + '</div>';
    const main = '<div class="onb-head"><h1>Was läuft bei dir?</h1><p>Wähle die Systeme, die das Dashboard überwachen soll. Nur gewählte Plugins werden geladen. Du kannst jederzeit weitere hinzufügen oder entfernen.</p></div>' +
      '<div class="toolbar"><div class="search">' + I('search') + '<input class="input" type="search" placeholder="Plugin suchen" aria-label="Plugin suchen" data-action="cat-search" value="' + esc(state.catalogQuery) + '"></div>' +
      '<div class="chips" role="group" aria-label="Kategorie">' + cats.map((c) => '<button class="chip" type="button" data-action="cat-filter" data-cat="' + esc(c) + '" aria-pressed="' + (state.catalogFilter === c) + '">' + esc(c) + '</button>').join('') + '</div></div>' + body;
    const foot = '<button class="btn btn-ghost" type="button" data-action="go" data-href="#/">' + I('chevronLeft') + 'Zurück</button><span class="muted" aria-live="polite">' + (sel.size ? plural(sel.size, 'Plugin', 'Plugins') + ' gewählt' : 'Noch nichts gewählt') + '</span><button class="btn btn-primary" type="button" data-action="go" data-href="#/onboarding/connect"' + (sel.size ? '' : ' disabled') + '>Weiter' + I('chevronRight') + '</button>';
    return onbFrame(2, main, foot) + picker(['Raster', 'Liste', 'Gruppiert'], ['grid', 'list', 'groups'].indexOf(state.catalogView), 'catalog');
  }

  function viewConnect() {
    const c = state.connect; const d = D();
    const queue = [...state.selected].map((id, i) => { const p = pluginById(id); return '<a href="#/onboarding/connect"' + (i === 0 ? ' aria-current="step"' : '') + '><span class="logo logo-sm" aria-hidden="true">' + esc(p.mono) + '</span><span class="truncate">' + esc(p.name) + '</span><span class="q-state">' + (i === 0 ? (c.trusted ? statusEl('ok', 'Verbunden') : '<span class="faint" style="font-size:var(--fs-2)">in Arbeit</span>') : '<span class="faint" style="font-size:var(--fs-2)">offen</span>') + '</span></a>'; }).join('');
    let result = '';
    if (c.error) {
      result = '<div class="test-result" role="status"><b class="ink">Verbindungstest</b><ul><li>' + I('crit', 'status-crit') + '<div><b class="ink">Host 192.168.2.200:8006 nicht erreichbar</b><div class="msg">Läuft pveproxy, und stimmt der Port? Tipp: Öffne https://192.168.2.200:8006 im Browser desselben Netzes.</div></div></li></ul></div>';
    } else if (c.tested) {
      result = '<div class="test-result" role="status"><b class="ink">Verbindungstest</b><ul>' +
        '<li>' + I('ok', 'status-ok') + '<div>Host erreichbar, Proxmox VE 9.1.9</div></li>' +
        '<li>' + I(c.trusted ? 'ok' : 'warn', c.trusted ? 'status-ok' : 'status-warn') + '<div>' + (c.trusted ? 'Zertifikat bestätigt (Fingerprint gespeichert)' : '<b class="ink">Zertifikat unbekannt.</b> <button class="linkish" type="button" data-action="tofu">Fingerprint prüfen und bestätigen</button>') + '</div></li>' +
        (c.trusted ? '<li>' + I('ok', 'status-ok') + '<div>Anmeldung mit Token rxf-dashboard@pve!monitor</div></li><li>' + I('ok', 'status-ok') + '<div>Leserechte auf /nodes, /vms und /storage</div></li><li>' + I('warn', 'status-warn') + '<div>Kein Sys.Audit auf /<div class="msg">Cluster-Status, HA und Backup-Jobs sind nicht lesbar. Setze PVEAuditor auch auf / (Schritt 3 der Anleitung).</div></div></li>' : '') +
        '</ul></div>';
    }
    const form = '<section class="panel form-card" aria-labelledby="f-h"><div><h2 id="f-h">Proxmox VE verbinden</h2><p class="muted" style="margin-top:4px">Die Felder stammen aus dem Konfigurationsschema des Plugins.</p></div>' +
      '<div class="field"><label class="field-label" for="f-name">Name</label><input class="input" id="f-name" value="Proxmox VE"><span class="field-hint">So heißt die Instanz im Dashboard.</span></div>' +
      '<div class="field"><label class="field-label" for="f-host">Host und Port</label><div class="input-group"><input class="input" id="f-host" value="192.168.2.200" spellcheck="false"><input class="input num" style="max-width:96px" value="8006" aria-label="Port" inputmode="numeric"></div><span class="field-hint">IP oder Hostname eines Knotens. Das Dashboard spricht nur mit dieser Adresse.</span></div>' +
      '<div class="field"><label class="field-label" for="f-tid">Token-ID</label><input class="input mono" id="f-tid" value="rxf-dashboard@pve!monitor" spellcheck="false"><span class="field-hint">Format benutzer@realm!tokenname</span></div>' +
      '<div class="field"><label class="field-label" for="f-sec">Token-Secret</label><input class="input mono" id="f-sec" type="password" value="0123456789abcdef" autocomplete="off"><span class="field-hint">Wird verschlüsselt gespeichert und nie wieder angezeigt.</span></div>' +
      '<fieldset class="field" style="border:0;padding:0;margin:0"><legend class="field-label" style="margin-bottom:8px">Zertifikat</legend><label class="radio"><input type="radio" name="tls" checked><span><b class="ink">Selbstsigniert, Fingerprint bestätigen</b><br><span class="muted" style="font-size:var(--fs-2)">Empfohlen für Proxmox im Heimnetz</span></span></label><label class="radio"><input type="radio" name="tls"><span><b class="ink">Öffentliches Zertifikat</b><br><span class="muted" style="font-size:var(--fs-2)">Wenn Proxmox ein gültiges ACME-Zertifikat hat</span></span></label></fieldset>' +
      result + '<div style="display:flex;flex-wrap:wrap;gap:8px"><button class="btn" type="button" data-action="test-conn">' + I('refresh') + 'Verbindung testen</button><button class="btn btn-ghost" type="button" data-action="test-fail">Fehlerfall zeigen</button></div></section>';
    const guide = '<section class="panel guide" aria-labelledby="g-h"><div class="panel-head"><h2 id="g-h">So legst du das Token an</h2><a href="https://pve.proxmox.com/pve-docs/chapter-pveum.html" rel="noreferrer noopener" target="_blank" style="font-size:var(--fs-3)">Proxmox-Doku ' + I('external', 'icon-sm') + '</a></div><ol>' +
      '<li><div><b class="ink">Benutzer anlegen.</b> Datacenter, Permissions, Users, Add. Realm <code>pve</code>, Name <code>rxf-dashboard</code>.<div class="shot">Screenshot: Dialog „Add User“</div></div></li>' +
      '<li><div><b class="ink">Token anlegen.</b> Datacenter, Permissions, API Tokens, Add. Token-ID <code>monitor</code>, Privilege Separation an. Secret sofort kopieren.<div class="shot">Screenshot: Token-Dialog mit Secret</div></div></li>' +
      '<li><div><b class="ink">Leserechte vergeben, für Benutzer und Token.</b> Permissions, Add. Pfad <code>/</code>, Rolle <code>PVEAuditor</code>. Einmal als User Permission, einmal als API Token Permission.</div></li>' +
      '<li><div><b class="ink">Nur für Aktionen:</b> eigene Rolle mit <code>VM.PowerMgmt</code> auf <code>/vms</code>. Das entscheidest du im nächsten Schritt.</div></li></ol></section>';
    const main = '<div class="onb-head"><h1>Verbinden</h1><p>Für jedes gewählte Plugin: Zugangsdaten eintragen, Verbindung testen. Dein Zwischenstand wird gespeichert.</p></div><div class="connect"><nav class="queue" aria-label="Gewählte Plugins">' + queue + '</nav>' + form + guide + '</div>';
    const foot = '<button class="btn btn-ghost" type="button" data-action="go" data-href="#/onboarding/catalog">' + I('chevronLeft') + 'Zurück</button><span class="muted">' + esc(pluginById([...state.selected][0] || 'proxmox-ve').name) + ', <span class="nowrap">1 von ' + Math.max(1, state.selected.size) + '</span></span><button class="btn btn-primary" type="button" data-action="go" data-href="#/onboarding/permissions"' + (c.trusted ? '' : ' aria-disabled="true"') + '>Weiter' + I('chevronRight') + '</button>';
    return onbFrame(3, main, foot);
  }

  function viewPermissions() {
    const rows = [
      ['proxmox-ve', [['Starten', 'low'], ['Herunterfahren', 'medium'], ['Neustarten', 'medium'], ['Hart stoppen (nur Admin)', 'high'], ['Snapshot anlegen', 'low']], 'Rolle mit VM.PowerMgmt, für Snapshots VM.Snapshot'],
      ['proxmox-backup-server', [['Verify starten', 'low']], 'Rolle DatastoreReader, darf alle Backup-Inhalte lesen'],
      ['cloudflare', [['Cache leeren', 'low']], 'Zweites Token mit Cache Purge'],
      ['unifi-network', [['AP oder Switch neu starten', 'medium'], ['Gateway neu starten', 'high'], ['PoE-Port neu starten', 'high']], 'Keine zusätzlichen Rechte nötig: Der API-Key darf bereits alles'],
    ];
    const risk = { low: 'gering', medium: 'mittel', high: 'hoch' };
    const main = '<div class="onb-head"><h1>Was darf das Dashboard?</h1><p>Standard ist „Nur lesen“. Aktionen schaltest du je Plugin frei. Gefährliche Aktionen verlangen später immer eine Bestätigung deiner Identität.</p></div>' +
      '<div class="inst-list">' + rows.map(([id, acts, need]) => {
        const p = pluginById(id); const on = state.perms[id] === 'actions';
        return '<section class="panel perm" aria-labelledby="pm-' + id + '"><div class="panel-head"><div style="display:flex;align-items:center;gap:12px"><span class="logo logo-sm" aria-hidden="true">' + esc(p.mono) + '</span><h2 id="pm-' + id + '" style="font-size:var(--fs-5)">' + esc(p.name) + '</h2></div>' +
          '<div class="segmented" role="radiogroup" aria-label="Berechtigung für ' + esc(p.name) + '"><button type="button" role="radio" aria-checked="' + !on + '" data-action="perm" data-id="' + id + '" data-v="read">Nur lesen</button><button type="button" role="radio" aria-checked="' + on + '" data-action="perm" data-id="' + id + '" data-v="actions">Aktionen erlauben</button></div></div>' +
          '<ul class="actions">' + acts.map(([a, r]) => '<li>' + (on ? I('check', 'icon-sm status-ok') : I('lock', 'icon-sm faint')) + '<span style="flex:1">' + esc(a) + '</span><span class="badge badge-risk-' + r + '">Risiko ' + risk[r] + '</span></li>').join('') + '</ul>' +
          '<p class="muted" style="font-size:var(--fs-2)">' + I('info', 'icon-sm') + ' ' + esc(need) + '</p></section>';
      }).join('') + '</div>';
    const foot = '<button class="btn btn-ghost" type="button" data-action="go" data-href="#/onboarding/connect">' + I('chevronLeft') + 'Zurück</button><span></span><button class="btn btn-primary" type="button" data-action="go" data-href="#/onboarding/layout">Weiter' + I('chevronRight') + '</button>';
    return onbFrame(4, main, foot);
  }

  function viewLayout() {
    const thumb = (cells) => '<span class="tpl-thumb" aria-hidden="true">' + cells.map(([c, r, hot]) => '<i style="grid-column:span ' + c + ';grid-row:span ' + r + '"' + (hot ? ' class="hot"' : '') + '></i>').join('') + '</span>';
    const tpls = [
      ['overview', 'Übersicht', 'Was braucht Aufmerksamkeit, Status, Proxmox, Backups, Dienste und Netz. Passt zu deiner Auswahl.', [[6, 3, true], [3, 1], [3, 1], [3, 1], [3, 1], [3, 1], [3, 1], [6, 2], [6, 2], [6, 2], [6, 2]]],
      ['network', 'Netzwerk', 'WAN, Clients, Tunnel, Traffic und Dienste im Fokus.', [[6, 3, true], [3, 1], [3, 1], [3, 1], [3, 1], [3, 1], [3, 1], [6, 2], [6, 2]]],
      ['empty', 'Leer starten', 'Ein leeres Board. Widgets fügst du selbst hinzu.', []],
    ];
    const main = '<div class="onb-head"><h1>Wie soll dein Dashboard starten?</h1><p>Wir schlagen eine Vorlage passend zu deinen Plugins vor. Alles lässt sich danach verschieben, vergrößern oder entfernen.</p></div>' +
      '<div class="templates" role="radiogroup" aria-label="Vorlage">' + tpls.map(([id, t, s, cells]) => '<button class="tpl" type="button" role="radio" aria-checked="' + (state.template === id) + '" data-action="tpl" data-id="' + id + '">' + (cells.length ? thumb(cells) : '<span class="tpl-thumb" aria-hidden="true" style="place-items:center;min-height:130px;display:grid"><span class="faint" style="font-size:var(--fs-2)">leer</span></span>') + '<span class="t-title">' + esc(t) + (id === 'overview' ? ' <span class="badge badge-neutral" style="vertical-align:middle">Empfohlen</span>' : '') + '</span><span class="muted" style="display:block;font-size:var(--fs-3)">' + esc(s) + '</span></button>').join('') + '</div>';
    const foot = '<button class="btn btn-ghost" type="button" data-action="go" data-href="#/onboarding/permissions">' + I('chevronLeft') + 'Zurück</button><span></span><button class="btn btn-primary" type="button" data-action="apply-template">Vorlage übernehmen' + I('chevronRight') + '</button>';
    return onbFrame(5, main, foot);
  }

  function viewDashboard(editing) {
    state.edit = !!editing;
    if (!state.layout) state.layout = layoutFrom(TEMPLATES.overview);
    const d = D();
    const visible = d.instances.length ? state.layout : [];
    const tabs = '<div class="board-row"><div class="board-tabs" role="tablist" aria-label="Boards">' + [['overview', 'Übersicht'], ['network', 'Netzwerk'], ['backups', 'Backups']].map(([id, l]) => '<button class="board-tab" role="tab" type="button" aria-selected="' + (state.board === id) + '" data-action="board" data-id="' + id + '">' + l + '</button>').join('') + '</div>' + (editing ? '<button class="board-tab board-add" type="button">' + I('plus', 'icon-sm') + ' Board</button>' : '') + '</div>';
    const head = '<div class="page-head"><div><h1>Dashboard</h1></div><div class="page-actions">' + (editing ? '' : '<span class="board-meta"><span class="live-dot" aria-hidden="true"></span>Live, aktualisiert vor 12 Sekunden</span><button class="btn" type="button" data-action="go" data-href="#/dashboard/edit">' + I('edit') + 'Bearbeiten</button>') + '</div></div>';
    const editBar = editing ? '<div class="edit-bar" role="toolbar" aria-label="Board bearbeiten"><span class="lbl">Bearbeiten: Übersicht</span>' +
      '<button class="btn btn-sm" type="button" data-action="add-widget">' + I('plus', 'icon-sm') + 'Widget hinzufügen</button>' +
      '<button class="icon-btn" type="button" data-action="undo" aria-label="Rückgängig (Strg+Z)"' + (state.undo.length ? '' : ' disabled') + '>' + I('undo') + '</button>' +
      '<button class="icon-btn" type="button" data-action="redo" aria-label="Wiederholen (Strg+Umschalt+Z)"' + (state.redo.length ? '' : ' disabled') + '>' + I('redo') + '</button>' +
      '<button class="icon-btn" type="button" data-action="reset" aria-label="Auf Vorlage zurücksetzen">' + I('refresh') + '</button>' +
      '<button class="icon-btn" type="button" data-action="export" aria-label="Als JSON exportieren">' + I('download') + '</button>' +
      '<button class="icon-btn" type="button" data-action="import" aria-label="JSON importieren">' + I('upload') + '</button>' +
      '<span class="spacer"></span><button class="btn btn-sm btn-primary" type="button" data-action="done-edit">Fertig</button></div>' +
      '<p id="drag-help" class="muted" style="font-size:var(--fs-2)">Tastatur: Widget fokussieren, Leertaste zum Aufnehmen, Pfeiltasten zum Verschieben, Leertaste zum Ablegen, Esc zum Abbrechen.</p>' : '';
    const grid = visible.length ? '<div class="grid' + (editing ? ' editing' : '') + '" data-grid>' + visible.map(renderWidget).join('') + '</div>' :
      '<div class="card card-pad" style="display:grid;gap:12px;justify-items:start;max-width:640px"><h2>Noch nichts zu sehen</h2><p class="muted">Verbinde dein erstes Plugin, zum Beispiel Proxmox VE oder Uptime. Danach schlägt das Dashboard passende Widgets vor.</p><a class="btn btn-primary" href="#/onboarding/catalog" style="text-decoration:none">' + I('plus') + 'Plugin verbinden</a></div>';
    return '<div data-card="' + state.card + '" style="display:grid;gap:var(--sp-5)">' + head + tabs + editBar + grid + '</div>';
  }

  function viewGuests() {
    const d = D(); const t = state.table;
    let g = d.pve.guests.filter((x) => (t.type === 'Alle' || x.type === t.type) && (t.status === 'Alle' || guestStatus(x.status)[1] === t.status.toLowerCase()) && (!t.q || (x.name + ' ' + x.vmid).toLowerCase().includes(t.q.toLowerCase())));
    const key = t.sort; const dir = t.dir === 'asc' ? 1 : -1;
    g = g.slice().sort((a, b) => { const va = a[key], vb = b[key]; if (va == null) return 1; if (vb == null) return -1; return (typeof va === 'string' ? va.localeCompare(vb, 'de') : va - vb) * dir; });
    const per = 50; const pages = Math.max(1, Math.ceil(g.length / per)); const page = Math.min(t.page, pages - 1);
    const rows = g.slice(page * per, page * per + per);
    const th = (k, l, cls) => '<th' + (cls ? ' class="' + cls + '"' : '') + (t.sort === k ? ' aria-sort="' + (t.dir === 'asc' ? 'ascending' : 'descending') + '"' : '') + '><button type="button" data-action="sort" data-k="' + k + '">' + l + (t.sort === k ? I(t.dir === 'asc' ? 'arrowUp' : 'arrowDown', 'icon-sm') : '') + '</button></th>';
    const all = d.pve.guests; const cnt = (f) => all.filter(f).length;
    const typeChips = ['Alle', 'VM', 'CT'].map((x) => '<button class="chip" type="button" data-action="tfilter" data-k="type" data-v="' + x + '" aria-pressed="' + (t.type === x) + '">' + (x === 'CT' ? 'Container' : x === 'VM' ? 'VMs' : 'Alle') + ' <span class="count">' + nf.format(x === 'Alle' ? all.length : cnt((y) => y.type === x)) + '</span></button>').join('');
    const stChips = ['Alle', 'Läuft', 'Gestoppt'].map((x) => '<button class="chip" type="button" data-action="tfilter" data-k="status" data-v="' + x + '" aria-pressed="' + (t.status === x) + '">' + (x === 'Alle' ? 'Jeder Status' : x) + '</button>').join('');
    const nameCell = (x) => '<div class="cell-name"><span class="type-tag" title="' + (x.type === 'VM' ? 'Virtuelle Maschine' : 'Container') + '">' + x.type + '</span><span class="t"><b title="' + esc(x.name) + '">' + esc(x.name || 'ohne Namen') + '</b>' + (x.note ? '<span>' + esc(x.note) + '</span>' : '') + '</span></div>';
    const memCell = (x) => (x.status !== 'running' ? '<span class="faint">aus</span> <span class="faint">/ ' + bytes(x.maxmem) + '</span>' : x.mem == null ? '<span class="faint">k. A.</span>' : bytes(x.mem) + ' <span class="faint">/ ' + bytes(x.maxmem) + '</span>');
    const table = rows.length ? '<div class="table-wrap responsive"><table class="data"><caption class="sr-only">Gäste auf Proxmox VE, ' + plural(g.length, 'Eintrag', 'Einträge') + '</caption><thead><tr>' + th('name', 'Name') + th('vmid', 'VMID', 'num') + th('status', 'Status') + th('node', 'Knoten') + th('cpu', 'CPU', 'num') + th('mem', 'RAM', 'num') + th('uptime', 'Laufzeit', 'num') + '<th>Tags</th></tr></thead><tbody>' +
      rows.map((x) => { const [sv, sl] = guestStatus(x.status); return '<tr tabindex="0" data-action="open-guest" data-id="' + x.vmid + '"><td class="name">' + nameCell(x) + '</td><td class="num mono">' + x.vmid + '</td><td>' + statusEl(sv, sl) + '</td><td class="truncate" style="max-width:160px" title="' + esc(x.node) + '">' + esc(x.node) + '</td><td class="num"><span class="mini-bar" aria-hidden="true"><i style="width:' + Math.min(100, x.cpu) + '%"></i></span>' + nf1.format(x.cpu) + ' %</td><td class="num">' + memCell(x) + '</td><td class="num">' + (x.status === 'running' ? dur(x.uptime) : '<span class="faint">aus</span>') + '</td><td>' + (x.tags.slice(0, 2).map((tg) => '<span class="tag" title="' + esc(tg) + '">' + esc(tg.length > 14 ? tg.slice(0, 12) + '…' : tg) + '</span>').join('') + (x.tags.length > 2 ? '<span class="tag">+' + (x.tags.length - 2) + '</span>' : '')) + '</td></tr>'; }).join('') +
      '</tbody></table><div class="table-foot"><span>' + nf.format(page * per + 1) + ' bis ' + nf.format(page * per + rows.length) + ' von ' + nf.format(g.length) + '</span><span style="display:flex;gap:4px"><button class="btn btn-sm btn-ghost" type="button" data-action="page" data-d="-1"' + (page ? '' : ' disabled') + '>Zurück</button><button class="btn btn-sm btn-ghost" type="button" data-action="page" data-d="1"' + (page < pages - 1 ? '' : ' disabled') + '>Weiter</button></span></div></div>' +
      '<div class="card-list">' + rows.map((x) => { const [sv, sl] = guestStatus(x.status); return '<a class="gcard" href="#/p/proxmox-ve/guests/' + x.vmid + '"><span class="cell-name"><span class="type-tag">' + x.type + '</span><b class="ink truncate">' + esc(x.name || 'ohne Namen') + '</b></span>' + statusEl(sv, sl) + '<span class="meta"><span class="mono">' + x.vmid + '</span><span>CPU ' + nf1.format(x.cpu) + ' %</span><span>RAM ' + memCell(x) + '</span></span></a>'; }).join('') + '</div>'
      : '<div class="card card-pad" style="display:grid;gap:8px"><b class="ink">' + (all.length ? 'Kein Gast passt zu den Filtern.' : 'Noch keine Gäste.') + '</b><span class="muted">' + (all.length ? 'Setze die Filter zurück oder suche nach VMID.' : 'Lege in Proxmox eine VM oder einen Container an. Er erscheint hier nach dem nächsten Abruf.') + '</span>' + (all.length ? '<button class="btn btn-sm" type="button" data-action="treset" style="justify-self:start">Filter zurücksetzen</button>' : '') + '</div>';
    const content = '<div class="page-head"><div><h1>Gäste</h1><p class="lede">VMs und Container auf ' + esc(d.pve.node.name) + '. Klick auf eine Zeile öffnet Details und Aktionen.</p></div></div>' +
      '<div class="toolbar"><div class="search">' + I('search') + '<input class="input" type="search" placeholder="Name oder VMID" aria-label="Gäste durchsuchen" data-action="tsearch" value="' + esc(t.q) + '"></div><div class="chips" role="group" aria-label="Typ">' + typeChips + '</div><div class="chips" role="group" aria-label="Status">' + stChips + '</div></div>' + table;
    return shell('proxmox-ve', '<span>Proxmox VE</span>' + I('chevronRight', 'icon-sm') + '<b>Gäste</b>', content);
  }

  function viewGuestDetail(vmid) {
    const d = D(); const g = d.pve.guests.find((x) => String(x.vmid) === String(vmid)) || d.pve.guests[0];
    if (!g) return shell('proxmox-ve', '<b>Gast</b>', '<div class="card card-pad" style="display:grid;gap:8px"><h1>Gast nicht gefunden</h1><p class="muted">Der Gast wurde gelöscht oder ist nicht mehr sichtbar. <a href="#/p/proxmox-ve/guests">Zur Liste der Gäste</a></p></div>');
    const [sv, sl] = guestStatus(g.status); const running = g.status === 'running';
    const actions = [
      ['start', 'play', 'Starten', !running, 'low'], ['shutdown', 'power', 'Herunterfahren', running, 'medium'],
      ['reboot', 'refresh', 'Neustarten', running, 'medium'], ['stop', 'stop', 'Hart stoppen', running, 'high'], ['snapshot', 'camera', 'Snapshot anlegen', true, 'low'],
    ];
    const content = '<div class="detail-head"><span class="type-tag" style="height:32px;min-width:42px;font-size:var(--fs-3)">' + g.type + '</span><div style="min-width:0"><h1 class="wrap-any">' + esc(g.name || 'ohne Namen') + '</h1><div class="ids"><span class="mono">VMID ' + g.vmid + '</span><span>Knoten ' + esc(g.node) + '</span>' + statusEl(sv, sl) + '<span>Laufzeit ' + dur(g.uptime) + '</span></div></div></div>' +
      '<div class="action-bar" role="group" aria-label="Aktionen">' + actions.map(([id, ic, l, en, r]) => '<button class="btn ' + (r === 'high' ? 'btn-outline' : '') + '" type="button" data-action="guest-action" data-id="' + id + '" data-risk="' + r + '"' + (en ? '' : ' disabled') + '>' + I(ic) + l + '</button>').join('') + '<span class="faint" style="align-self:center;font-size:var(--fs-2)">Jede Aktion wird im Audit-Log vermerkt.</span></div>' +
      '<div class="two-col"><div class="stack">' +
      '<section class="panel" aria-labelledby="c1"><div class="panel-head"><h2 id="c1">CPU, letzte 24 Stunden</h2><div class="segmented" role="group" aria-label="Zeitraum"><button type="button" aria-pressed="false">1 h</button><button type="button" aria-pressed="true">24 h</button><button type="button" aria-pressed="false">7 T</button><button type="button" aria-pressed="false">30 T</button></div></div><div class="chart-box">' + chartSlot('gcpu', [{ name: 'CPU', values: d.pve.guestCpu24h, color: 'var(--series-1)' }], { unit: '%' }) + '</div></section>' +
      '<section class="panel" aria-labelledby="c2"><div class="panel-head"><h2 id="c2">Arbeitsspeicher, letzte 24 Stunden</h2></div><div class="chart-box">' + chartSlot('gmem', [{ name: 'RAM belegt', values: d.pve.guestMem24h, color: 'var(--series-1)' }, { name: 'Host-Sicht', values: d.pve.guestMem24h.map((v) => v * 1.18), color: 'var(--series-2)' }], { unit: '%' }) + '</div></section>' +
      '<section class="panel" aria-labelledby="c3"><div class="panel-head"><h2 id="c3">Aufgaben</h2><a href="#/p/proxmox-ve/guests" style="font-size:var(--fs-3)">Alle Aufgaben</a></div>' + (d.pve.tasks.length ? '<ul class="list">' + d.pve.tasks.map((t) => '<li>' + statusEl(t.result === 'OK' ? 'ok' : 'crit', t.result === 'OK' ? 'OK' : 'Fehler') + '<div class="grow"><div class="line1">' + esc(t.what) + '</div><div class="line2">' + esc(t.result === 'OK' ? t.dur : t.result) + '</div></div><span class="end">' + esc(t.when) + '</span></li>').join('') + '</ul>' : '<p class="muted">Keine Aufgaben in den letzten 7 Tagen.</p>') + '</section>' +
      '</div><div class="stack">' +
      '<section class="panel" aria-labelledby="r1"><h2 id="r1">Ressourcen</h2>' + meter('CPU', g.cpu / 100) + meter('RAM, ' + bytes(g.mem) + ' von ' + bytes(g.maxmem), g.mem == null ? null : g.mem / g.maxmem) + '<dl class="kv"><dt>Typ</dt><dd>' + (g.type === 'VM' ? 'QEMU-VM' : 'LXC-Container') + '</dd><dt>Tags</dt><dd>' + (g.tags.length ? esc(g.tags.join(', ')) : 'keine') + '</dd><dt>Gast-IP</dt><dd class="mono">192.168.2.204</dd></dl></section>' +
      '<section class="panel" aria-labelledby="r2"><div class="panel-head"><h2 id="r2">Snapshots</h2><button class="btn btn-sm" type="button" data-action="guest-action" data-id="snapshot" data-risk="low">' + I('camera', 'icon-sm') + 'Anlegen</button></div>' + (d.pve.snapshots.length ? '<ul class="list">' + d.pve.snapshots.map((s) => '<li><div class="grow"><div class="line1 mono">' + esc(s.name) + '</div><div class="line2">' + esc(s.when) + (s.note ? ', ' + esc(s.note) : '') + '</div></div></li>').join('') + '</ul>' : '<p class="muted">Keine Snapshots.</p>') + '</section>' +
      '<section class="panel" aria-labelledby="r3"><div class="panel-head"><h2 id="r3">Backups</h2><a href="#/dashboard" style="font-size:var(--fs-3)">In PBS öffnen</a></div><dl class="kv"><dt>Letzte Sicherung</dt><dd>heute, 02:15</dd><dt>Verify</dt><dd>' + statusEl('ok', 'OK') + '</dd><dt>Größe (logisch)</dt><dd>38,2 GiB</dd></dl></section>' +
      '</div></div>';
    return shell('proxmox-ve', '<a href="#/p/proxmox-ve/guests" style="text-decoration:none;color:inherit">Proxmox VE</a>' + I('chevronRight', 'icon-sm') + '<a href="#/p/proxmox-ve/guests" style="text-decoration:none;color:inherit">Gäste</a>' + I('chevronRight', 'icon-sm') + '<b class="truncate">' + esc(g.name || g.vmid) + '</b>', content);
  }

  function viewSettings() {
    const d = D();
    const stMap = { active: ['ok', 'Aktiv'], paused: ['paused', 'Pausiert'], draft: ['unknown', 'Entwurf'] };
    const list = d.instances.length ? '<div class="inst-list">' + d.instances.map((x) => {
      const p = pluginById(x.plugin); const [sv, sl] = stMap[x.status];
      const h = x.status === 'active' && x.health !== 'ok' ? badge(x.health, x.health === 'crit' ? 'Fehler' : 'Warnung') : badge(sv, sl);
      return '<div class="inst"><span class="logo logo-sm" aria-hidden="true">' + esc(p.mono) + '</span><div class="name"><b>' + esc(x.name) + '</b><span title="' + esc(x.target) + '">' + esc(p.name) + ', ' + esc(x.target) + '</span></div>' +
        '<div class="col"><span>Zustand</span>' + h + '</div><div class="col"><span>Aktionen</span><b>' + esc(x.actions) + '</b><span>Zuletzt getestet ' + esc(x.tested) + '</span></div>' +
        '<div class="row-actions"><button class="btn btn-sm" type="button" data-action="edit-inst" data-id="' + x.id + '">Bearbeiten</button><button class="icon-btn" type="button" data-action="inst-menu" data-id="' + x.id + '" aria-label="Weitere Aktionen für ' + esc(x.name) + '" aria-haspopup="menu">' + I('more') + '</button></div></div>';
    }).join('') + '</div>' : '<div class="card card-pad" style="display:grid;gap:12px;justify-items:start"><h2>Noch keine Infrastruktur verbunden</h2><p class="muted">Ein Plugin bringt Daten, Widgets und Seiten mit. Starte mit dem System, das du am häufigsten prüfst.</p><a class="btn btn-primary" href="#/onboarding/catalog" style="text-decoration:none">' + I('plus') + 'Plugin hinzufügen</a></div>';
    const content = '<div class="page-head"><div><h1>Infrastruktur</h1><p class="lede">Verbundene Systeme. Pausierte Plugins behalten ihre Konfiguration, sammeln aber keine Daten.</p></div><div class="page-actions"><a class="btn btn-primary" href="#/onboarding/catalog" style="text-decoration:none">' + I('plus') + 'Plugin hinzufügen</a></div></div>' + list;
    return shell('settings', '<span>Einstellungen</span>' + I('chevronRight', 'icon-sm') + '<b>Infrastruktur</b>', content);
  }

  /* ---------- overlays ---------- */
  function picker(names, active, kind) {
    if (!state.chrome) return '';
    return '<nav class="proto-picker" aria-label="Prototype variants" data-kind="' + kind + '"><span class="proto-picker-highlight" aria-hidden="true"></span>' +
      names.map((n, i) => '<button class="proto-picker-item"' + (i === active ? ' data-active aria-current="true"' : '') + ' data-pick="' + i + '">' + n + '</button>').join('') + '</nav>';
  }
  function devbar() {
    if (!state.chrome) return '';
    const seg = (key, opts) => '<span class="seg">' + opts.map(([v, l]) => '<button type="button" data-dev="' + key + '" data-v="' + v + '" aria-pressed="' + (state[key] === v) + '">' + l + '</button>').join('') + '</span>';
    const r = route().path;
    const loginSeg = r.startsWith('/login') ? '<span class="lbl">Zustand</span>' + seg('loginState', [['normal', 'Normal'], ['error', 'Fehler'], ['locked', 'Gesperrt'], ['2fa', '2FA'], ['setup', 'Setup']]) : '';
    return '<div class="devbar" role="region" aria-label="Vorschau-Steuerung (nicht Teil des Designs)"><a href="#/" style="color:#222;padding:0 4px">Ansichten</a><span class="lbl">Daten</span>' + seg('data', [['demo', 'Demo'], ['worst', 'Worst case'], ['empty', 'Leer']]) + '<span class="lbl">Schema</span>' + seg('theme', [['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']]) + loginSeg + '</div>';
  }
  function openDialog(html, onMount) {
    const dlg = document.getElementById('dialog');
    dlg.innerHTML = html; dlg.showModal();
    if (onMount) onMount(dlg);
    const first = dlg.querySelector('[autofocus], input, button.btn-primary, button');
    if (first) first.focus();
  }
  function closeDialog() { const dlg = document.getElementById('dialog'); if (dlg.open) dlg.close(); }
  function toast(title, msg, opts) {
    const host = document.getElementById('toasts');
    const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status');
    const sev = (opts && opts.sev) || 'ok';
    el.innerHTML = '<span class="status status-' + sev + '">' + I(SEV[sev].icon) + '</span><div><b></b><span class="m"></span>' + (opts && opts.progress ? '<div class="progress"><i></i></div>' : '') + '</div><button class="icon-btn icon-btn-sm" type="button" aria-label="Schließen">' + I('x', 'icon-sm') + '</button>';
    el.querySelector('b').textContent = title; el.querySelector('.m').textContent = msg;
    el.querySelector('button').onclick = () => el.remove();
    host.appendChild(el);
    if (opts && opts.progress) requestAnimationFrame(() => { el.querySelector('.progress i').style.width = '100%'; });
    setTimeout(() => el.remove(), (opts && opts.ttl) || 5200);
    return el;
  }
  function openMenu(anchor, items) {
    closeMenu();
    const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu'); m.id = 'menu';
    m.innerHTML = items.map((it) => (it === '-' ? '<hr>' : '<button type="button" role="menuitem" data-menu="' + it.id + '"' + (it.danger ? ' class="danger"' : '') + '>' + I(it.icon, 'icon-sm') + esc(it.label) + '</button>')).join('');
    (anchor.closest('main') || document.body).appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + window.scrollY + 6) + 'px';
    m.style.left = Math.max(8, r.right + window.scrollX - m.offsetWidth) + 'px';
    m.querySelector('button').focus();
    m.addEventListener('click', (e) => { const b = e.target.closest('[data-menu]'); if (!b) return; const it = items.find((x) => x.id === b.dataset.menu); closeMenu(); anchor.focus(); if (it && it.run) it.run(); });
    m.addEventListener('keydown', (e) => {
      const btns = [...m.querySelectorAll('button')]; const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { btns[(i + 1) % btns.length].focus(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { btns[(i - 1 + btns.length) % btns.length].focus(); e.preventDefault(); }
      if (e.key === 'Escape') { closeMenu(); anchor.focus(); }
    });
  }
  function closeMenu() { const m = document.getElementById('menu'); if (m) m.remove(); }

  function confirmAction(kind, risk) {
    const d = D(); const g = d.pve.guests.find((x) => String(x.vmid) === String(route().parts[3])) || d.pve.guests[0] || { name: 'gast', vmid: 0 };
    const label = { start: 'starten', shutdown: 'herunterfahren', reboot: 'neu starten', stop: 'hart stoppen', snapshot: 'Snapshot anlegen' }[kind];
    const riskTxt = { low: 'gering', medium: 'mittel', high: 'hoch' }[risk];
    const what = kind === 'snapshot' ? 'Snapshot von ' + g.name + ' anlegen?' : g.name + ' ' + label + '?';
    const expl = {
      start: 'Der Gast startet auf ' + g.node + '. Es gibt keine Unterbrechung für andere Dienste.',
      shutdown: 'Der Gast wird sauber heruntergefahren. Dienste darin sind bis zum nächsten Start nicht erreichbar.',
      reboot: 'Der Gast startet neu. Dienste darin sind etwa eine Minute nicht erreichbar.',
      stop: 'Der Gast wird sofort ausgeschaltet, ohne sauberes Herunterfahren. Nicht gespeicherte Daten gehen verloren.',
      snapshot: 'Proxmox legt einen Snapshot ohne Arbeitsspeicher an. Das dauert wenige Sekunden.',
    }[kind];
    const high = risk === 'high';
    openDialog('<form method="dialog" class="modal-body" data-action="confirm-form"><div class="modal-head"><div style="flex:1"><h2>' + esc(what) + '</h2></div><span class="badge badge-risk-' + risk + '">Risiko ' + riskTxt + '</span></div><p>' + esc(expl) + '</p>' +
      (high ? '<div class="callout crit">' + I('warn') + '<div><b>Bestätige deine Identität.</b> Für Aktionen mit hohem Risiko fragen wir alle 10 Minuten erneut.</div></div><div class="field"><label class="field-label" for="cf-name">Tippe den Namen des Gasts zur Bestätigung: <span class="mono">' + esc(g.name) + '</span></label><input class="input mono" id="cf-name" autocomplete="off" spellcheck="false" data-expect="' + esc(g.name) + '"></div><div class="field"><label class="field-label" for="cf-pw">Passwort</label><input class="input" id="cf-pw" type="password" autocomplete="current-password"></div>' : '') +
      '</form><div class="modal-foot"><button class="btn btn-ghost" type="button" data-action="close-dialog">Abbrechen</button><button class="btn ' + (high ? 'btn-danger' : 'btn-primary') + '" type="button" data-action="run-action" data-kind="' + kind + '"' + (high ? ' disabled' : '') + '>' + esc(kind === 'snapshot' ? 'Snapshot anlegen' : g.name + ' ' + label) + '</button></div>', (dlg) => {
      const inp = dlg.querySelector('#cf-name'); if (!inp) return;
      const pw = dlg.querySelector('#cf-pw');
      const sync = () => { dlg.querySelector('[data-action="run-action"]').disabled = inp.value !== inp.dataset.expect || !pw.value; };
      inp.addEventListener('input', sync); pw.addEventListener('input', sync);
    });
  }

  function openPalette() {
    const d = D();
    const items = [
      { g: 'Seiten', l: 'Dashboard', h: '#/dashboard', i: 'dashboard' },
      { g: 'Seiten', l: 'Proxmox VE: Gäste', h: '#/p/proxmox-ve/guests', i: 'server' },
      { g: 'Seiten', l: 'Einstellungen: Infrastruktur', h: '#/settings/infrastructure', i: 'plug' },
      ...d.pve.guests.slice(0, 40).map((x) => ({ g: 'Gäste', l: (x.name || 'ohne Namen') + ' (' + x.vmid + ')', h: '#/p/proxmox-ve/guests/' + x.vmid, i: x.type === 'VM' ? 'guest' : 'container' })),
      { g: 'Befehle', l: 'Plugin hinzufügen', h: '#/onboarding/catalog', i: 'plus' },
      { g: 'Befehle', l: 'Dashboard bearbeiten', h: '#/dashboard/edit', i: 'edit' },
      { g: 'Befehle', l: 'Abmelden', h: '#/login', i: 'logout' },
    ];
    const wrap = document.createElement('div'); wrap.className = 'palette-backdrop'; wrap.id = 'palette';
    wrap.innerHTML = '<div class="palette" role="dialog" aria-modal="true" aria-label="Suchen und Befehle"><input type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" placeholder="Seite, Gast oder Befehl suchen" autocomplete="off"><ul id="pal-list" role="listbox"></ul></div>';
    document.body.appendChild(wrap);
    const input = wrap.querySelector('input'); const ul = wrap.querySelector('ul'); let sel = 0; let shown = [];
    const render = () => {
      const q = input.value.toLowerCase(); shown = items.filter((x) => !q || x.l.toLowerCase().includes(q));
      if (sel >= shown.length) sel = 0;
      let last = ''; let html = '';
      shown.forEach((x, i) => { if (x.g !== last) { html += '<li class="grp" role="presentation">' + esc(x.g) + '</li>'; last = x.g; } html += '<li role="option" id="pal-' + i + '" data-i="' + i + '" aria-selected="' + (i === sel) + '">' + I(x.i) + '<span>' + esc(x.l) + '</span>' + (i === sel ? '<span class="hint">Eingabe</span>' : '') + '</li>'; });
      ul.innerHTML = html || '<li class="grp" role="presentation">Nichts gefunden</li>';
      input.setAttribute('aria-activedescendant', shown.length ? 'pal-' + sel : '');
      const cur = ul.querySelector('[aria-selected="true"]'); if (cur) cur.scrollIntoView({ block: 'nearest' });
    };
    const close = () => wrap.remove();
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter' && shown[sel]) { close(); go(shown[sel].h); }
      else if (e.key === 'Escape') close();
    });
    ul.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) { close(); go(shown[+li.dataset.i].h); } });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    render(); input.focus();
  }

  function openDrawer(title, body, foot) {
    closeDrawer();
    const b = document.createElement('div'); b.className = 'drawer-backdrop'; b.id = 'drawer-bd';
    const d = document.createElement('div'); d.className = 'drawer'; d.id = 'drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'drawer-h');
    d.innerHTML = '<div class="drawer-head"><h2 id="drawer-h">' + esc(title) + '</h2><button class="icon-btn" type="button" data-action="close-drawer" aria-label="Schließen">' + I('x') + '</button></div><div class="drawer-body">' + body + '</div>' + (foot ? '<div class="drawer-foot">' + foot + '</div>' : '');
    document.body.append(b, d);
    b.addEventListener('click', closeDrawer);
    d.querySelector('button').focus();
  }
  function closeDrawer() { ['drawer', 'drawer-bd'].forEach((id) => { const el = document.getElementById(id); if (el) el.remove(); }); }

  /* ---------- layout editing ---------- */
  const snapshot = () => JSON.stringify(state.layout);
  function commit(mutator, msg) { state.undo.push(snapshot()); state.redo = []; mutator(); if (msg) announce(msg); render(); }
  function moveWidget(id, delta) {
    const i = state.layout.findIndex((w) => w.id === id); const j = i + delta;
    if (i < 0 || j < 0 || j >= state.layout.length) return false;
    const [w] = state.layout.splice(i, 1); state.layout.splice(j, 0, w); return true;
  }

  /* ---------- render ---------- */
  function render() {
    applyTheme();
    const r = route(); const p = r.parts;
    let html;
    if (!p.length) html = viewIndex();
    else if (p[0] === 'login') html = viewLogin();
    else if (p[0] === 'onboarding') html = p[1] === 'connect' ? viewConnect() : p[1] === 'permissions' ? viewPermissions() : p[1] === 'layout' ? viewLayout() : viewCatalog();
    else if (p[0] === 'dashboard') html = shell('dashboard', '<b>Dashboard</b>', viewDashboard(p[1] === 'edit')) + (p[1] === 'edit' ? '' : picker(['Ruhig', 'Dicht', 'Statusleiste'], ['calm', 'dense', 'status'].indexOf(state.card), 'card'));
    else if (p[0] === 'p' && p[1] === 'proxmox-ve') html = p[3] ? viewGuestDetail(p[3]) : viewGuests();
    else if (p[0] === 'settings') html = viewSettings();
    else html = viewIndex();
    const root = document.getElementById('root');
    const active = document.activeElement; const activeKey = active && (active.dataset.action ? active.dataset.action + (active.dataset.id || '') + (active.dataset.v || '') + (active.dataset.size || '') : active.id);
    root.innerHTML = html + devbar();
    if (activeKey) {
      const again = [...root.querySelectorAll('[data-action], [id]')].find((el) => (el.dataset.action ? el.dataset.action + (el.dataset.id || '') + (el.dataset.v || '') + (el.dataset.size || '') : el.id) === activeKey);
      if (again && again.tagName !== 'MAIN') { again.focus(); if (again.tagName === 'INPUT' && again.type !== 'checkbox') { const v = again.value; again.setSelectionRange && again.type === 'search' && again.setSelectionRange(v.length, v.length); } }
    }
    const keepWidget = state.grabbed || (active && active.matches && active.matches('.widget[data-id]') ? active.dataset.id : null);
    if (keepWidget) { const el = root.querySelector('.widget[data-id="' + keepWidget + '"]'); if (el) el.focus(); }
    drawCharts();
    fitWidgets();
    initPicker();
    document.title = (document.querySelector('h1') ? document.querySelector('h1').textContent + ', ' : '') + 'rxf-sys Control (Vorschau)';
  }
  /* Fixed-height widgets never clip or scroll: fitted lists drop trailing items until the body fits and count them in the "more" line */
  function fitWidgets() {
    document.querySelectorAll('.widget-body > [data-fit-dropped]').forEach((x) => { x.hidden = false; delete x.dataset.fitDropped; });
    document.querySelectorAll('.widget-body [data-fit]').forEach((list) => {
      const body = list.closest('.widget-body'); const items = [...list.children]; const more = body.querySelector('[data-fit-more]');
      let hidden = 0;
      const label = () => {
        if (!more) return;
        const n = hidden + Number(more.dataset.extra);
        more.hidden = !n; more.textContent = n ? plural(n, more.dataset.one, more.dataset.many) + more.dataset.suffix : '';
      };
      items.forEach((x) => { x.hidden = false; });
      label();
      while (body.scrollHeight > body.clientHeight + 1 && items.length - hidden > 1) { items[items.length - 1 - hidden].hidden = true; hidden++; label(); }
    });
    /* fallback, mostly for S widgets in edit mode: drop trailing secondary blocks, keep the first */
    document.querySelectorAll('.widget-body').forEach((body) => {
      const kids = [...body.children].filter((k) => !k.hidden);
      while (body.scrollHeight > body.clientHeight + 1 && kids.length > 1) { const k = kids.pop(); k.hidden = true; k.dataset.fitDropped = ''; }
    });
  }
  function initPicker() {
    const pk = document.querySelector('.proto-picker'); if (!pk) return;
    const hl = pk.querySelector('.proto-picker-highlight'); const items = [...pk.querySelectorAll('.proto-picker-item')];
    const act = items.findIndex((x) => x.hasAttribute('data-active'));
    const el = items[Math.max(0, act)]; hl.style.width = el.offsetWidth + 'px'; hl.style.transform = 'translateX(' + el.offsetLeft + 'px)';
    requestAnimationFrame(() => requestAnimationFrame(() => pk.setAttribute('data-ready', '')));
  }
  function setPick(kind, i) {
    if (kind === 'card') state.card = ['calm', 'dense', 'status'][i];
    if (kind === 'catalog') state.catalogView = ['grid', 'list', 'groups'][i];
    const url = new URL(location); url.searchParams.set('v', i + 1); history.replaceState(null, '', url);
    render();
  }

  /* ---------- events ---------- */
  document.addEventListener('click', (e) => {
    const pk = e.target.closest('[data-pick]');
    if (pk) { setPick(pk.closest('.proto-picker').dataset.kind, +pk.dataset.pick); return; }
    const dev = e.target.closest('[data-dev]');
    if (dev) { state[dev.dataset.dev] = dev.dataset.v; if (dev.dataset.dev === 'data') { state.layout = null; state.table.page = 0; } render(); return; }
    if (!e.target.closest('#menu')) closeMenu();
    const el = e.target.closest('[data-action]'); if (!el) {
      if (state.navOpen && e.target.classList && e.target.classList.contains('app')) { state.navOpen = false; render(); }
      return;
    }
    const a = el.dataset.action; const id = el.dataset.id;
    switch (a) {
      case 'go': go(el.dataset.href); break;
      case 'nav': state.navOpen = !state.navOpen; render(); break;
      case 'theme': state.theme = { system: 'light', light: 'dark', dark: 'system' }[state.theme]; render(); announce('Farbschema: ' + { system: 'System', light: 'Hell', dark: 'Dunkel' }[state.theme]); break;
      case 'palette': openPalette(); break;
      case 'toggle-pw': { const inp = document.getElementById('p'); inp.type = inp.type === 'password' ? 'text' : 'password'; el.setAttribute('aria-label', inp.type === 'password' ? 'Passwort anzeigen' : 'Passwort verbergen'); break; }
      case 'pick': state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id); render(); break;
      case 'cat-filter': state.catalogFilter = el.dataset.cat; render(); break;
      case 'test-conn': state.connect = { tested: true, trusted: false, error: false }; render(); toast('Verbindung steht', 'Ein Zertifikat muss noch bestätigt werden.', { sev: 'warn' }); break;
      case 'test-fail': state.connect = { tested: false, trusted: false, error: true }; render(); break;
      case 'tofu': openDialog('<div class="modal-body"><div class="modal-head"><h2 style="flex:1">Zertifikat von 192.168.2.200 prüfen</h2></div><p>Proxmox nutzt ein selbstsigniertes Zertifikat. Vergleiche den Fingerprint mit der Anzeige auf dem Server, bevor du ihm vertraust.</p><div class="fingerprint" aria-label="SHA-256-Fingerprint">5A:3C:91:E0:7B:44:D2:1F:88:0E:C6:5B:93:A7:2D:F1:04:6E:BB:39:C8:15:7A:E2:60:D9:4F:13:AB:82:57:CE</div><dl class="kv"><dt>Aussteller</dt><dd>Proxmox Virtual Environment</dd><dt>Gültig bis</dt><dd>14.08.2028</dd><dt>Gilt für</dt><dd class="mono">rxf-sys, 192.168.2.200</dd></dl><div class="callout info">' + I('info') + '<div>So findest du den Wert: Auf dem Proxmox-Host <code class="mono">pvenode cert info</code> ausführen oder in der Weboberfläche unter Knoten, System, Zertifikate nachsehen.</div></div></div><div class="modal-foot"><button class="btn btn-ghost" type="button" data-action="close-dialog">Abbrechen</button><button class="btn btn-primary" type="button" data-action="trust">Zertifikat vertrauen</button></div>'); break;
      case 'trust': closeDialog(); state.connect = { tested: true, trusted: true, error: false }; render(); toast('Proxmox VE verbunden', 'Zertifikat gespeichert. Leserechte geprüft, ein Hinweis offen.'); break;
      case 'perm': state.perms[id] = el.dataset.v; render(); break;
      case 'tpl': state.template = id; render(); break;
      case 'apply-template': state.layout = layoutFrom(TEMPLATES[state.template]); state.undo = []; state.redo = []; go('#/dashboard'); toast('Dashboard bereit', 'Vorlage übernommen. Über „Bearbeiten“ passt du alles an.'); break;
      case 'board': state.board = id; render(); break;
      case 'done-edit': go('#/dashboard'); toast('Board gespeichert', 'Die Anordnung gilt für dieses Gerät und alle anderen.'); break;
      case 'resize': if (el.disabled) break; commit(() => { state.layout.find((w) => w.id === id).size = el.dataset.size; }, WIDGETS[id].title + ': Größe ' + el.dataset.size); break;
      case 'remove-widget': commit(() => { state.layout = state.layout.filter((w) => w.id !== id); }, WIDGETS[id].title + ' entfernt. Rückgängig mit Strg+Z.'); toast('Widget entfernt', WIDGETS[id].title + '. Rückgängig mit Strg+Z.', { sev: 'unknown' }); break;
      case 'undo': if (state.undo.length) { state.redo.push(snapshot()); state.layout = JSON.parse(state.undo.pop()); announce('Rückgängig gemacht'); render(); } break;
      case 'redo': if (state.redo.length) { state.undo.push(snapshot()); state.layout = JSON.parse(state.redo.pop()); announce('Wiederholt'); render(); } break;
      case 'reset': commit(() => { state.layout = layoutFrom(TEMPLATES.overview); }, 'Auf Vorlage zurückgesetzt'); toast('Auf Vorlage zurückgesetzt', 'Rückgängig mit Strg+Z.', { sev: 'unknown' }); break;
      case 'export': openDialog('<div class="modal-body"><h2>Board exportieren</h2><p class="muted">Dieses JSON lässt sich auf einer anderen Instanz importieren. Es enthält keine Zugangsdaten.</p><textarea class="input mono" style="min-height:220px;padding:12px;font-size:var(--fs-2)" readonly>' + esc(JSON.stringify({ version: 1, name: 'Übersicht', layouts: { lg: state.layout } }, null, 2)) + '</textarea></div><div class="modal-foot"><button class="btn btn-ghost" type="button" data-action="close-dialog">Schließen</button><button class="btn btn-primary" type="button" data-action="close-dialog">' + I('download') + 'Datei speichern</button></div>'); break;
      case 'import': openDialog('<div class="modal-body"><h2>Board importieren</h2><p class="muted">Füge exportiertes JSON ein. Widgets von Plugins, die hier nicht aktiv sind, werden übersprungen.</p><textarea class="input mono" style="min-height:180px;padding:12px" placeholder="{ &quot;version&quot;: 1, ... }"></textarea></div><div class="modal-foot"><button class="btn btn-ghost" type="button" data-action="close-dialog">Abbrechen</button><button class="btn btn-primary" type="button" data-action="close-dialog">Importieren</button></div>'); break;
      case 'add-widget': {
        const active = new Set(D().instances.filter((x) => x.status !== 'draft').map((x) => x.plugin));
        const avail = Object.entries(WIDGETS).filter(([wid, m]) => (!m.plugin || active.has(m.plugin)) && !state.layout.some((w) => w.id === wid));
        const groups = {}; avail.forEach(([wid, m]) => { const k = m.plugin ? pluginById(m.plugin).name : 'Plugin-übergreifend'; (groups[k] = groups[k] || []).push([wid, m]); });
        openDrawer('Widget hinzufügen', Object.keys(groups).length ? Object.entries(groups).map(([g, ws]) => '<section class="wcat"><h3 class="muted" style="font-size:var(--fs-2)">' + esc(g) + '</h3>' + ws.map(([wid, m]) => '<button class="wcat-item" type="button" data-action="add-one" data-id="' + wid + '">' + '<span class="widget-icon">' + I(m.icon || PLUGIN_ICON[m.plugin] || 'info') + '</span><span class="grow"><b>' + esc(m.title) + '</b><span class="sz">Größen ' + m.sizes.join(', ') + '</span></span>' + I('plus') + '</button>').join('') + '</section>').join('') : '<p class="muted">Alle verfügbaren Widgets sind schon auf dem Board. Weitere kommen mit neuen Plugins.</p>');
        break;
      }
      case 'add-one': closeDrawer(); commit(() => { state.layout.push({ id, size: WIDGETS[id].def }); }, WIDGETS[id].title + ' hinzugefügt'); break;
      case 'close-drawer': closeDrawer(); break;
      case 'close-dialog': closeDialog(); break;
      case 'widget-menu': openMenu(el, [{ id: 'set', label: 'Einstellungen', icon: 'settings' }, { id: 'det', label: 'Details öffnen', icon: 'external', run: () => go('#/p/proxmox-ve/guests') }, '-', { id: 'rm', label: 'Entfernen', icon: 'trash', danger: true, run: () => { commit(() => { state.layout = state.layout.filter((w) => w.id !== id); }); toast('Widget entfernt', 'Rückgängig über Bearbeiten.', { sev: 'unknown' }); } }]); break;
      case 'chart-table': state.chartTable[id] = !state.chartTable[id]; render(); break;
      case 'sort': { const k = el.dataset.k; state.table.dir = state.table.sort === k && state.table.dir === 'asc' ? 'desc' : 'asc'; state.table.sort = k; render(); break; }
      case 'tfilter': state.table[el.dataset.k] = el.dataset.v; state.table.page = 0; render(); break;
      case 'treset': state.table = Object.assign(state.table, { q: '', type: 'Alle', status: 'Alle', page: 0 }); render(); break;
      case 'page': state.table.page = Math.max(0, state.table.page + +el.dataset.d); render(); break;
      case 'open-guest': go('#/p/proxmox-ve/guests/' + id); break;
      case 'guest-action': confirmAction(id, el.dataset.risk); break;
      case 'run-action': {
        const kind = el.dataset.kind; closeDialog();
        const g = D().pve.guests.find((x) => String(x.vmid) === String(route().parts[3])) || {};
        const t = toast({ start: 'Start läuft', shutdown: 'Herunterfahren läuft', reboot: 'Neustart läuft', stop: 'Stopp läuft', snapshot: 'Snapshot wird angelegt' }[kind], (g.name || '') + ', Task UPID:rxf-sys:0001A2F3', { sev: 'unknown', progress: true, ttl: 1400 });
        setTimeout(() => toast({ start: 'Gestartet', shutdown: 'Heruntergefahren', reboot: 'Neustart abgeschlossen', stop: 'Gestoppt', snapshot: 'Snapshot angelegt' }[kind], (g.name || '') + '. Im Audit-Log vermerkt.'), 1500);
        break;
      }
      case 'edit-inst': {
        const x = D().instances.find((i) => i.id === id);
        openDrawer(x.name, '<div class="field"><label class="field-label" for="e-name">Name</label><input class="input" id="e-name" value="' + esc(x.name) + '"></div><div class="field"><label class="field-label" for="e-t">Ziel</label><input class="input mono" id="e-t" value="' + esc(x.target) + '"><span class="field-hint">Nur Admins ändern Ziele. Speichern verlangt eine erneute Bestätigung deiner Identität.</span></div>' +
          '<div class="field"><span class="field-label">Token-Secret</span><div class="secret-set"><span class="state">' + I('lock', 'icon-sm') + 'Gesetzt' + (x.secretAge ? '<span class="faint" style="font-weight:400">, geändert ' + esc(x.secretAge) + '</span>' : '') + '</span><button class="btn btn-sm" type="button">Ersetzen</button></div><span class="field-hint">Der Wert wird nie wieder angezeigt. Ersetzen ist die einzige Änderung.</span></div>' +
          '<div class="field"><span class="field-label">Aktionen</span><label class="switch"><input type="checkbox"' + (x.actions !== 'Nur lesen' ? ' checked' : '') + '><span class="switch-track"></span><span>Aktionen erlauben<br><span class="muted" style="font-size:var(--fs-2)">' + esc(x.actions) + '</span></span></label></div>',
          '<button class="btn btn-ghost" type="button" data-action="close-drawer">Abbrechen</button><button class="btn" type="button" data-action="close-drawer">' + I('refresh', 'icon-sm') + 'Verbindung testen</button><button class="btn btn-primary" type="button" data-action="close-drawer">Speichern</button>');
        break;
      }
      case 'inst-menu': {
        const x = D().instances.find((i) => i.id === id);
        openMenu(el, [
          { id: 't', label: 'Verbindung testen', icon: 'refresh', run: () => toast('Test läuft', x.name, { sev: 'unknown', ttl: 1600 }) },
          { id: 'r', label: 'Secret ersetzen', icon: 'key' },
          { id: 'p', label: x.status === 'paused' ? 'Fortsetzen' : 'Pausieren', icon: x.status === 'paused' ? 'play' : 'paused', run: () => toast(x.status === 'paused' ? 'Fortgesetzt' : 'Pausiert', x.name + (x.status === 'paused' ? ' sammelt wieder Daten.' : '. Konfiguration bleibt, Widgets zeigen „pausiert“.'), { sev: x.status === 'paused' ? 'ok' : 'paused' }) },
          '-',
          { id: 'x', label: 'Entfernen', icon: 'trash', danger: true, run: () => openDialog('<div class="modal-body"><h2>' + esc(x.name) + ' entfernen?</h2><p>Konfiguration, Secrets, gesammelte Daten und alle Widgets dieser Instanz werden gelöscht. Das lässt sich nicht rückgängig machen.</p><div class="callout warn">' + I('download') + '<div><b>Vorher exportieren?</b> <button class="linkish" type="button">Konfiguration und Verlauf als JSON speichern</button> (ohne Secrets)</div></div><div class="field"><label class="field-label" for="rm-n">Tippe zur Bestätigung den Namen: <span class="mono">' + esc(x.name) + '</span></label><input class="input" id="rm-n" autocomplete="off" data-expect="' + esc(x.name) + '"></div></div><div class="modal-foot"><button class="btn btn-ghost" type="button" data-action="close-dialog">Abbrechen</button><button class="btn btn-danger" type="button" data-action="close-dialog" disabled id="rm-go">Endgültig entfernen</button></div>', (dlg) => { const i = dlg.querySelector('#rm-n'); i.addEventListener('input', () => { dlg.querySelector('#rm-go').disabled = i.value !== i.dataset.expect; }); }) },
        ]);
        break;
      }
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-action="ha-toggle"]')) { state.haCoffee = e.target.checked; toast('Kaffeemaschine ' + (e.target.checked ? 'an' : 'aus'), 'switch.kaffeemaschine über Home Assistant geschaltet. Im Audit-Log vermerkt.'); render(); }
  });
  document.addEventListener('input', (e) => {
    const a = e.target.dataset.action;
    if (a === 'cat-search') { state.catalogQuery = e.target.value; render(); }
    if (a === 'tsearch') { state.table.q = e.target.value; state.table.page = 0; render(); }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.dataset.action === 'login-submit') {
      e.preventDefault();
      if (state.loginState === 'normal' || state.loginState === 'error') { state.loginState = '2fa'; render(); }
      else go('#/dashboard');
    }
  });
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!document.getElementById('palette')) openPalette(); return; }
    if (route().parts[1] === 'edit' && mod && e.key.toLowerCase() === 'z') { e.preventDefault(); document.querySelector('[data-action="' + (e.shiftKey ? 'redo' : 'undo') + '"]').click(); return; }
    if (e.key === 'Escape') { closeMenu(); closeDrawer(); if (state.navOpen) { state.navOpen = false; render(); } }
    const w = e.target.closest && e.target.closest('.editing .widget');
    if (w && e.target === w) {
      const id = w.dataset.id; const title = WIDGETS[id].title;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (state.grabbed === id) { state.grabbed = null; announce(title + ' abgelegt auf Position ' + (state.layout.findIndex((x) => x.id === id) + 1) + ' von ' + state.layout.length); render(); }
        else { state.undo.push(snapshot()); state.redo = []; state.grabbed = id; announce(title + ' aufgenommen. Pfeiltasten verschieben, Leertaste legt ab, Esc bricht ab.'); render(); }
      } else if (state.grabbed === id && /^Arrow/.test(e.key)) {
        e.preventDefault();
        if (moveWidget(id, e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1)) { announce(title + ', Position ' + (state.layout.findIndex((x) => x.id === id) + 1) + ' von ' + state.layout.length); render(); }
      } else if (state.grabbed === id && e.key === 'Escape') {
        state.layout = JSON.parse(state.undo.pop()); state.grabbed = null; announce('Verschieben abgebrochen'); render();
      }
    }
    if (e.target.matches && e.target.matches('tr[data-action="open-guest"]') && e.key === 'Enter') go('#/p/proxmox-ve/guests/' + e.target.dataset.id);
    if (e.target.matches && e.target.matches('.catalog-list .row[role="checkbox"]') && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); e.target.click(); }
    const pk = document.querySelector('.proto-picker');
    if (pk && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable && !mod && !e.altKey && !document.getElementById('dialog').open && !(w)) {
      const n = pk.querySelectorAll('.proto-picker-item').length; const cur = [...pk.querySelectorAll('.proto-picker-item')].findIndex((x) => x.hasAttribute('data-active'));
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= n) setPick(pk.dataset.kind, num - 1);
      else if (e.key === 'ArrowRight' && !e.target.closest('.chart')) setPick(pk.dataset.kind, (cur + 1) % n);
      else if (e.key === 'ArrowLeft' && !e.target.closest('.chart')) setPick(pk.dataset.kind, (cur - 1 + n) % n);
    }
  });
  /* pointer drag in edit mode (HTML drag and drop) */
  let dragId = null;
  document.addEventListener('dragstart', (e) => { const w = e.target.closest && e.target.closest('.editing .widget'); if (!w) return; dragId = w.dataset.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
  document.addEventListener('dragover', (e) => { if (dragId && e.target.closest('.editing .widget')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    const t = e.target.closest('.editing .widget'); if (!dragId || !t || t.dataset.id === dragId) return;
    e.preventDefault(); const to = state.layout.findIndex((w) => w.id === t.dataset.id);
    commit(() => { const from = state.layout.findIndex((w) => w.id === dragId); const [w] = state.layout.splice(from, 1); state.layout.splice(to, 0, w); }, WIDGETS[dragId].title + ' verschoben'); dragId = null;
  });
  document.addEventListener('dragend', () => { dragId = null; });

  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { drawCharts(); fitWidgets(); initPicker(); }, 120); });
  /* the skip link must not change the hash: the router would read "#main" as a route */
  document.querySelector('.skip-link').addEventListener('click', (e) => { e.preventDefault(); const m = document.getElementById('main'); if (m) m.focus(); });
  window.addEventListener('hashchange', () => { state.navOpen = false; closeMenu(); closeDrawer(); render(); const m = document.getElementById('main'); if (m) m.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  const vq = parseInt(qs.get('v'), 10);
  if (vq) { const r0 = route().parts[0]; if (r0 === 'dashboard') state.card = ['calm', 'dense', 'status'][vq - 1] || 'calm'; if (r0 === 'onboarding') state.catalogView = ['grid', 'list', 'groups'][vq - 1] || 'grid'; }
  render();
})();
