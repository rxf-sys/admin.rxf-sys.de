import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { createAppRouter } from './router.tsx';

// The WebAuthn ceremony itself is the browser's; the server-side checks are tested in apps/server.
const webauthn = vi.hoisted(() => ({
  supported: false,
  outcome: 'ok' as 'ok' | 'cancel' | 'known',
}));
vi.mock('@simplewebauthn/browser', () => {
  const answer = async () => {
    if (webauthn.outcome === 'cancel') throw Object.assign(new Error('closed'), { name: 'NotAllowedError' });
    if (webauthn.outcome === 'known')
      throw Object.assign(new Error('dup'), { code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' });
    return { id: 'credential-1', response: {} };
  };
  return {
    browserSupportsWebAuthn: () => webauthn.supported,
    startRegistration: answer,
    startAuthentication: answer,
  };
});

type Handler = (body: unknown, init: RequestInit) => Response | Promise<Response>;

const routes = new Map<string, Handler>();
const calls: { key: string; body: unknown; headers: Record<string, string> }[] = [];

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, code: string, details?: Record<string, unknown>) =>
  json({ error: { code, message: code, ...(details ? { details } : {}) } }, status);

const signedIn = (mfa: 'done' | 'pending' | 'setup_required') => ({
  authenticated: true,
  user: { id: 1, username: 'robin', role: 'admin' },
  mfa,
  csrfToken: `csrf-${mfa}`,
  elevatedUntil: null,
});
const anonymous = (setupOpen: boolean) => ({ authenticated: false, setupOpen });

function on(method: string, path: string, handler: Handler | unknown) {
  routes.set(`${method} ${path}`, typeof handler === 'function' ? (handler as Handler) : () => json(handler));
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

beforeAll(() => {
  // jsdom has <dialog> without the modal API.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void };
  proto.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close ??= function close(this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  webauthn.supported = false;
  webauthn.outcome = 'ok';
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      readonly callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
      }
      disconnect() {}
    },
  );
  routes.clear();
  calls.length = 0;
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const key = `${init.method ?? 'GET'} ${input}`;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ key, body, headers: (init.headers ?? {}) as Record<string, string> });
      const handler = routes.get(key);
      if (!handler) return fail(404, 'NOT_FOUND');
      return handler(body, init);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const submit = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('session gate and first start', () => {
  it('walks from setup through enrolment and backup codes to the overview', async () => {
    let session: unknown = anonymous(true);
    on('GET', '/api/auth/session', () => json(session));
    on('POST', '/api/setup', () => {
      session = signedIn('setup_required');
      return json({ ok: true }, 201);
    });
    on('POST', '/api/auth/totp/enrol', { secret: 'JBSWY3DPEHPK3PXPJBSWY3DP', uri: 'otpauth://totp/x' });
    on('POST', '/api/auth/totp/confirm', () => {
      session = signedIn('done');
      return json({ backupCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] });
    });
    on('GET', '/api/instances', { instances: [] });

    const router = renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Ersteinrichtung' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/setup');

    type('Setup-Code', 'ABCDE-FGHIJ');
    type('Benutzername für das Admin-Konto', 'robin');
    type('Passwort', 'correct horse battery staple');
    submit('Admin-Konto anlegen');

    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP')).toBeTruthy();
    expect(calls.find((c) => c.key === 'POST /api/setup')?.body).toEqual({
      code: 'ABCDE-FGHIJ',
      username: 'robin',
      password: 'correct horse battery staple',
    });
    expect(screen.getByRole('link', { name: 'In der Authenticator-App öffnen' }).getAttribute('href')).toBe(
      'otpauth://totp/x',
    );
    // The enrolment request carries the CSRF token of the new session.
    expect(calls.find((c) => c.key === 'POST /api/auth/totp/enrol')?.headers['x-csrf-token']).toBe(
      'csrf-setup_required',
    );

    type('Code aus der App', '123456');
    submit('Einrichten');
    const codes = await screen.findByRole('list', { name: 'Backup-Codes' });
    expect(
      within(codes)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['AAAAA-BBBBB', 'CCCCC-DDDDD']);

    submit('Codes gesichert, weiter');
    expect(await screen.findByRole('heading', { level: 1, name: 'Übersicht' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    expect(FakeEventSource.instances[0]?.url).toBe('/api/stream');
  });

  it('explains a weak password and a wrong setup code', async () => {
    on('GET', '/api/auth/session', anonymous(true));
    let attempt = 0;
    on('POST', '/api/setup', () =>
      ++attempt === 1 ? fail(400, 'WEAK_PASSWORD', { problem: 'too_common' }) : fail(401, 'INVALID_SETUP_CODE'),
    );
    renderAt('/setup');
    await screen.findByRole('heading', { name: 'Ersteinrichtung' });
    submit('Admin-Konto anlegen');
    expect((await screen.findByRole('alert')).textContent).toContain('zu verbreitet');
    submit('Admin-Konto anlegen');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Setup-Code stimmt nicht'));
  });

  it('reports wrong credentials, lockouts and sends signed-in visitors away from the login', async () => {
    let session: unknown = anonymous(false);
    on('GET', '/api/auth/session', () => json(session));
    let attempt = 0;
    on('POST', '/api/auth/login', () => {
      attempt += 1;
      if (attempt === 1) return fail(401, 'INVALID_CREDENTIALS');
      if (attempt === 2) return fail(429, 'TOO_MANY_ATTEMPTS', { retryAfterSeconds: 30 });
      session = signedIn('pending');
      return json({ mfa: 'pending' });
    });
    on('POST', '/api/auth/2fa', () => {
      session = signedIn('done');
      return json({ ok: true });
    });
    on('GET', '/api/instances', { instances: [] });

    const router = renderAt('/settings/security');
    await screen.findByRole('heading', { name: 'Anmelden' });
    expect(router.state.location.pathname).toBe('/login');
    submit('Anmelden');
    expect((await screen.findByRole('alert')).textContent).toBe('Benutzername oder Passwort stimmt nicht.');
    submit('Anmelden');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('30 Sekunden'));
    submit('Anmelden');

    await screen.findByRole('heading', { name: 'Zweiter Faktor' });
    expect(screen.getByLabelText('Code').getAttribute('autocomplete')).toBe('one-time-code');
    fireEvent.click(screen.getByRole('button', { name: 'Backup-Code verwenden' }));
    type('Backup-Code', 'AAAAA-BBBBB');
    submit('Bestätigen');
    await screen.findByRole('heading', { level: 1, name: 'Übersicht' });
    expect(calls.find((c) => c.key === 'POST /api/auth/2fa')?.body).toEqual({ code: 'AAAAA-BBBBB' });
  });

  it('lets a pending second factor be cancelled', async () => {
    let session: unknown = signedIn('pending');
    on('GET', '/api/auth/session', () => json(session));
    on('POST', '/api/auth/logout', () => {
      session = anonymous(false);
      return json({ ok: true });
    });
    renderAt('/');
    await screen.findByRole('heading', { name: 'Zweiter Faktor' });
    submit('Abbrechen und abmelden');
    await screen.findByRole('heading', { name: 'Anmelden' });
  });

  it('says so when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    renderAt('/');
    expect(await screen.findByText(/Der Server ist nicht erreichbar/)).toBeTruthy();
  });
});

