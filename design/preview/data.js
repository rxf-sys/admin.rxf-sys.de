/* Preview datasets: demo (synthetic, modelled on the home lab), worst case (break-ui), empty. */
(function () {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const series = (n, base, amp, drift) => Array.from({ length: n }, (_, i) =>
    Math.max(0, base + Math.sin(i / 3.1) * amp * 0.6 + (rnd() - 0.5) * amp + (drift || 0) * i));
  const GiB = 1024 ** 3;

  const catalog = [
    { id: 'proxmox-ve', name: 'Proxmox VE', mono: 'PVE', category: 'Virtualisierung', desc: 'Knoten, VMs und Container, Speicher und Aufgaben. Start, Neustart und Snapshots.', needs: 'API-Token mit Rolle PVEAuditor' },
    { id: 'proxmox-backup-server', name: 'Proxmox Backup Server', mono: 'PBS', category: 'Backup', desc: 'Belegung mit Prognose, letzte Sicherung je Gast, Verify, Prune und GC.', needs: 'API-Token mit Rolle DatastoreAudit' },
    { id: 'unifi-network', name: 'UniFi Network', mono: 'UN', category: 'Netzwerk', desc: 'Geräte und Firmware, Clients je Access Point, WAN und Durchsatz.', needs: 'Lokaler API-Key der Konsole' },
    { id: 'fritzbox', name: 'FRITZ!Box', mono: 'FB', category: 'Router', desc: 'Internetverbindung, Gast-WLAN, Heimnetzgeräte und DECT Smart Home.', needs: 'Eigener FRITZ!Box-Benutzer, TR-064 aktiv' },
    { id: 'cloudflare', name: 'Cloudflare', mono: 'CF', category: 'DNS/Edge', desc: 'Tunnel und Connectors, DNS, Traffic und Edge-Zertifikate. Cache leeren.', needs: 'API-Token mit Leserechten' },
    { id: 'uptime', name: 'Uptime', mono: 'UP', category: 'Monitoring', desc: 'Eigene Prüfungen per HTTP, TCP, Ping, DNS und TLS mit Verlauf.', needs: 'Nichts, eingebaut' },
    { id: 'docker', name: 'Docker', mono: 'DO', category: 'Container', desc: 'Container, Health, Ressourcen und Log-Auszug. Nur über einen Socket-Proxy.', needs: 'linuxserver/socket-proxy auf dem Host' },
    { id: 'tailscale', name: 'Tailscale', mono: 'TS', category: 'Netzwerk', desc: 'Geräte im Tailnet, zuletzt gesehen, ablaufende Schlüssel und Updates.', needs: 'OAuth-Client mit devices:core:read' },
    { id: 'pihole', name: 'Pi-hole', mono: 'PH', category: 'DNS/Edge', desc: 'Anfragen, Blockquote, Top-Domains. Blockierung zeitweise pausieren.', needs: 'App-Passwort (Pi-hole v6)' },
    { id: 'adguard-home', name: 'AdGuard Home', mono: 'AG', category: 'DNS/Edge', desc: 'Statistik und Abfrageprotokoll. Schutz zeitweise pausieren.', needs: 'Eigener Benutzer in AdGuardHome.yaml' },
    { id: 'home-assistant', name: 'Home Assistant', mono: 'HA', category: 'Smart Home', desc: 'Ausgewählte Entitäten als Widgets, live per WebSocket.', needs: 'Long-Lived Token eines eigenen Benutzers' },
  ];

  const demoGuests = [
    { vmid: 102, name: 'vault', type: 'CT', status: 'running', node: 'rxf-sys', cpu: 0.6, mem: 0.31 * GiB, maxmem: 1 * GiB, uptime: 23 * 86400, tags: ['prod'] },
    { vmid: 104, name: 'apps', type: 'CT', status: 'running', node: 'rxf-sys', cpu: 14.2, mem: 6.8 * GiB, maxmem: 12 * GiB, uptime: 23 * 86400, tags: ['docker', 'prod'], note: 'Portainer, Immich, cloudflared' },
    { vmid: 105, name: 'photos-docs', type: 'CT', status: 'running', node: 'rxf-sys', cpu: 3.1, mem: 2.2 * GiB, maxmem: 4 * GiB, uptime: 9 * 86400, tags: ['prod'] },
    { vmid: 106, name: 'nextcloud', type: 'VM', status: 'running', node: 'rxf-sys', cpu: 5.4, mem: 5.1 * GiB, maxmem: 8 * GiB, uptime: 23 * 86400, tags: ['prod'] },
    { vmid: 107, name: 'jellyfin', type: 'CT', status: 'stopped', node: 'rxf-sys', cpu: 0, mem: 0, maxmem: 4 * GiB, uptime: 0, tags: ['media'] },
    { vmid: 108, name: 'monitor', type: 'CT', status: 'running', node: 'rxf-sys', cpu: 0.9, mem: 0.4 * GiB, maxmem: 1 * GiB, uptime: 23 * 86400, tags: [] },
    { vmid: 110, name: 'rxf-admin', type: 'CT', status: 'running', node: 'rxf-sys', cpu: 1.2, mem: 0.6 * GiB, maxmem: 2 * GiB, uptime: 4 * 86400, tags: ['docker'] },
    { vmid: 111, name: 'rxf-admin-v2', type: 'CT', status: 'running', node: 'rxf-sys', cpu: 0.8, mem: 0.3 * GiB, maxmem: 1 * GiB, uptime: 2 * 3600, tags: ['docker', 'staging'] },
    { vmid: 200, name: 'homeassistant', type: 'VM', status: 'running', node: 'rxf-sys', cpu: 2.7, mem: 2.9 * GiB, maxmem: 4 * GiB, uptime: 23 * 86400, tags: ['iot'] },
    { vmid: 201, name: 'pbs', type: 'VM', status: 'running', node: 'rxf-sys', cpu: 1.9, mem: 3.1 * GiB, maxmem: 6 * GiB, uptime: 23 * 86400, tags: ['backup'] },
  ];

  const demo = {
    label: 'Demodaten',
    instanceName: 'rxf-sys Control',
    user: { name: 'admin', role: 'admin' },
    catalog,
    instances: [
      { id: 'i1', plugin: 'proxmox-ve', name: 'Proxmox VE', target: 'https://192.168.2.200:8006', status: 'active', health: 'ok', actions: 'Start, Herunterfahren, Neustart', tested: 'vor 2 Stunden', secretAge: 'vor 32 Tagen' },
      { id: 'i2', plugin: 'proxmox-backup-server', name: 'Proxmox Backup Server', target: 'https://192.168.2.209:8007', status: 'active', health: 'warn', actions: 'Nur lesen', tested: 'vor 2 Stunden', secretAge: 'vor 32 Tagen' },
      { id: 'i3', plugin: 'cloudflare', name: 'Cloudflare rxf-sys.de', target: 'api.cloudflare.com', status: 'active', health: 'ok', actions: 'Cache leeren', tested: 'vor 1 Tag', secretAge: 'vor 4 Monaten' },
      { id: 'i4', plugin: 'unifi-network', name: 'UniFi UCG Ultra', target: 'https://192.168.2.1', status: 'active', health: 'warn', actions: 'Nur lesen', tested: 'vor 5 Tagen', secretAge: 'vor 2 Monaten' },
      { id: 'i5', plugin: 'uptime', name: 'Uptime', target: '8 Prüfungen', status: 'active', health: 'crit', actions: 'Nur lesen', tested: 'läuft', secretAge: '' },
      { id: 'i6', plugin: 'docker', name: 'Docker auf CT 104 apps', target: 'http://192.168.2.204:2375', status: 'active', health: 'warn', actions: 'Neustart', tested: 'vor 3 Tagen', secretAge: '' },
      { id: 'i7', plugin: 'fritzbox', name: 'FRITZ!Box 5590 Fiber', target: 'https://192.168.178.1:49443', status: 'paused', health: 'paused', actions: 'Nur lesen', tested: 'vor 12 Tagen', secretAge: 'vor 12 Tagen' },
      { id: 'i8', plugin: 'tailscale', name: 'Tailscale', target: 'api.tailscale.com', status: 'active', health: 'warn', actions: 'Nur lesen', tested: 'vor 1 Tag', secretAge: 'vor 20 Tagen' },
      { id: 'i9', plugin: 'home-assistant', name: 'Home Assistant', target: 'https://192.168.2.208:8123', status: 'draft', health: 'unknown', actions: 'Nur lesen', tested: 'noch nicht', secretAge: 'gerade eben' },
    ],
    summary: { ok: 46, warn: 4, crit: 2, unknown: 1, paused: 1 },
    alerts: [
      { sev: 'crit', title: 'media.rxf-sys.de nicht erreichbar', detail: 'Intern und extern keine Antwort, Zeitüberschreitung nach 4 s', plugin: 'uptime', since: 14, action: 'Prüfung öffnen' },
      { sev: 'crit', title: 'Backup überfällig: CT 105 photos-docs', detail: 'Letzte Sicherung vor 3 Tagen, Schwelle 26 Stunden', plugin: 'proxmox-backup-server', since: 2900, action: 'Backups ansehen' },
      { sev: 'warn', title: 'Speicher local-lvm zu 86 % belegt', detail: 'Bei gleichem Wachstum voll in etwa 41 Tagen', plugin: 'proxmox-ve', since: 380, action: 'Speicher ansehen' },
      { sev: 'warn', title: 'Container immich-machine-learning unhealthy', detail: 'Healthcheck schlägt seit 3 Läufen fehl, Docker auf CT 104', plugin: 'docker', since: 46, action: 'Container ansehen' },
      { sev: 'warn', title: 'Access Point Büro offline', detail: 'U6 Lite meldet sich nicht, letzter Kontakt 10:31', plugin: 'unifi-network', since: 22, action: 'Gerät ansehen' },
      { sev: 'warn', title: 'Tailscale-Schlüssel von laptop-buero läuft ab', detail: 'Ablauf am 23.10.2026, danach ist das Gerät getrennt', plugin: 'tailscale', since: 1440, action: 'Gerät ansehen' },
    ],
    pve: {
      node: { name: 'rxf-sys', version: '9.1.9', cpu: 0.18, mem: 41.2 * GiB, maxmem: 64 * GiB, disk: 0.31, uptime: 23 * 86400 + 4 * 3600, load: '1,42 1,38 1,25', cores: 16, model: 'AMD Ryzen 7 7700' },
      guests: demoGuests,
      storage: [
        { id: 'local', type: 'dir', used: 0.34, total: 98 * GiB },
        { id: 'local-lvm', type: 'lvmthin', used: 0.86, total: 1.8 * 1024 * GiB },
        { id: 'pbs-backup', type: 'pbs', used: 0.61, total: 4 * 1024 * GiB },
      ],
      cpu24h: series(48, 16, 9),
      mem24h: series(48, 62, 6, 0.04),
      guestCpu24h: series(48, 12, 10),
      guestMem24h: series(48, 54, 5, 0.03),
      snapshots: [
        { name: 'vor-update-2026-10', when: '12.10.2026, 21:04', note: 'Vor Immich-Update' },
        { name: 'nach-migration', when: '28.09.2026, 18:40', note: '' },
      ],
      tasks: [
        { what: 'vzdump CT 104', result: 'OK', when: 'heute, 02:15', dur: '6 min 12 s' },
        { what: 'vzdump CT 105', result: 'Fehler: Datastore gesperrt', when: 'heute, 02:22', dur: '0 min 41 s' },
        { what: 'Neustart CT 104', result: 'OK', when: 'gestern, 18:02', dur: '0 min 14 s' },
      ],
    },
    pbs: {
      store: 'backups', used: 0.61, total: 4 * 1024 * GiB, fullAt: '14.03.2027',
      overdue: [
        { id: 'ct/105', name: 'photos-docs', last: 'vor 3 Tagen', sev: 'crit' },
        { id: 'vm/106', name: 'nextcloud', last: 'vor 25 Stunden', sev: 'ok' },
        { id: 'ct/104', name: 'apps', last: 'vor 9 Stunden', sev: 'ok' },
        { id: 'vm/200', name: 'homeassistant', last: 'vor 9 Stunden', sev: 'ok' },
      ],
    },
    cf: { tunnel: 'rxf-sys-home', status: 'healthy', connectors: 2, colos: 'fra06, fra10', version: '2026.9.1', requests24h: series(48, 1300, 700), cacheHit: 0.71, threats: 38, cert: '11.01.2027' },
    unifi: {
      wan: { status: 'ok', ip: '203.0.113.42', down: 12.4, up: 2.1, isp: 'Deutsche Glasfaser' },
      clients: 37,
      perAp: [{ name: 'U7 Pro Wohnzimmer', n: 21 }, { name: 'U6 Lite Büro', n: 0, offline: true }, { name: 'U7 Pro Wall Garten', n: 9 }, { name: 'Kabel', n: 7 }],
      devices: [{ name: 'UCG Ultra', s: 'ok', fw: '4.3.6' }, { name: 'USW Lite 8 PoE', s: 'ok', fw: '7.2.3' }, { name: 'U7 Pro Wohnzimmer', s: 'ok', fw: '8.1.2', upd: true }, { name: 'U6 Lite Büro', s: 'warn', fw: '6.7.4' }],
    },
    uptime: [
      { id: 'vault', name: 'vault', s: 'ok', ms: 38 }, { id: 'cloud', name: 'cloud', s: 'ok', ms: 212 },
      { id: 'photos', name: 'photos', s: 'ok', ms: 96 }, { id: 'docs', name: 'docs', s: 'warn', ms: 920 },
      { id: 'media', name: 'media', s: 'crit', ms: null }, { id: 'ha', name: 'ha', s: 'ok', ms: 54 },
      { id: 'monitor', name: 'monitor', s: 'ok', ms: 31 }, { id: 'pbs', name: 'pbs', s: 'ok', ms: 47 },
    ],
    docker: { host: 'CT 104 apps', running: 13, stopped: 1, unhealthy: ['immich-machine-learning'] },
    tailscale: { online: 5, total: 7, expiring: 'laptop-buero, in 5 Tagen', updates: 2 },
    ha: { temp: 21.4, humid: 48, coffee: false, bathTarget: 22 },
    fritz: { paused: true },
    loadingWidget: 'ha',
    staleWidget: 'unifi-clients',
    errorWidget: null,
  };

  /* ---------- Worst case (break-ui catalog) ---------- */
  const longNames = [
    'aleksandra-wisniewska-kowalczyk-entwicklungsumgebung-staging',
    'Benachrichtigungseinstellungen-Testsystem',
    'j',
    'Đặng-Thị-Ngọc-Hân-lab',
    'srv-月面基地-データベース',
    'nextcloud-aio-mastercontainer-with-a-very-long-suffix-v12-final',
    '',
  ];
  const statuses = ['running', 'running', 'running', 'stopped', 'paused', 'unknown'];
  const worstGuests = Array.from({ length: 500 }, (_, i) => {
    const nm = i < longNames.length ? longNames[i] : 'guest-' + String(i).padStart(3, '0') + (i % 9 === 0 ? '-mit-sehr-langem-namen-fuer-tests' : '');
    const st = statuses[i % statuses.length];
    return {
      vmid: i === 3 ? 999999999 : 100 + i, name: nm, type: i % 3 ? 'CT' : 'VM', status: st, node: i % 11 === 0 ? 'rxf-sys-keller-ausweichknoten-02' : 'rxf-sys',
      cpu: st === 'running' ? (i % 17 === 0 ? 100 : rnd() * 60) : 0,
      mem: st === 'running' ? (i % 13 === 0 ? 12.7 * GiB : rnd() * 3 * GiB) : (i % 23 === 0 ? null : 0),
      maxmem: i % 13 === 0 ? 8 * GiB : 4 * GiB, uptime: st === 'running' ? Math.floor(rnd() * 400 * 86400) : null,
      tags: i % 5 === 0 ? ['customer-feedback-from-enterprise-onboarding', 'design', 'frontend', 'q3', 'urgent', 'needs-review', 'backup', 'prod'] : [],
    };
  });
  const worst = Object.assign({}, demo, {
    label: 'Worst case',
    instanceName: 'Rechenzentrum Keller und Gartenhaus, Haupt-Cluster',
    user: { name: 'Aleksandra Wiśniewska-Kowalczyk', role: 'operator' },
    instances: demo.instances.concat([
      { id: 'i10', plugin: 'docker', name: 'Docker auf bartholomew-fitzgerald-northwind-industries-holdings-build-runner-03', target: 'http://[fd00:dead:beef::1234:5678]:2375', status: 'active', health: 'crit', actions: 'Neustart', tested: 'vor 11 Monaten', secretAge: '' },
      { id: 'i11', plugin: 'proxmox-ve', name: 'Proxmox VE Keller', target: 'https://pve-keller.example.test:8006', status: 'active', health: 'crit', actions: 'Nur lesen', tested: 'fehlgeschlagen: Zertifikat hat sich geändert', secretAge: 'vor 3 Jahren' },
    ]),
    summary: { ok: 1284, warn: 87, crit: 23, unknown: 512, paused: 1 },
    alerts: Array.from({ length: 23 }, (_, i) => ({
      sev: i < 9 ? 'crit' : i < 17 ? 'warn' : 'unknown',
      title: i === 0 ? 'Backup überfällig: VM 999999999 aleksandra-wisniewska-kowalczyk-entwicklungsumgebung-staging' : i === 1 ? 'Benachrichtigungseinstellungen konnten nicht gespeichert werden' : 'Container worker-' + i + ' unhealthy',
      detail: i === 0 ? 'Letzte Sicherung vor 1.284 Stunden, Schwelle 26 Stunden. Datastore backups-offsite-gartenhaus meldet: connection reset by peer (os error 104)' : 'Healthcheck schlägt fehl',
      plugin: ['proxmox-backup-server', 'uptime', 'docker'][i % 3], since: i === 0 ? 77040 : i * 37, action: 'Öffnen',
    })),
    pve: Object.assign({}, demo.pve, {
      node: Object.assign({}, demo.pve.node, { name: 'rxf-sys-keller-ausweichknoten-02', cpu: 1, mem: 63.9 * GiB, disk: 0.99, uptime: 1284 * 86400 }),
      guests: worstGuests,
      storage: [
        { id: 'local', type: 'dir', used: 0.999, total: 98 * GiB },
        { id: 'backups-offsite-gartenhaus-nfs-share-mit-langem-namen', type: 'nfs', used: 1.42, total: 12 * 1024 * GiB },
        { id: 'local-lvm', type: 'lvmthin', used: 0, total: 0 },
        { id: 'ceph-pool', type: 'rbd', used: null, total: null },
      ],
    }),
    pbs: Object.assign({}, demo.pbs, { used: 0.97, fullAt: 'morgen', overdue: Array.from({ length: 41 }, (_, i) => ({ id: 'ct/' + (300 + i), name: i === 0 ? 'Đặng-Thị-Ngọc-Hân-lab' : 'guest-' + (300 + i), last: i === 0 ? 'nie' : 'vor ' + (i + 2) + ' Tagen', sev: 'crit' })) }),
    cf: Object.assign({}, demo.cf, { status: 'degraded', connectors: 1, requests24h: series(48, 9000000, 6000000), threats: 12345678, cert: 'abgelaufen' }),
    unifi: {
      wan: { status: 'warn', ip: '2001:db8:85a3:8d3:1319:8a2e:370:7348', down: 940.6, up: 0, isp: 'Regionaler Glasfaseranbieter mit sehr langem Firmennamen GmbH & Co. KG' },
      clients: 1284,
      perAp: [{ name: 'U7 Pro XG Wohnzimmer Erdgeschoss links', n: 1001 }, { name: 'U6 Lite Büro', n: 0, offline: true }, { name: 'j', n: 1 }, { name: 'Kabel', n: 282 }],
      devices: demo.unifi.devices,
    },
    uptime: demo.uptime.concat(Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, name: i === 0 ? 'nextcloud-aio-mastercontainer' : 'svc-' + i, s: ['ok', 'warn', 'crit', 'unknown'][i % 4], ms: i % 4 === 3 ? null : 9000 + i }))),
    docker: { host: 'bartholomew-fitzgerald-northwind-industries-holdings-build-runner-03', running: 1284, stopped: 87, unhealthy: Array.from({ length: 23 }, (_, i) => 'worker-' + i) },
    tailscale: { online: 0, total: 1284, expiring: '87 Geräte in den nächsten 7 Tagen', updates: 512 },
    ha: { temp: null, humid: 100, coffee: true, bathTarget: 30.5 },
    loadingWidget: 'ha', staleWidget: 'unifi-clients', errorWidget: 'cf-traffic',
  });

  const empty = Object.assign({}, demo, {
    label: 'Leer',
    instances: [], summary: { ok: 0, warn: 0, crit: 0, unknown: 0, paused: 0 }, alerts: [],
    pve: Object.assign({}, demo.pve, { guests: [], storage: [], snapshots: [], tasks: [] }),
    pbs: Object.assign({}, demo.pbs, { overdue: [] }),
    uptime: [], docker: { host: '', running: 0, stopped: 0, unhealthy: [] },
    unifi: Object.assign({}, demo.unifi, { clients: 0, perAp: [] }),
    loadingWidget: null, staleWidget: null, errorWidget: null,
  });

  window.PREVIEW_DATA = { demo, worst, empty };
})();
