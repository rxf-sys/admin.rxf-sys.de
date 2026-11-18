import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { createAppRouter } from './router.tsx';

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
    on('GET', '/api/healthz', { status: 'ok', version: '2.0.0' });

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
    on('GET', '/api/healthz', { status: 'ok', version: '2.0.0' });

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
    on('GET', '/api/healthz', { status: 'ok', version: '2.0.0' });
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
