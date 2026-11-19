import { backupCodesResponse, loginResponse, totpEnrolmentResponse } from '@rxf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { okResponse, sendJson } from '../api.ts';
import { describeAgent } from '../app/agent.ts';
import { t } from '../i18n.ts';
import { passkeysSupported, registerPasskey, signInWithPasskey } from '../passkeys.ts';
import { sessionKey } from '../session.ts';
import { BackupCodes } from '../ui/BackupCodes.tsx';
import { errorText } from '../ui/errors.ts';
import { Field, FormError, formValues, PasswordField } from '../ui/Field.tsx';
import styles from '../ui/ui.module.css';
import { AuthLayout } from './AuthLayout.tsx';

/** After every step the session decides where the visitor goes next (see `stageOf`). */
function useRefreshSession() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: sessionKey });
}

function submitWith(run: (values: Record<string, string>) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(formValues(event.currentTarget));
  };
}

export function SetupPage() {
  const refresh = useRefreshSession();
  const setup = useMutation({
    mutationFn: (values: Record<string, string>) => sendJson('POST', '/api/setup', okResponse, values),
    onSuccess: refresh,
  });
  return (
    <AuthLayout title={t('setup.title')} intro={t('setup.intro')}>
      <form className={styles.form} onSubmit={submitWith((v) => setup.mutate(v))} noValidate>
        <FormError message={setup.isError ? errorText(setup.error) : null} />
        <Field
          label={t('setup.code')}
          hint={t('setup.codeHint')}
          name="code"
          variant="mono"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <Field
          label={t('setup.username')}
          hint={t('setup.usernameHint')}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          required
        />
        <PasswordField
          label={t('setup.password')}
          hint={t('setup.passwordHint')}
          name="password"
          autoComplete="new-password"
          required
        />
        <button className={`${styles.btn} ${styles.primary} ${styles.block}`} type="submit" disabled={setup.isPending}>
          {t('setup.submit')}
        </button>
      </form>
    </AuthLayout>
  );
}

export function LoginPage() {
  const refresh = useRefreshSession();
  const login = useMutation({
    mutationFn: (values: Record<string, string>) => sendJson('POST', '/api/auth/login', loginResponse, values),
    onSuccess: refresh,
  });
  return (
    <AuthLayout title={t('login.title')}>
      <form className={styles.form} onSubmit={submitWith((v) => login.mutate(v))} noValidate>
        <FormError message={login.isError ? errorText(login.error) : null} />
        <Field
          label={t('login.username')}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          aria-invalid={login.isError || undefined}
          required
        />
        <PasswordField
          label={t('login.password')}
          name="password"
          autoComplete="current-password"
          aria-invalid={login.isError || undefined}
          required
        />
        <button className={`${styles.btn} ${styles.primary} ${styles.block}`} type="submit" disabled={login.isPending}>
          {t('login.submit')}
        </button>
      </form>
      <PasskeySignIn label={t('login.passkey')} />
    </AuthLayout>
  );
}

/** Passwordless sign-in, or the second factor after the password; hidden where WebAuthn is missing. */
function PasskeySignIn({ label }: { label: string }) {
  const refresh = useRefreshSession();
  const passkey = useMutation({ mutationFn: signInWithPasskey, onSuccess: refresh });
  if (!passkeysSupported()) return null;
  return (
    <div className={styles.form}>
      <p className={styles.divider}>{t('login.or')}</p>
      <FormError message={passkey.isError ? errorText(passkey.error) : null} />
      <button
        type="button"
        className={`${styles.btn} ${styles.outline} ${styles.block}`}
        disabled={passkey.isPending}
        onClick={() => passkey.mutate()}
      >
        {label}
      </button>
    </div>
  );
}

export function useLogout() {
  const refresh = useRefreshSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => sendJson('POST', '/api/auth/logout', okResponse),
    onSettled: async () => {
      // Nothing of the old session may stay in the cache for the next person at this browser.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
      await refresh();
    },
  });
}

