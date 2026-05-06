/* Mock data + simulation engine for rxf-sys admin */

const SERVICES = [
  { id: 'vault',   name: 'vault',   sub: 'vault.rxf-sys.de',   icon: 'lock',    desc: 'Vaultwarden — Passwörter' },
  { id: 'cloud',   name: 'cloud',   sub: 'cloud.rxf-sys.de',   icon: 'cloud',   desc: 'Nextcloud — Files & Sync' },
  { id: 'photos',  name: 'photos',  sub: 'photos.rxf-sys.de',  icon: 'photo',   desc: 'Immich — Fotos' },
  { id: 'docs',    name: 'docs',    sub: 'docs.rxf-sys.de',    icon: 'doc',     desc: 'Paperless-ngx — Dokumente' },
  { id: 'media',   name: 'media',   sub: 'media.rxf-sys.de',   icon: 'media',   desc: 'Jellyfin — Media' },
  { id: 'ha',      name: 'ha',      sub: 'ha.rxf-sys.de',      icon: 'home',    desc: 'Home Assistant' },
  { id: 'monitor', name: 'monitor', sub: 'monitor.rxf-sys.de', icon: 'monitor', desc: 'Grafana + Prometheus' },
  { id: 'pbs',     name: 'pbs',     sub: 'pbs.rxf-sys.de',     icon: 'archive', desc: 'Proxmox Backup Server' },
];

// initial states — mostly green, two interesting cases
const INITIAL_STATUS = {
  vault:   { status: 'ok',   ms: 42,  ext: true, int: true, uptime: '32d 4h' },
  cloud:   { status: 'ok',   ms: 118, ext: true, int: true, uptime: '32d 4h' },
  photos:  { status: 'ok',   ms: 89,  ext: true, int: true, uptime: '7d 12h' },
  docs:    { status: 'ok',   ms: 64,  ext: true, int: true, uptime: '32d 4h' },
  media:   { status: 'warn', ms: 312, ext: true, int: true, uptime: '2d 6h',  note: 'Slow response' },
  ha:      { status: 'ok',   ms: 28,  ext: false,int: true, uptime: '14d 2h' },
  monitor: { status: 'ok',   ms: 51,  ext: true, int: true, uptime: '32d 4h' },
  pbs:     { status: 'ok',   ms: 73,  ext: true, int: true, uptime: '32d 4h' },
};

const VMS = [
  { id: 100, name: 'pve-host',    type: 'HOST', ip: '10.0.0.1',   service: 'Proxmox VE 8.2',  cpu: 18, ram: 42, uptime: '32d 4h',  status: 'ok' },
  { id: 101, name: 'docker-01',   type: 'LXC',  ip: '10.0.0.10',  service: 'vault, monitor',  cpu: 8,  ram: 23, uptime: '32d 4h',  status: 'ok' },
  { id: 102, name: 'nextcloud',   type: 'LXC',  ip: '10.0.0.11',  service: 'cloud',           cpu: 14, ram: 38, uptime: '32d 4h',  status: 'ok' },
  { id: 103, name: 'immich',      type: 'LXC',  ip: '10.0.0.12',  service: 'photos',          cpu: 22, ram: 51, uptime: '7d 12h',  status: 'ok' },
  { id: 104, name: 'paperless',   type: 'LXC',  ip: '10.0.0.13',  service: 'docs',            cpu: 4,  ram: 18, uptime: '32d 4h',  status: 'ok' },
  { id: 105, name: 'jellyfin',    type: 'LXC',  ip: '10.0.0.14',  service: 'media',           cpu: 67, ram: 72, uptime: '2d 6h',   status: 'warn' },
  { id: 106, name: 'homeassist',  type: 'VM',   ip: '10.0.0.20',  service: 'ha',              cpu: 12, ram: 34, uptime: '14d 2h',  status: 'ok' },
  { id: 107, name: 'cf-tunnel',   type: 'LXC',  ip: '10.0.0.30',  service: 'cloudflared',     cpu: 2,  ram: 9,  uptime: '32d 4h',  status: 'ok' },
  { id: 108, name: 'pbs',         type: 'VM',   ip: '10.0.0.40',  service: 'pbs',             cpu: 6,  ram: 28, uptime: '32d 4h',  status: 'ok' },
];

