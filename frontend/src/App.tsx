import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api/client';
import { AuditLog } from './components/AuditLog';
import { BackupsCerts } from './components/BackupsCerts';
import { CommandPalette } from './components/CommandPalette';
import { ConfirmModal } from './components/ConfirmModal';
import { Drawer } from './components/Drawer';
import { GuestDrawer } from './components/GuestDrawer';
import { Header } from './components/Header';
import { NetworkPanel } from './components/NetworkPanel';
import { OverviewCards } from './components/OverviewCards';
import { SectionNav } from './components/SectionNav';
import { ServiceGrid } from './components/ServiceGrid';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { Toasts, type Toast } from './components/Toasts';
import { VMTable } from './components/VMTable';
import { usePoll } from './hooks/usePoll';
import { type Section, useSection } from './hooks/useSection';
import { useResolvedTheme, useUISettings } from './hooks/useTheme';
import type { BackupSnapshot, Guest } from './types';

export function App() {
  const [ui, setUI] = useUISettings();
  const resolvedTheme = useResolvedTheme(ui.theme);
  const [section, setSection] = useSection();
  const [selectedSvc, setSelectedSvc] = useState<string | null>(null);
  const [logsGuest, setLogsGuest] = useState<Guest | null>(null);
  const [confirmGuest, setConfirmGuest] = useState<Guest | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const toastIdRef = useRef(1);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = toastIdRef.current++;
    setToasts((s) => [...s, { id, ...t }]);
    setTimeout(() => setToasts((s) => s.filter((x) => x.id !== id)), 4500);
  }, []);

  // Cmd/Ctrl+K toggles the palette; "?" opens the keyboard cheatsheet;
  // 1-5 jumps to sections (when not in an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.metaKey || e.ctrlKey || inEditable) return;
      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen((o) => !o);
      } else if (/^[1-5]$/.test(e.key)) {
        const map: Section[] = ['overview', 'server', 'network', 'backup', 'cloudflare'];
        setSection(map[Number(e.key) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSection]);

  // Pause swaps polling intervals to 0 (no auto-refresh) while keeping the
  // last known state in memory. Manual refresh still works. The fast interval
  // is the user-configured one; slow polls (backups, certs) scale off it.
  const pollFast = paused ? 0 : ui.refreshIntervalMs;
  const pollSlow = paused || ui.refreshIntervalMs === 0 ? 0 : Math.max(ui.refreshIntervalMs * 4, 30_000);
  const me = usePoll((sig) => api.me(sig), 0);
  const sys = usePoll((sig) => api.system(sig), pollFast);
  const svc = usePoll((sig) => api.services(sig), pollFast);
  const tun = usePoll((sig) => api.tunnel(sig), pollFast);
  const bkp = usePoll((sig) => api.backups(sig), pollSlow);
  const net = usePoll((sig) => api.network(sig), pollFast);
  // Certs change very rarely; clamp to at least 5 min when polling is enabled.
  const cer = usePoll((sig) => api.certs(sig), pollSlow === 0 ? 0 : Math.max(pollSlow * 5, 300_000));

  const lastRefresh = Math.max(
    sys.lastFetched,
    svc.lastFetched,
    tun.lastFetched,
    bkp.lastFetched,
    net.lastFetched,
  );

  const refreshAll = useCallback(() => {
    sys.refresh();
    svc.refresh();
    tun.refresh();
    bkp.refresh();
    net.refresh();
    cer.refresh();
  }, [sys, svc, tun, bkp, net, cer]);

  const services = useMemo(() => svc.data ?? [], [svc.data]);
  const guests = useMemo(() => sys.data?.guests ?? [], [sys.data]);
  const servicesUp = services.filter((s) => s.status === 'ok').length;

  // Per-section alert counts shown as pills on the nav tabs.
  const alerts = useMemo<Record<Section, number>>(() => {
    const svcBad = services.filter((s) => s.status === 'err' || s.status === 'warn').length;
    const hostBad = sys.data?.host && !sys.data.host.online ? 1 : 0;
    const failedJobs = (bkp.data?.jobs ?? []).filter((j) => j.status === 'err').length;
    const pbsDown = bkp.data && bkp.data.reachable === false ? 1 : 0;
    const tunBad =
      tun.data && tun.data.status !== 'healthy' && tun.data.status !== 'unknown' ? 1 : 0;
    const netBad = net.data && net.data.reachable === false ? 1 : 0;
    const dnsBad = (cer.data?.dns ?? []).filter((d) => !d.ok).length;
    const certBad = (cer.data?.certs ?? []).filter((c) => c.days_left < 14).length;
    return {
      overview: 0,
      server: hostBad + svcBad,
      network: netBad,
      backup: pbsDown + failedJobs,
      cloudflare: tunBad + dnsBad + certBad,
    };
  }, [services, sys.data, bkp.data, tun.data, net.data, cer.data]);

  const selectedSvcObj = useMemo(
    () => (selectedSvc ? services.find((s) => s.id === selectedSvc) ?? null : null),
    [selectedSvc, services],
  );

  const onLogs = (g: Guest) => setLogsGuest(g);

  const onRestart = (g: Guest) => setConfirmGuest(g);

  const confirmRestart = async () => {
    if (!confirmGuest) return;
    const guest = confirmGuest;
    setConfirmGuest(null);
    try {
      await api.restartGuest(guest.id, guest.type === 'VM' ? 'qemu' : 'lxc');
      pushToast({
        level: 'warn',
        title: `${guest.name} restarting`,
        body: `Container ${guest.id} wird neu gestartet`,
      });
      setTimeout(refreshAll, 3000);
    } catch (e) {
      pushToast({
        level: 'err',
        title: 'Restart fehlgeschlagen',
        body: (e as Error).message,
      });
    }
  };

  const onVerifyBackup = useCallback(
    async (snap: BackupSnapshot) => {
      const ok = window.confirm(
        `Verifikation für ${snap.target} (${new Date(snap.backup_time * 1000).toLocaleString()}) starten?\n\nDer Job läuft asynchron auf dem PBS und kann bei großen Backups länger dauern.`,
      );
      if (!ok) return;
      try {
        const r = await api.verifyBackup(snap.backup_type, snap.backup_id, snap.backup_time);
        pushToast({
          level: 'ok',
          title: `Verify gestartet · ${snap.target}`,
          body: `UPID: ${r.upid.slice(0, 32)}…`,
        });
        // Pull a fresh backup summary in a moment so verify status flips to pending.
        setTimeout(bkp.refresh, 2000);
      } catch (e) {
        pushToast({
          level: 'err',
          title: 'Verify fehlgeschlagen',
          body: (e as Error).message,
        });
      }
    },
    [pushToast, bkp],
  );

  // Build a JSON snapshot of the current dashboard state and copy it to the
  // clipboard. Useful for filing issues without having to screenshot.
  const onSnapshot = useCallback(async () => {
    const snapshot = {
      capturedAt: new Date().toISOString(),
      identity: me.data,
      system: sys.data,
      services: svc.data,
      tunnel: tun.data,
      backups: bkp.data,
      network: net.data,
      certs: cer.data,
    };
    const text = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ level: 'ok', title: 'Snapshot kopiert', body: `${text.length.toLocaleString()} Zeichen in der Zwischenablage` });
    } catch (e) {
      pushToast({
        level: 'err',
        title: 'Snapshot fehlgeschlagen',
        body: (e as Error).message || 'Zwischenablage nicht verfügbar',
      });
    }
  }, [me.data, sys.data, svc.data, tun.data, bkp.data, net.data, cer.data, pushToast]);

  const anyError = sys.error || svc.error || tun.error;

  // Surface persistent backend failures as a toast (once per error transition).
  const errSig = `${sys.error?.message ?? ''}|${svc.error?.message ?? ''}|${tun.error?.message ?? ''}|${bkp.error?.message ?? ''}|${net.error?.message ?? ''}`;
  const lastErrSig = useRef('');
  useEffect(() => {
    if (errSig === lastErrSig.current) return;
    lastErrSig.current = errSig;
    const errs: { name: string; err: Error | null }[] = [
      { name: 'System', err: sys.error },
      { name: 'Services', err: svc.error },
      { name: 'Tunnel', err: tun.error },
      { name: 'Backups', err: bkp.error },
      { name: 'Netzwerk', err: net.error },
    ];
    for (const { name, err } of errs) {
      if (err) {
        pushToast({ level: 'err', title: `${name}-API Fehler`, body: err.message });
      }
    }
  }, [errSig, sys.error, svc.error, tun.error, bkp.error, net.error, pushToast]);

  const overallLoading = sys.loading || tun.loading || bkp.loading;

  return (
    <div
      className="dashboard"
      data-theme={resolvedTheme}
      data-theme-pref={ui.theme}
      data-accent={ui.accent}
      data-density={ui.density}
      data-section={section}
    >
      <Header
        servicesUp={servicesUp}
        servicesTotal={services.length}
        lastRefresh={lastRefresh}
        onRefresh={refreshAll}
        refreshing={sys.loading || svc.loading}
        theme={ui.theme}
        resolvedTheme={resolvedTheme}
        onCycleTheme={() => {
          const order: ('dark' | 'light' | 'auto')[] = ['dark', 'light', 'auto'];
          const next = order[(order.indexOf(ui.theme) + 1) % order.length];
          setUI('theme', next);
        }}
        email={me.data?.email ?? null}
        accent={ui.accent}
        onAccent={(a) => setUI('accent', a)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        paused={paused}
        onTogglePause={() => setPaused((p) => !p)}
        density={ui.density}
        onToggleDensity={() => setUI('density', ui.density === 'compact' ? 'cozy' : 'compact')}
        onSnapshot={onSnapshot}
        refreshIntervalMs={ui.refreshIntervalMs}
        onChangeRefreshInterval={(ms) => setUI('refreshIntervalMs', ms)}
      />
      <SectionNav active={section} onChange={setSection} alerts={alerts} />
      {anyError && (
        <div className="error-banner">
          <strong>API-Fehler:</strong> {anyError.message}
        </div>
      )}
      {paused && (
        <div className="paused-banner" role="status">
          <span>Auto-Refresh pausiert — Daten werden nicht aktualisiert.</span>
          <button className="btn" type="button" onClick={() => setPaused(false)}>
            Fortsetzen
          </button>
        </div>
      )}
      <main className="dash-main" id={`section-${section}`} role="tabpanel" aria-label={section}>
        {section === 'overview' && (
          <>
            <OverviewCards
              host={sys.data?.host ?? null}
              guests={guests}
              tunnel={tun.data}
              backups={bkp.data}
              loading={overallLoading}
            />
            <ServiceGrid
              services={services}
              onSelect={setSelectedSvc}
              showSpark={ui.showSparklines}
              loading={svc.loading}
            />
            <AuditLog />
          </>
        )}
        {section === 'server' && (
          <>
            <OverviewCards
              host={sys.data?.host ?? null}
              guests={guests}
              tunnel={tun.data}
              backups={bkp.data}
              loading={overallLoading}
              only={['host', 'guests']}
            />
            <VMTable guests={guests} onLogs={onLogs} onRestart={onRestart} />
            <ServiceGrid
              services={services}
              onSelect={setSelectedSvc}
              showSpark={ui.showSparklines}
              loading={svc.loading}
            />
          </>
        )}
        {section === 'network' && (
          <NetworkPanel network={net.data} tunnel={tun.data} />
        )}
        {section === 'backup' && (
          <>
            <OverviewCards
              host={sys.data?.host ?? null}
              guests={guests}
              tunnel={tun.data}
              backups={bkp.data}
              loading={overallLoading}
              only={['backup']}
            />
            <BackupsCerts backups={bkp.data} certs={cer.data} show="backup" onVerify={onVerifyBackup} />
          </>
        )}
        {section === 'cloudflare' && (
          <>
            <OverviewCards
              host={sys.data?.host ?? null}
              guests={guests}
              tunnel={tun.data}
              backups={bkp.data}
              loading={overallLoading}
              only={['tunnel']}
            />
            <BackupsCerts backups={bkp.data} certs={cer.data} show="certs" />
          </>
        )}
      </main>

      <Drawer
        open={!!selectedSvcObj}
        svc={selectedSvcObj}
        guests={guests}
        onClose={() => setSelectedSvc(null)}
      />
      <GuestDrawer
        open={!!logsGuest}
        guest={logsGuest}
        onClose={() => setLogsGuest(null)}
        onRestart={(g) => {
          setLogsGuest(null);
          setConfirmGuest(g);
        }}
      />
      <ConfirmModal
        open={!!confirmGuest}
        guest={confirmGuest}
        onConfirm={confirmRestart}
        onCancel={() => setConfirmGuest(null)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        services={services}
        guests={guests}
        onSelectService={setSelectedSvc}
        onRestartGuest={(g) => setConfirmGuest(g)}
        onRefresh={refreshAll}
        onToggleTheme={() => {
          const order: ('dark' | 'light' | 'auto')[] = ['dark', 'light', 'auto'];
          const next = order[(order.indexOf(ui.theme) + 1) % order.length];
          setUI('theme', next);
        }}
        onJumpSection={setSection}
      />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toasts toasts={toasts} />
    </div>
  );
}
