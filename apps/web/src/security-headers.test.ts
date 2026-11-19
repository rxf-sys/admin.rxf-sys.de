// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../security-headers.ts';

const caddyfile = readFileSync(new URL('../../../infrastructure-v2/Caddyfile', import.meta.url), 'utf8');

describe('security headers', () => {
  it('Caddy sends exactly the headers e2e runs under', () => {
    const block = caddyfile.match(/header \{\n([\s\S]*?)\n\t\}/)?.[1] ?? '';
    const caddy = Object.fromEntries(
      [...block.matchAll(/^\t\t([A-Za-z-]+) "(.*)"$/gm)].map(([, name, value]) => [name as string, value as string]),
    );
    expect(caddy).toEqual(securityHeaders);
  });

  it('keeps scripts and styles to our own origin (ADR 0008)', () => {
    const csp = securityHeaders['Content-Security-Policy'] ?? '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });
});