const PBS_JOBS = [
  { id: 'job-2026-05-05-0300', target: 'nextcloud', status: 'ok',   verify: 'ok',   size: '14.2 GB', when: '02:01' },
  { id: 'job-2026-05-05-0245', target: 'immich',    status: 'ok',   verify: 'ok',   size: '88.7 GB', when: '02:45' },
  { id: 'job-2026-05-05-0230', target: 'paperless', status: 'ok',   verify: 'ok',   size: '2.1 GB',  when: '02:30' },
  { id: 'job-2026-05-05-0215', target: 'docker-01', status: 'ok',   verify: 'ok',   size: '6.8 GB',  when: '02:15' },
  { id: 'job-2026-05-05-0200', target: 'homeassist',status: 'ok',   verify: 'ok',   size: '1.4 GB',  when: '02:00' },
  { id: 'job-2026-05-04-0300', target: 'nextcloud', status: 'ok',   verify: 'ok',   size: '14.1 GB', when: 'gestern' },
  { id: 'job-2026-05-04-0245', target: 'immich',    status: 'ok',   verify: 'pending', size: '88.5 GB', when: 'gestern' },
  { id: 'job-2026-05-04-0230', target: 'paperless', status: 'ok',   verify: 'ok',   size: '2.0 GB',  when: 'gestern' },
  { id: 'job-2026-05-03-0300', target: 'jellyfin',  status: 'err',  verify: '—',    size: '—',       when: 'vor 2 Tagen', note: 'mount failed' },
  { id: 'job-2026-05-03-0245', target: 'cf-tunnel', status: 'ok',   verify: 'ok',   size: '0.3 GB',  when: 'vor 2 Tagen' },
];

const CERTS = [
  { domain: '*.rxf-sys.de',    issuer: 'Cloudflare',     daysLeft: 73 },
  { domain: 'rxf-sys.de',      issuer: 'Cloudflare',     daysLeft: 73 },
  { domain: 'admin.rxf-sys.de',issuer: 'Let\u2019s Encrypt', daysLeft: 21 },
  { domain: 'home.rxf-sys.de', issuer: 'Let\u2019s Encrypt', daysLeft: 8 },
  { domain: 'pbs.rxf-sys.de',  issuer: 'Cloudflare',     daysLeft: 73 },
];

const NETWORKS = [
  { name: 'Default', vlan: 10,  clients: 14, color: 'var(--info)' },
  { name: 'IoT',     vlan: 20,  clients: 23, color: 'var(--warn)' },
  { name: 'Guest',   vlan: 30,  clients: 2,  color: 'var(--text-3)' },
  { name: 'VPN',     vlan: 100, clients: 3,  color: 'var(--accent)' },
];

// Generate a wavy series for sparklines
function genSeries(n, base, variance, seed = 1) {
  const out = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    const x = (Math.sin(i * 0.4 + seed) + Math.cos(i * 0.7 + seed * 1.3)) * 0.5;
    v = base + x * variance + (Math.random() - 0.5) * variance * 0.4;
    out.push(Math.max(1, v));
  }
  return out;
}

const INITIAL_SPARKS = {};
SERVICES.forEach((s, i) => {
  INITIAL_SPARKS[s.id] = genSeries(60, INITIAL_STATUS[s.id].ms, INITIAL_STATUS[s.id].ms * 0.3, i + 1);
});

const INITIAL_NET_UP   = genSeries(60, 12, 8, 7);   // Mbit/s
const INITIAL_NET_DOWN = genSeries(60, 38, 22, 11);

Object.assign(window, { SERVICES, INITIAL_STATUS, VMS, PBS_JOBS, CERTS, NETWORKS, INITIAL_SPARKS, INITIAL_NET_UP, INITIAL_NET_DOWN, genSeries });
