import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiErrorMessage } from './api/client';
import { AdminPanel } from './components/AdminPanel';
import { AttentionHero } from './components/AttentionHero';
import { AuditLog } from './components/AuditLog';
import { AuditPanel } from './components/AuditPanel';
import { BackupsSection } from './components/BackupsSection';
import { CloudflareSection } from './components/CloudflareSection';
import { CommandPalette } from './components/CommandPalette';
import { ConfirmModal } from './components/ConfirmModal';
import { Drawer } from './components/Drawer';
import { GuestDrawer } from './components/GuestDrawer';
import { Header } from './components/Header';
import { HostGrid } from './components/HostGrid';
import { HostPanel } from './components/HostPanel';
import { KpiStrip } from './components/KpiStrip';
import { LoginPage } from './components/LoginPage';
import { NetworkPanel } from './components/NetworkPanel';
import { SectionNav } from './components/SectionNav';
import { ServiceFormModal } from './components/ServiceFormModal';
import { ServiceGrid } from './components/ServiceGrid';
import { SettingsPage } from './components/SettingsPage';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { Toasts, type Toast } from './components/Toasts';
import { VMTable } from './components/VMTable';
import { useAuth } from './hooks/useAuth';
import { usePoll } from './hooks/usePoll';
import { type Section, useSection } from './hooks/useSection';
import { useResolvedTheme, useUISettings } from './hooks/useTheme';
import type { Account, BackupSnapshot, Guest, InstanceInfo, ServiceInput, ServiceStatus } from './types';

const SECTION_KEYS: Section[] = ['overview', 'server', 'network', 'backup', 'cloudflare', 'settings'];

// Human-readable section names for the tabpanel's aria-label.
const SECTION_LABELS: Record<Section, string> = {
  overview: 'Übersicht',
  server: 'Server',
  network: 'Netzwerk',
  backup: 'Backup',
  cloudflare: 'Cloudflare',
  audit: 'Audit',
  admin: 'Konten',
  settings: 'Einstellungen',
};

export function App() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return <div className="spinner-page">Lade…</div>;
  }
  if (auth.status === 'anon' || !auth.user) {
    return <LoginPage onLogin={auth.login} />;
  }
  // Remount the dashboard per account so all per-user state (settings,
  // polls, drawers) starts clean after a logout/login.
  return <Dashboard key={auth.user.id} user={auth.user} onLogout={auth.logout} />;
}

interface DashboardProps {
  user: Account;
  onLogout: () => Promise<void>;
}

