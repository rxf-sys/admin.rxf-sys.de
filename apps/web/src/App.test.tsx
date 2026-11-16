import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';

function renderApp() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

describe('App', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the server as reachable with its version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 'ok', version: '2.0.0' })),
    );
    renderApp();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('rxf-sys Control');
    expect(screen.getByRole('status').textContent).toBe('Verbindung wird geprüft …');
    expect((await screen.findByText('Erreichbar, Version 2.0.0')).dataset.state).toBe('ok');
  });

  it('explains what to check when the server is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad Gateway', { status: 502 })),
    );
    renderApp();
    const status = await screen.findByText('Nicht erreichbar. Läuft der Server-Container?');
    expect(status.dataset.state).toBe('error');
  });

  it('offers a skip link to the main content', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderApp();
    expect(screen.getByRole('link', { name: 'Zum Inhalt springen' }).getAttribute('href')).toBe('#main');
  });
});
