import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api/client';
import { AuditLog } from './components/AuditLog';
import { BackupsCerts } from './components/BackupsCerts';
import { CommandPalette } from './components/CommandPalette';
import { ConfirmModal } from './components/ConfirmModal';
import { Drawer } from './components/Drawer';
import { Header } from './components/Header';
import { NetworkPanel } from './components/NetworkPanel';
import { OverviewCards } from './components/OverviewCards';
import { ServiceGrid } from './components/ServiceGrid';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { Toasts, type Toast } from './components/Toasts';
import { VMTable } from './components/VMTable';
import { usePoll } from './hooks/usePoll';
import { useUISettings } from './hooks/useTheme';
import type { Guest } from './types';

const POLL_FAST = 15_000;
const POLL_SLOW = 60_000;

export function App() {
  const [ui, setUI] = useUISettings();
  const [selectedSvc, setSelectedSvc] = useState<string | null>(null);
  const [confirmGuest, setConfirmGuest] = useState<Guest | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const toastIdRef = useRef(1);

  // Cmd/Ctrl+K toggles the palette; "?" opens the keyboard cheatsheet.
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
      } else if (e.key === '?' && !inEditable && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setHelpOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = toastIdRef.current++;
    setToasts((s) => [...s, { id, ...t }]);
    setTimeout(() => setToasts((s) => s.filter((x) => x.id !== id)), 4500);
  }, []);

  const me = usePoll((sig) => api.me(sig), 0);
  const sys = usePoll((sig) => api.system(sig), POLL_FAST);
  const svc = usePoll((sig) => api.services(sig), POLL_FAST);
  const tun = usePoll((sig) => api.tunnel(sig), POLL_FAST);
  const bkp = usePoll((sig) => api.backups(sig), POLL_SLOW);
  const net = usePoll((sig) => api.network(sig), POLL_FAST);
  const cer = usePoll((sig) => api.certs(sig), POLL_SLOW * 5);

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

  const selectedSvcObj = useMemo(
    () => (selectedSvc ? services.find((s) => s.id === selectedSvc) ?? null : null),
    [selectedSvc, services],
  );

  const onLogs = (g: Guest) =>
    pushToast({ level: 'ok', title: `Logs für ${g.name}`, body: 'Live-Logs sind in v1 noch nicht implementiert.' });

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

  return (
    <div
      className="dashboard"
      data-theme={ui.theme}
      data-accent={ui.accent}
      data-density={ui.density}
    >
      <Header
        servicesUp={servicesUp}
        servicesTotal={services.length}
        lastRefresh={lastRefresh}
        onRefresh={refreshAll}
        refreshing={sys.loading || svc.loading}
        theme={ui.theme}
        onTheme={() => setUI('theme', ui.theme === 'dark' ? 'light' : 'dark')}
        email={me.data?.email ?? null}
        accent={ui.accent}
        onAccent={(a) => setUI('accent', a)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
      />
      {anyError && (
        <div className="error-banner">
          <strong>API-Fehler:</strong> {anyError.message}
        </div>
      )}
      <main className="dash-main">
        <OverviewCards
          host={sys.data?.host ?? null}
          guests={guests}
          tunnel={tun.data}
          backups={bkp.data}
          loading={sys.loading || tun.loading || bkp.loading}
        />
        <ServiceGrid
          services={services}
          onSelect={setSelectedSvc}
          showSpark={ui.showSparklines}
          loading={svc.loading}
        />
        <VMTable guests={guests} onLogs={onLogs} onRestart={onRestart} />
        <NetworkPanel network={net.data} tunnel={tun.data} />
        <BackupsCerts backups={bkp.data} certs={cer.data} />
        <AuditLog />
      </main>

      <Drawer
        open={!!selectedSvcObj}
        svc={selectedSvcObj}
        guests={guests}
        onClose={() => setSelectedSvc(null)}
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
        onToggleTheme={() => setUI('theme', ui.theme === 'dark' ? 'light' : 'dark')}
      />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toasts toasts={toasts} />
    </div>
  );
}
