import { describe, expect, it } from 'vitest';
import { runCli } from './cli.ts';

function run(args: string[]) {
  const lines: string[] = [];
  const code = runCli(args, (line) => lines.push(line));
  return { code, lines };
}

describe('rxf cli', () => {
  it('keygen prints one new 32-byte key', () => {
    const { code, lines } = run(['keygen']);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(Buffer.from(lines[0] ?? '', 'base64')).toHaveLength(32);
  });

  it('prints usage for help and no arguments', () => {
    expect(run([])).toMatchObject({ code: 0, lines: [expect.stringMatching(/^usage: rxf keygen/)] });
    expect(run(['help']).code).toBe(0);
  });

  it('fails on unknown commands and extra arguments', () => {
    expect(run(['rotate']).code).toBe(2);
    expect(run(['keygen', '--force']).code).toBe(2);
  });
});

describe('rxf admin reset-2fa', () => {
  async function storageWithUser() {
    const { testDatabase, testMasterKey } = await import('./test-support.ts');
    const { users, userBackupCodes, userTotp, userWebauthnCredentials, sessions, auditEvents } = await import(
      './db/schema.ts'
    );
    const { beginTotpEnrolment, issueBackupCodes } = await import('./auth/second-factor.ts');
    const { createSession } = await import('./auth/sessions.ts');
    const handle = testDatabase();
    const { id } = handle.db
      .insert(users)
      .values({ username: 'robin', role: 'admin', createdAt: 1 })
      .returning({ id: users.id })
      .get();
    beginTotpEnrolment(handle.db, testMasterKey(), id, 'robin');
    issueBackupCodes(handle.db, id);
    handle.db
      .insert(userWebauthnCredentials)
      .values({
        id: 'credential-id-0000000000',
        userId: id,
        publicKey: Buffer.alloc(1),
        counter: 0,
        deviceType: 'multiDevice',
        backedUp: true,
        name: 'Laptop',
        createdAt: 1,
      })
      .run();
    createSession(handle.db, { userId: id, mfaDone: true, ip: null, userAgent: null }, 1);
    const close = handle.sqlite.close.bind(handle.sqlite);
    let closed = false;
    handle.sqlite.close = () => {
      closed = true;
      return handle.sqlite;
    };
    const counts = () => ({
      totp: handle.db.select().from(userTotp).all().length,
      backup: handle.db.select().from(userBackupCodes).all().length,
      passkeys: handle.db.select().from(userWebauthnCredentials).all().length,
      sessions: handle.db.select().from(sessions).all().length,
      audit: handle.db.select().from(auditEvents).all(),
    });
    return { handle, counts, isClosed: () => closed, close };
  }

  it('removes the second factor, signs the account out and writes an audit entry', async () => {
    const { handle, counts, isClosed, close } = await storageWithUser();
    const lines: string[] = [];
    const code = runCli(
      ['admin', 'reset-2fa', 'robin'],
      (line) => lines.push(line),
      () => handle,
    );
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/second factor of "robin" removed/);
    const after = counts();
    expect(after).toMatchObject({ totp: 0, backup: 0, passkeys: 0, sessions: 0 });
    expect(after.audit[0]).toMatchObject({ event: 'auth.mfa_reset', result: 'success' });
    expect(isClosed()).toBe(true);
    close();
  });

  it('reports an unknown account', async () => {
    const { handle, close } = await storageWithUser();
    const lines: string[] = [];
    expect(
      runCli(
        ['admin', 'reset-2fa', 'nobody'],
        (line) => lines.push(line),
        () => handle,
      ),
    ).toBe(1);
    expect(lines).toEqual(['no account named "nobody"']);
    close();
  });

  it('needs storage and exactly one name', () => {
    expect(run(['admin', 'reset-2fa', 'robin']).code).toBe(2);
    expect(
      runCli(
        ['admin', 'reset-2fa'],
        () => {},
        () => {
          throw new Error('must not open storage');
        },
      ),
    ).toBe(2);
  });
});