describe('signed in', () => {
  beforeEach(() => {
    on('GET', '/api/auth/session', signedIn('done'));
    on('GET', '/api/instances', { instances: [] });
  });

  it('lists sessions and signs out one device or all others', async () => {
    on('GET', '/api/auth/sessions', {
      sessions: [
        {
          id: 'aaaaaaaa',
          createdAt: 0,
          lastSeenAt: 0,
          ip: '10.0.0.2',
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
          current: false,
        },
        { id: 'bbbbbbbb', createdAt: 0, lastSeenAt: 0, ip: null, userAgent: null, current: true },
      ],
    });
    on('DELETE', '/api/auth/sessions/aaaaaaaa', { ok: true });
    on('POST', '/api/auth/sessions/revoke-others', { revoked: 1 });
    renderAt('/settings/security');
    await screen.findByText('Dieses Gerät');
    expect(screen.getByText('Firefox · Linux')).toBeTruthy();
    expect(screen.getByText(/IP unbekannt/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Firefox · Linux abmelden' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'DELETE /api/auth/sessions/aaaaaaaa')).toBe(true));
    submit('Alle anderen abmelden');
    expect((await screen.findByText('Andere Geräte abgemeldet: 1')).getAttribute('role')).toBe('status');
  });

  it('asks for a re-authentication, then retries; cancelling changes nothing', async () => {
    on('GET', '/api/auth/sessions', { sessions: [] });
    let elevated = false;
    on('POST', '/api/auth/backup-codes', () =>
      elevated ? json({ backupCodes: ['NEW00-CODES'] }) : fail(403, 'REAUTH_REQUIRED'),
    );
    let reauths = 0;
    on('POST', '/api/auth/reauth', () => {
      reauths += 1;
      if (reauths === 1) return fail(401, 'INVALID_CREDENTIALS');
      elevated = true;
      return json({ elevatedUntil: 1 });
    });
    renderAt('/settings/security');
    await screen.findByRole('heading', { name: 'Backup-Codes' });

    submit('Neue Backup-Codes erzeugen');
    const dialog = await screen.findByRole('dialog', { name: 'Identität bestätigen' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('list', { name: 'Backup-Codes' })).toBeNull();
    const renew = screen.getByRole('button', { name: 'Neue Backup-Codes erzeugen' }) as HTMLButtonElement;
    await waitFor(() => expect(renew.disabled).toBe(false));

    submit('Neue Backup-Codes erzeugen');
    const again = await screen.findByRole('dialog', { name: 'Identität bestätigen' });
    fireEvent.change(within(again).getByLabelText('Passwort'), { target: { value: 'pw' } });
    fireEvent.change(within(again).getByLabelText('Code aus der App oder Backup-Code'), { target: { value: '1' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Bestätigen' }));
    expect((await within(again).findByRole('alert')).textContent).toBe('Passwort oder Code stimmt nicht.');
    fireEvent.click(within(again).getByRole('button', { name: 'Bestätigen' }));

    const codes = await screen.findByRole('list', { name: 'Backup-Codes' });
    expect(codes.textContent).toBe('NEW00-CODES');
    expect(calls.filter((c) => c.key === 'POST /api/auth/backup-codes')).toHaveLength(3);
  });

  it('turns live events into cache refreshes and follows a revoked session to the login', async () => {
    let session: unknown = signedIn('done');
    on('GET', '/api/auth/session', () => json(session));
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Übersicht' });
    const source = FakeEventSource.instances[0] as FakeEventSource;
    source.emit('entities', { instanceId: 'x', kinds: ['Service'], version: 1 });
    source.emit('metrics', { seriesIds: [1], until: 1 });
    source.emit('instance', { instanceId: 'x', status: 'active', health: 'ok' });
    source.emit('resync', {});
    source.emit('entities', 'not an object');
    source.listeners.get('metrics')?.(new MessageEvent('metrics', { data: '{broken' }));

    session = anonymous(false);
    source.emit('session', { revoked: true });
    await screen.findByRole('heading', { name: 'Anmelden' });
    expect(source.closed).toBe(true);
  });

  it('signs out from the header', async () => {
    let session: unknown = signedIn('done');
    on('GET', '/api/auth/session', () => json(session));
    on('POST', '/api/auth/logout', () => {
      session = anonymous(false);
      return json({ ok: true });
    });
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Übersicht' });
    submit('Abmelden');
    await screen.findByRole('heading', { name: 'Anmelden' });
  });
});

const INSTANCE_ID = '11111111-1111-1111-1111-111111111111';
const instance = (status: 'draft' | 'active' | 'paused', health = 'ok', config: Record<string, unknown> = {}) => ({
  id: INSTANCE_ID,
  pluginId: 'uptime',
  name: 'Dienste',
  status,
  health,
  config,
  secrets: {},
  createdAt: 0,
  updatedAt: 0,
});

describe('dashboard with plugin widgets', () => {
  beforeEach(() => {
    on('GET', '/api/auth/session', signedIn('done'));
  });

  it('offers the first integration to admins on an empty board', async () => {
    on('GET', '/api/instances', { instances: [instance('draft')] });
    renderAt('/');
    expect(
      await screen.findByText('Lege die erste Integration an, zum Beispiel Uptime-Prüfungen für deine Dienste.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Integration hinzufügen' }).getAttribute('href')).toBe('/onboarding');
  });

  it('loads the uptime widget, shows checks with status words and reports the instance as watched', async () => {
    on('GET', '/api/instances', { instances: [instance('active', 'failing')] });
    on('GET', `/api/entities?instanceId=${INSTANCE_ID}&kind=Service`, {
      entities: [
        {
          id: 7,
          instanceId: INSTANCE_ID,
          pluginId: 'uptime',
          kind: 'Service',
          externalId: 'web',
          name: 'Website',
          status: 'ok',
          statusReason: null,
          lastSeen: 1,
          attrs: { endpoint: 'https://rxf-sys.de/', responseMs: 42 },
          updatedAt: 1,
        },
        {
          id: 8,
          instanceId: INSTANCE_ID,
          pluginId: 'uptime',
          kind: 'Service',
          externalId: 'nas',
          name: 'NAS',
          status: 'crit',
          statusReason: 'CONNECTION_REFUSED',
          lastSeen: 1,
          attrs: { endpoint: 'http://10.0.0.5/', responseMs: null },
          updatedAt: 1,
        },
      ],
    });
    on('GET', '/api/metrics/series?entityId=7', {
      series: [{ id: 3, entityId: 7, name: 'uptime.response_ms', unit: 'ms' }],
    });
    on('GET', '/api/metrics/series?entityId=8', { series: [] });
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const inner = fetchMock.getMockImplementation() as (input: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) =>
      input.startsWith('/api/metrics/series/3/points')
        ? json({
            seriesId: 3,
            resolution: 'raw',
            stepMs: 1000,
            points: [
              { ts: 1, avg: 40, min: 40, max: 40 },
              { ts: 2, avg: 60, min: 60, max: 60 },
            ],
          })
        : inner(input, init),
    );
    on('POST', '/api/stream/watch', { ok: true });

    renderAt('/');
    expect(await screen.findByText('Abfragen schlagen fehl')).toBeTruthy();
    expect(await screen.findByText('1 von 2 erreichbar')).toBeTruthy();
    expect(screen.getByText('Gestört')).toBeTruthy();
    expect(screen.getByText('keine Antwort')).toBeTruthy();
    expect(await screen.findByRole('img', { name: 'Antwortzeit der letzten 24 Stunden: 40 bis 60 ms' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Noch keine Antwortzeiten der letzten 24 Stunden' })).toBeTruthy();

    (FakeEventSource.instances[0] as FakeEventSource).emit('hello', { connectionId: 'c'.repeat(22) });
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /api/stream/watch')?.body).toEqual({
        connectionId: 'c'.repeat(22),
        instanceIds: [INSTANCE_ID],
      }),
    );
  });

  it('marks paused instances and keeps viewers away from onboarding', async () => {
    on('GET', '/api/auth/session', { ...signedIn('done'), user: { id: 2, username: 'eve', role: 'viewer' } });
    on('GET', '/api/instances', { instances: [instance('paused')] });
    on('GET', `/api/entities?instanceId=${INSTANCE_ID}&kind=Service`, { entities: [] });
    const router = renderAt('/onboarding');
    expect(await screen.findByText('Pausiert')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByRole('link', { name: 'Integration hinzufügen' })).toBeNull();
    expect(await screen.findByText('Noch keine Messwerte. Die erste Prüfung läuft gleich.')).toBeTruthy();
  });
});

describe('onboarding', () => {
  const certificate = {
    origin: 'https://10.0.0.2:8006',
    leafSha256: 'ab'.repeat(32),
    spkiSha256: 'cd'.repeat(32),
    subject: 'CN=pve',
    issuer: 'CN=pve',
    subjectAltName: 'IP Address:10.0.0.2',
    validTo: 'Jan  1 00:00:00 2030 GMT',
    trusted: false,
  };

  beforeEach(() => {
    on('GET', '/api/auth/session', signedIn('done'));
    on('GET', '/api/plugins/catalog', {
      plugins: [
        {
          id: 'uptime',
          name: { de: 'Uptime', en: 'Uptime' },
          description: { de: 'Eigene Prüfungen per HTTP(S).', en: 'x' },
          category: 'monitoring',
          icon: 'activity',
          version: '0.1.0',
          multiInstance: false,
        },
      ],
    });
  });

  it('creates a draft, trusts a self-signed certificate, and activates after a passing test', async () => {
    let active = false;
    on('GET', '/api/instances', () => json({ instances: active ? [instance('active')] : [] }));
    on('POST', '/api/instances', (body: unknown) =>
      json(instance('draft', 'idle', (body as { config: Record<string, unknown> }).config), 201),
    );
    on(`PATCH`, `/api/instances/${INSTANCE_ID}`, (body: unknown) =>
      json(instance('draft', 'idle', (body as { config: Record<string, unknown> }).config)),
    );
    let tests = 0;
    on('POST', `/api/instances/${INSTANCE_ID}/test`, () => {
      tests += 1;
      return tests === 1
        ? json({
            ok: false,
            capabilities: [{ id: 'check:PVE', status: 'failed', code: 'TLS_SELF_SIGNED', message: 'untrusted' }],
            tls: [certificate],
          })
        : json({ ok: true, capabilities: [{ id: 'check:PVE', status: 'ok', message: 'HTTP 200, 12 ms' }] });
    });
    on('POST', `/api/instances/${INSTANCE_ID}/activate`, () => {
      active = true;
      return json(instance('active'));
    });
    on('GET', `/api/entities?instanceId=${INSTANCE_ID}&kind=Service`, { entities: [] });

    const router = renderAt('/onboarding');
    expect(await screen.findByText('Schritt 1 von 3')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Uptime auswählen' }));

    const save = await screen.findByRole('button', { name: 'Speichern und prüfen' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await screen.findByLabelText('Name');
    type('Name', 'PVE');
    type('URL', 'ftp://wrong');
    expect(await screen.findByText('Die URL muss mit http:// oder https:// beginnen.')).toBeTruthy();
    type('URL', 'https://10.0.0.2:8006/');
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);

    expect(await screen.findByText('Die Konfiguration hat Fehler. Korrigiere sie und prüfe erneut.')).toBeTruthy();
    expect(screen.getByText('Zertifikat von https://10.0.0.2:8006')).toBeTruthy();
    expect(screen.getByText(/^ab:ab:ab/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Aktivieren' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.find((c) => c.key === 'POST /api/instances')?.body).toEqual({
      pluginId: 'uptime',
      name: 'Uptime',
      config: {
        checks: [{ name: 'PVE', url: 'https://10.0.0.2:8006/', method: 'GET' }],
        slowThresholdMs: 800,
        allowBlockedTargets: false,
      },
    });

    submit('Diesem Zertifikat vertrauen');
    expect(
      await screen.findByText('Die Verbindung passt. Nach dem Aktivieren laufen die Abfragen regelmäßig.'),
    ).toBeTruthy();
    const patch = calls.find((c) => c.key === `PATCH /api/instances/${INSTANCE_ID}`)?.body as {
      config: { checks: unknown[] };
    };
    expect(patch.config.checks[0]).toEqual({
      name: 'PVE',
      url: 'https://10.0.0.2:8006/',
      method: 'GET',
      tlsMode: 'pin-leaf',
      pinSha256: 'ab'.repeat(32),
    });

    submit('Aktivieren');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('shows a single-instance plugin as already set up', async () => {
    on('GET', '/api/instances', { instances: [instance('active')] });
    renderAt('/onboarding');
    expect(await screen.findByText('Schon eingerichtet')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Uptime auswählen' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('passkeys', () => {
  beforeEach(() => {
    webauthn.supported = true;
  });

  it('signs in with a passkey from the login screen and reports a cancelled dialog', async () => {
    let session: unknown = anonymous(false);
    on('GET', '/api/auth/session', () => json(session));
    on('POST', '/api/auth/passkeys/login/options', { options: { challenge: 'abc' } });
    on('POST', '/api/auth/passkeys/login', () => {
      session = signedIn('done');
      return json({ mfa: 'done' });
    });
    on('GET', '/api/instances', { instances: [] });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'Anmelden' });

    webauthn.outcome = 'cancel';
    submit('Mit Passkey anmelden');
    expect((await screen.findByRole('alert')).textContent).toBe('Der Passkey-Vorgang wurde abgebrochen.');

    webauthn.outcome = 'ok';
    submit('Mit Passkey anmelden');
    await screen.findByRole('heading', { level: 1, name: 'Übersicht' });
    expect(calls.find((c) => c.key === 'POST /api/auth/passkeys/login')?.body).toEqual({
      response: { id: 'credential-1', response: {} },
    });
  });

  it('completes a pending second factor with a passkey', async () => {
    let session: unknown = signedIn('pending');
    on('GET', '/api/auth/session', () => json(session));
    on('POST', '/api/auth/passkeys/login/options', { options: {} });
    on('POST', '/api/auth/passkeys/login', () => {
      session = signedIn('done');
      return json({ mfa: 'done' });
    });
    on('GET', '/api/instances', { instances: [] });
    renderAt('/');
    await screen.findByRole('heading', { name: 'Zweiter Faktor' });
    submit('Mit Passkey bestätigen');
    await screen.findByRole('heading', { level: 1, name: 'Übersicht' });
  });

  it('sets up a passkey instead of TOTP and shows the backup codes', async () => {
    on('GET', '/api/auth/session', signedIn('setup_required'));
    on('POST', '/api/auth/totp/enrol', { secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' });
    on('POST', '/api/auth/passkeys/register/options', { options: {} });
    on('POST', '/api/auth/passkeys/register', { backupCodes: ['AAAAA-BBBBB'] });
    renderAt('/enrol');
    fireEvent.click(await screen.findByRole('button', { name: 'Stattdessen einen Passkey einrichten' }));
    const codes = await screen.findByRole('list', { name: 'Backup-Codes' });
    expect(codes.textContent).toBe('AAAAA-BBBBB');
    expect(calls.find((c) => c.key === 'POST /api/auth/passkeys/register')?.body).toMatchObject({
      name: expect.any(String),
    });
  });

  it('lists, adds behind a re-authentication by passkey, and refuses to remove the last factor', async () => {
    on('GET', '/api/auth/session', signedIn('done'));
    on('GET', '/api/auth/sessions', { sessions: [] });
    let passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null; synced: boolean }[] = [
      { id: 'credential-1', name: 'Laptop', createdAt: 0, lastUsedAt: null, synced: true },
    ];
    on('GET', '/api/auth/passkeys', () => json({ passkeys }));
    let elevated = false;
    on('POST', '/api/auth/passkeys/register/options', () =>
      elevated ? json({ options: {} }) : fail(403, 'REAUTH_REQUIRED'),
    );
    on('POST', '/api/auth/passkeys/register', () => {
      passkeys = [...passkeys, { id: 'credential-2', name: 'Telefon', createdAt: 0, lastUsedAt: 5, synced: false }];
      return json({});
    });
    on('POST', '/api/auth/reauth/passkey/options', { options: {} });
    on('POST', '/api/auth/reauth/passkey', () => {
      elevated = true;
      return json({ elevatedUntil: 1 });
    });
    on('DELETE', '/api/auth/passkeys/credential-1', () => fail(409, 'LAST_FACTOR'));
    renderAt('/settings/security');

    expect(await screen.findByText('Laptop')).toBeTruthy();
    expect(screen.getByText('synchronisiert')).toBeTruthy();
    expect(screen.getByText('noch nicht benutzt')).toBeTruthy();

    type('Name des neuen Passkeys', 'Telefon');
    submit('Passkey hinzufügen');
    const dialog = await screen.findByRole('dialog', { name: 'Identität bestätigen' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mit Passkey bestätigen' }));
    expect(await screen.findByText('Telefon')).toBeTruthy();
    expect(calls.find((c) => c.key === 'POST /api/auth/passkeys/register')?.body).toMatchObject({ name: 'Telefon' });

    fireEvent.click(screen.getByRole('button', { name: 'Laptop entfernen' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Das ist dein letzter zweiter Faktor. Richte zuerst einen weiteren ein.',
    );
  });

  it('explains an authenticator that is already registered', async () => {
    on('GET', '/api/auth/session', signedIn('setup_required'));
    on('POST', '/api/auth/totp/enrol', { secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' });
    on('POST', '/api/auth/passkeys/register/options', { options: {} });
    webauthn.outcome = 'known';
    renderAt('/enrol');
    fireEvent.click(await screen.findByRole('button', { name: 'Stattdessen einen Passkey einrichten' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Dieser Passkey ist schon eingerichtet.');
  });
});