function Dashboard({ user, onLogout }: DashboardProps) {
  const [ui, setUI, mergeUI] = useUISettings();
  const resolvedTheme = useResolvedTheme(ui.theme);
  const [section, setSection] = useSection();
  const [selectedSvc, setSelectedSvc] = useState<string | null>(null);
  const [logsGuest, setLogsGuest] = useState<Guest | null>(null);
  const [confirmGuest, setConfirmGuest] = useState<Guest | null>(null);
  const [verifyTarget, setVerifyTarget] = useState<BackupSnapshot | null>(null);
  const [serviceModal, setServiceModal] = useState<{
    mode: 'create' | 'edit';
    editId?: string;
    initial?: Partial<ServiceInput>;
  } | null>(null);
  const [deleteSvc, setDeleteSvc] = useState<ServiceStatus | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const toastIdRef = useRef(1);
  const isAdmin = user.role === 'admin';

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = toastIdRef.current++;
    setToasts((s) => [...s, { id, ...t }]);
    setTimeout(() => setToasts((s) => s.filter((x) => x.id !== id)), 4500);
  }, []);

  // --- Per-user settings sync ---
  // Hydrate from the server once after mount, then push debounced on change.
  const settingsHydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    api
      .getAccountSettings()
      .then((r) => {
        if (cancelled) return;
        if (r.settings && Object.keys(r.settings).length > 0) mergeUI(r.settings);
      })
      .catch(() => {
        /* fall back to localStorage */
      })
      .finally(() => {
        if (!cancelled) settingsHydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [mergeUI]);

  useEffect(() => {
    if (!settingsHydrated.current) return;
    const t = setTimeout(() => {
      api.putAccountSettings(ui as unknown as Record<string, unknown>).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [ui]);

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
      } else if (/^[1-6]$/.test(e.key)) {
        setSection(SECTION_KEYS[Number(e.key) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSection]);

  const pollFast = paused ? 0 : ui.refreshIntervalMs;
  const pollBackup = paused ? 0 : ui.pollBackupMs;
  const pollCerts = paused ? 0 : ui.pollCertsMs;
  const sys = usePoll((sig) => api.system(sig), pollFast);
  const svc = usePoll((sig) => api.services(sig), pollFast);
  const tun = usePoll((sig) => api.tunnel(sig), pollFast);
  const bkp = usePoll((sig) => api.backups(sig), pollBackup);
  const net = usePoll((sig) => api.network(sig), pollFast);
  const cer = usePoll((sig) => api.certs(sig), pollCerts);

  // Instance branding — loaded once after login and refreshed when the user
  // saves it in the settings page.
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const loadInstance = useCallback(async () => {
    try {
      setInstance(await api.getInstance());
    } catch {
      /* silent — settings stay at compile-time defaults */
    }
  }, []);
  useEffect(() => { void loadInstance(); }, [loadInstance]);
  useEffect(() => {
    if (instance?.instance_name) document.title = `${instance.instance_name} · admin`;
  }, [instance?.instance_name]);

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
  const servicesCritical = services.filter((s) => s.status === 'err').length;

  const alerts = useMemo<Record<Section, number>>(() => {
    const svcBad = services.filter((s) => s.status === 'err' || s.status === 'warn').length;
    const hostBad = sys.data?.host && !sys.data.host.online ? 1 : 0;
    const failedJobs = (bkp.data?.jobs ?? []).filter((j) => j.status === 'err').length;
    const pbsDown = bkp.data && bkp.data.reachable === false ? 1 : 0;
    const tunBad =
      tun.data && tun.data.status !== 'healthy' && tun.data.status !== 'unknown' ? 1 : 0;
    const netBad = net.data && net.data.reachable === false ? 1 : 0;
    const dnsBad = (cer.data?.dns ?? []).filter((d) => !d.ok).length;
    const warnDays = ui.certWarnDays || 0;
    const certBad =
      warnDays > 0
        ? (cer.data?.certs ?? []).filter((c) => c.days_left < warnDays).length
        : 0;
    return {
      overview: 0,
      server: hostBad + svcBad,
      network: netBad,
      backup: pbsDown + failedJobs,
      cloudflare: tunBad + dnsBad + certBad,
      audit: 0,
      admin: 0,
      settings: 0,
    };
  }, [services, sys.data, bkp.data, tun.data, net.data, cer.data, ui.certWarnDays]);

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
      pushToast({ level: 'warn', title: `${guest.name} restarting`, body: `Container ${guest.id} wird neu gestartet` });
      setTimeout(refreshAll, 3000);
    } catch (e) {
      pushToast({ level: 'err', title: 'Restart fehlgeschlagen', body: (e as Error).message });
    }
  };

  // Backup verification routes through the ConfirmModal (no native window.confirm).
  const confirmVerify = useCallback(async () => {
    const snap = verifyTarget;
    if (!snap) return;
    setVerifyTarget(null);
    try {
      const r = await api.verifyBackup(snap.backup_type, snap.backup_id, snap.backup_time);
      pushToast({ level: 'ok', title: `Verify gestartet · ${snap.target}`, body: `UPID: ${r.upid.slice(0, 32)}…` });
      setTimeout(bkp.refresh, 2000);
    } catch (e) {
      pushToast({ level: 'err', title: 'Verify fehlgeschlagen', body: (e as Error).message });
    }
  }, [verifyTarget, pushToast, bkp]);

  // --- Custom services (admin) ---
  const openAddService = useCallback(() => setServiceModal({ mode: 'create' }), []);

  const openQuickAddService = useCallback((g: Guest) => {
    setServiceModal({
      mode: 'create',
      initial: {
        name: g.service || g.name,
        desc: `${g.type} ${g.id}`,
        icon: 'server',
        internal_url: g.ip ? `http://${g.ip}` : 'http://',
        ext_url: '',
      },
    });
  }, []);

  const openEditService = useCallback((svcToEdit: ServiceStatus) => {
    setSelectedSvc(null);
    setServiceModal({
      mode: 'edit',
      editId: svcToEdit.id,
      initial: {
        name: svcToEdit.name,
        desc: svcToEdit.desc,
        icon: svcToEdit.icon,
        internal_url: svcToEdit.internal_url,
        ext_url: svcToEdit.ext_url ?? '',
      },
    });
  }, []);

  const onServiceSaved = useCallback(() => {
    setServiceModal(null);
    svc.refresh();
    pushToast({ level: 'ok', title: 'Service gespeichert', body: 'Die Service-Liste wurde aktualisiert.' });
  }, [svc, pushToast]);

  const confirmDeleteService = useCallback(async () => {
    const target = deleteSvc;
    if (!target) return;
    setDeleteSvc(null);
    try {
      await api.deleteService(target.id);
      pushToast({ level: 'ok', title: 'Service gelöscht', body: target.name });
      svc.refresh();
    } catch (e) {
      pushToast({ level: 'err', title: 'Löschen fehlgeschlagen', body: apiErrorMessage(e) });
    }
  }, [deleteSvc, svc, pushToast]);

  const onRenameGuestService = useCallback(
    async (vmid: number, name: string) => {
      try {
        await api.updateGuestService(vmid, name || null);
        sys.refresh();
      } catch (e) {
        pushToast({ level: 'err', title: 'Service-Name fehlgeschlagen', body: apiErrorMessage(e) });
      }
    },
    [sys, pushToast],
  );

  const onSnapshot = useCallback(async () => {
    const snapshot = {
      capturedAt: new Date().toISOString(),
      identity: user,
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
      pushToast({ level: 'ok', title: 'Snapshot kopiert', body: `${text.length.toLocaleString()} Zeichen` });
    } catch (e) {
      pushToast({ level: 'err', title: 'Snapshot fehlgeschlagen', body: (e as Error).message || 'Zwischenablage nicht verfügbar' });
    }
  }, [user, sys.data, svc.data, tun.data, bkp.data, net.data, cer.data, pushToast]);

  const anyError = sys.error || svc.error || tun.error;
  const errSig = `${sys.error?.message ?? ''}|${svc.error?.message ?? ''}|${tun.error?.message ?? ''}|${bkp.error?.message ?? ''}|${net.error?.message ?? ''}`;
  const lastErrSig = useRef('');
  useEffect(() => {
    if (errSig === lastErrSig.current) return;
    lastErrSig.current = errSig;
    const failed = [
      { name: 'System', err: sys.error },
      { name: 'Services', err: svc.error },
      { name: 'Tunnel', err: tun.error },
      { name: 'Backups', err: bkp.error },
      { name: 'Netzwerk', err: net.error },
    ].filter((e) => e.err);
    if (failed.length === 0) return;
    // Bundle simultaneous failures into a single toast instead of flooding
    // the user with one per endpoint.
    if (failed.length === 1) {
      pushToast({
        level: 'err',
        title: `${failed[0].name}-API Fehler`,
        body: failed[0].err!.message,
      });
    } else {
      pushToast({
        level: 'err',
        title: `${failed.length} API-Endpunkte nicht erreichbar`,
        body: failed.map((e) => e.name).join(', '),
      });
    }
  }, [errSig, sys.error, svc.error, tun.error, bkp.error, net.error, pushToast]);

  const onInspectGuest = (vmid: number) => {
    const g = guests.find((x) => x.id === vmid);
    if (g) setLogsGuest(g);
  };

  const onToggleTheme = useCallback(() => {
    const order: ('dark' | 'light' | 'auto')[] = ['dark', 'light', 'auto'];
    const next = order[(order.indexOf(ui.theme) + 1) % order.length];
    setUI('theme', next);
  }, [ui.theme, setUI]);

  const doLogout = useCallback(async () => {
    await onLogout();
  }, [onLogout]);

  return (
    <div
      className="dashboard"
      data-theme={resolvedTheme}
      data-theme-pref={ui.theme}
      data-density={ui.density}
      data-reduce-motion={ui.reduceMotion ? '1' : undefined}
      data-section={section}
    >
      <Header
        servicesUp={servicesUp}
        servicesTotal={services.length}
        servicesCritical={servicesCritical}
        onRefresh={refreshAll}
        refreshing={sys.loading || svc.loading}
        email={user.email ?? user.username}
        onOpenPalette={() => setPaletteOpen(true)}
        paused={paused}
        onTogglePause={() => setPaused((p) => !p)}
        onSnapshot={onSnapshot}
        onOpenSettings={() => setSection('settings')}
        onToggleTheme={onToggleTheme}
        isDarkTheme={resolvedTheme === 'dark'}
        instanceName={instance?.instance_name}
      />
      <div className="dash-body">
      <SectionNav active={section} onChange={setSection} alerts={alerts} isAdmin={isAdmin} />
      <div className="dash-content">
      {anyError && (
        <div className="error-banner">
          <strong>API-Fehler:</strong> {anyError.message}
        </div>
      )}
      {paused && (
        <div className="paused-banner" role="status">
          <span>Auto-Refresh pausiert — Daten werden nicht aktualisiert.</span>
          <button className="btn" type="button" onClick={() => setPaused(false)}>Fortsetzen</button>
        </div>
      )}
      <main className="dash-main" id={`section-${section}`} role="tabpanel" aria-label={SECTION_LABELS[section]}>
        <div className="section-title-block">
          <h1>{SECTION_LABELS[section]}</h1>
          <div className="section-crumb mono">
            <span>{instance?.instance_name ? `${instance.instance_name}` : 'admin.rxf-sys.de'}</span>
            <span className="crumb-sep">/</span>
            <span>{SECTION_LABELS[section]}</span>
          </div>
        </div>
        {section === 'overview' && (
          <>
            <AttentionHero
              guests={guests}
              services={services}
              certs={cer.data?.certs ?? []}
              backups={bkp.data}
              tunnel={tun.data}
              certWarnDays={ui.certWarnDays}
              onInspectService={setSelectedSvc}
              onInspectGuest={onInspectGuest}
            />
            <HostPanel host={sys.data?.host ?? null} guests={guests} />
            <div className="quick-stats">
              <KpiStrip guests={guests} services={services} />
              <AuditLog pollMs={pollFast} />
            </div>
            <ServiceGrid
              services={services}
              onSelect={setSelectedSvc}
              showSpark={ui.showSparklines}
              loading={svc.loading}
              isAdmin={isAdmin}
              onAddService={openAddService}
              onDeleteService={setDeleteSvc}
            />
          </>
        )}
        {section === 'server' && (
          <section className="server-section" aria-labelledby="server-heading">
            <div className="dash-section-head">
              <h2 id="server-heading">Live-Status</h2>
              <span className="dimmer mono" style={{ fontSize: 11 }}>
                {sys.data?.host?.node ? `${sys.data.host.node} · Echtzeit` : 'Echtzeit'}
              </span>
            </div>
            <KpiStrip guests={guests} services={services} />
            <div className="dash-section-head" style={{ marginTop: 16 }}>
              <h2>Host &amp; Compute</h2>
            </div>
            <HostGrid host={sys.data?.host ?? null} guests={guests} />
            <div className="dash-section-head">
              <h2>Container &amp; VMs</h2>
              <span className="dimmer mono" style={{ fontSize: 11 }}>
                {guests.filter((g) => g.running).length} / {guests.length}
              </span>
            </div>
            <VMTable
              guests={guests}
              onLogs={onLogs}
              onRestart={onRestart}
              isAdmin={isAdmin}
              onRenameService={onRenameGuestService}
              onQuickAddService={openQuickAddService}
            />
            <ServiceGrid
              services={services}
              onSelect={setSelectedSvc}
              showSpark={ui.showSparklines}
              loading={svc.loading}
              isAdmin={isAdmin}
              onAddService={openAddService}
              onDeleteService={setDeleteSvc}
            />
          </section>
        )}
        {section === 'network' && (
          <NetworkPanel network={net.data} tunnel={tun.data} pollMs={pollFast} />
        )}
        {section === 'backup' && (
          <BackupsSection
            backups={bkp.data}
            guests={guests}
            onVerify={setVerifyTarget}
            onOpenGuest={onLogs}
          />
        )}
        {section === 'cloudflare' && (
          <CloudflareSection
            tunnel={tun.data}
            certs={cer.data}
            services={services}
            zoneName="rxf-sys.de"
            onSelectService={setSelectedSvc}
            pollMs={pollCerts}
          />
        )}
        {section === 'audit' && isAdmin && (
          <AuditPanel
            onError={(msg) => pushToast({ level: 'err', title: 'Audit-Fehler', body: msg })}
            onInfo={(msg) => pushToast({ level: 'ok', title: 'Audit', body: msg })}
          />
        )}
        {section === 'admin' && isAdmin && (
          <AdminPanel
            currentUserId={user.id}
            onError={(msg) => pushToast({ level: 'err', title: 'Konten-Fehler', body: msg })}
            onInfo={(msg) => pushToast({ level: 'ok', title: 'Konten', body: msg })}
          />
        )}
        {section === 'settings' && (
          <SettingsPage
            settings={ui}
            update={setUI}
            account={user}
            onLogout={doLogout}
            onPasswordChanged={() => pushToast({ level: 'ok', title: 'Passwort geändert', body: 'Dein Passwort wurde aktualisiert.' })}
            onError={(msg) => pushToast({ level: 'err', title: 'Fehler', body: msg })}
            onInfo={(msg) => pushToast({ level: 'ok', title: msg, body: '' })}
            system={sys.data}
            tunnel={tun.data}
            backups={bkp.data}
            network={net.data}
            instance={instance}
            onInstanceSaved={(next) => {
              setInstance(next);
              pushToast({ level: 'ok', title: 'Gespeichert', body: 'Instanz-Einstellungen aktualisiert.' });
            }}
          />
        )}
      </main>
      </div>
      </div>

      <Drawer
        open={!!selectedSvcObj}
        svc={selectedSvcObj}
        guests={guests}
        onClose={() => setSelectedSvc(null)}
        isAdmin={isAdmin}
        onEdit={openEditService}
        onDelete={(s) => {
          setSelectedSvc(null);
          setDeleteSvc(s);
        }}
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
        title="Container neu starten?"
        message={
          confirmGuest && (
            <>
              <p style={{ margin: '0 0 8px' }}>
                <strong>{confirmGuest.name}</strong> ({confirmGuest.type} {confirmGuest.id}) wird neu gestartet.
              </p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-3)' }}>
                Die zugehörigen Services sind dabei ca. 30–60 Sekunden nicht erreichbar.
              </p>
            </>
          )
        }
        confirmLabel="Restart"
        danger
        onConfirm={confirmRestart}
        onCancel={() => setConfirmGuest(null)}
      />
      <ConfirmModal
        open={!!verifyTarget}
        title="Backup verifizieren?"
        message={
          verifyTarget && (
            <p style={{ margin: 0 }}>
              Verifikation für <strong>{verifyTarget.target}</strong> (
              {new Date(verifyTarget.backup_time * 1000).toLocaleString()}) starten? Der Job läuft
              asynchron auf dem PBS.
            </p>
          )
        }
        confirmLabel="Verify starten"
        onConfirm={confirmVerify}
        onCancel={() => setVerifyTarget(null)}
      />
      {serviceModal && (
        <ServiceFormModal
          key={serviceModal.editId ?? serviceModal.mode}
          mode={serviceModal.mode}
          editId={serviceModal.editId}
          initial={serviceModal.initial}
          onClose={() => setServiceModal(null)}
          onSaved={onServiceSaved}
          onError={(msg) => pushToast({ level: 'err', title: 'Service-Fehler', body: msg })}
        />
      )}
      <ConfirmModal
        open={!!deleteSvc}
        title="Service löschen?"
        message={
          deleteSvc && (
            <p style={{ margin: 0 }}>
              Service <strong>{deleteSvc.name}</strong> aus dem Monitoring entfernen? Die
              Probe-Historie bleibt erhalten.
            </p>
          )
        }
        confirmLabel="Löschen"
        danger
        onConfirm={confirmDeleteService}
        onCancel={() => setDeleteSvc(null)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        services={services}
        guests={guests}
        onSelectService={setSelectedSvc}
        onRestartGuest={(g) => setConfirmGuest(g)}
        onRefresh={refreshAll}
        onToggleTheme={onToggleTheme}
        onJumpSection={setSection}
      />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toasts toasts={toasts} />
    </div>
  );
}