export function VerifyPage() {
  const refresh = useRefreshSession();
  const logout = useLogout();
  const [backup, setBackup] = useState(false);
  const verify = useMutation({
    mutationFn: (values: Record<string, string>) => sendJson('POST', '/api/auth/2fa', okResponse, values),
    onSuccess: refresh,
  });
  return (
    <AuthLayout title={t('verify.title')} intro={backup ? t('verify.backupIntro') : t('verify.intro')}>
      <form className={styles.form} onSubmit={submitWith((v) => verify.mutate(v))} noValidate>
        <FormError message={verify.isError ? errorText(verify.error) : null} />
        {backup ? (
          <Field
            key="backup"
            label={t('verify.backupCode')}
            name="code"
            variant="mono"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
          />
        ) : (
          <Field
            key="totp"
            label={t('verify.code')}
            name="code"
            variant="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            autoFocus
            required
          />
        )}
        <button className={`${styles.btn} ${styles.primary} ${styles.block}`} type="submit" disabled={verify.isPending}>
          {t('verify.submit')}
        </button>
      </form>
      <PasskeySignIn label={t('verify.passkey')} />
      <p className={styles.muted}>
        {backup ? null : `${t('verify.noAccess')} `}
        <button type="button" className={styles.linkish} onClick={() => setBackup((v) => !v)}>
          {backup ? t('verify.useTotp') : t('verify.useBackup')}
        </button>
      </p>
      <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={() => logout.mutate()}>
        {t('verify.cancel')}
      </button>
    </AuthLayout>
  );
}

export function EnrolPage() {
  const refresh = useRefreshSession();
  const [codes, setCodes] = useState<string[] | null>(null);
  // Starting enrolment writes a pending secret; one per visit is enough.
  const enrolment = useQuery({
    queryKey: ['totp-enrolment'],
    queryFn: () => sendJson('POST', '/api/auth/totp/enrol', totpEnrolmentResponse),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    enabled: codes === null,
  });
  const confirm = useMutation({
    mutationFn: (values: Record<string, string>) =>
      sendJson('POST', '/api/auth/totp/confirm', backupCodesResponse, values),
    // The session is now complete, but the codes are shown first; refreshing would leave this page.
    onSuccess: (result) => setCodes(result.backupCodes),
  });
  const passkey = useMutation({
    mutationFn: () => registerPasskey(describeAgent(navigator.userAgent)),
    onSuccess: (result) => setCodes(result.backupCodes ?? []),
  });

  if (codes) {
    return (
      <AuthLayout title={t('enrol.backupTitle')} intro={t('enrol.backupIntro')}>
        <BackupCodes codes={codes} />
        <button className={`${styles.btn} ${styles.primary} ${styles.block}`} type="button" onClick={refresh}>
          {t('enrol.continue')}
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('enrol.title')} intro={t('enrol.intro')}>
      <FormError message={enrolment.isError ? errorText(enrolment.error) : null} />
      {enrolment.data ? (
        <>
          <div className={styles.field}>
            <span className={styles.label}>{t('enrol.secret')}</span>
            <code className={styles.secret}>{enrolment.data.secret.replace(/(.{4})(?=.)/g, '$1 ')}</code>
            <a className={styles.linkish} href={enrolment.data.uri}>
              {t('enrol.openApp')}
            </a>
          </div>
          <form className={styles.form} onSubmit={submitWith((v) => confirm.mutate(v))} noValidate>
            <FormError message={confirm.isError ? errorText(confirm.error) : null} />
            <Field
              label={t('enrol.code')}
              name="code"
              variant="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              required
            />
            <button
              className={`${styles.btn} ${styles.primary} ${styles.block}`}
              type="submit"
              disabled={confirm.isPending}
            >
              {t('enrol.submit')}
            </button>
          </form>
          {passkeysSupported() ? (
            <div className={styles.form}>
              <p className={styles.divider}>{t('login.or')}</p>
              <FormError message={passkey.isError ? errorText(passkey.error) : null} />
              <button
                type="button"
                className={`${styles.btn} ${styles.outline} ${styles.block}`}
                disabled={passkey.isPending}
                onClick={() => passkey.mutate()}
              >
                {t('enrol.passkeyInstead')}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className={styles.muted} role="status">
          {t('app.loading')}
        </p>
      )}
    </AuthLayout>
  );
}
