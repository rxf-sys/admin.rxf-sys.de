import { reauthResponse } from '@rxf/contracts';
import { useMutation } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, sendJson } from '../api.ts';
import { t } from '../i18n.ts';
import { errorText } from './errors.ts';
import { Field, FormError, formValues, PasswordField } from './Field.tsx';
import styles from './ui.module.css';

type Ask = () => Promise<boolean>;

const ReauthContext = createContext<Ask | null>(null);

/**
 * Hosts the "confirm your identity" dialog (ADR 0005, sudo mode). A native <dialog> gives focus trapping,
 * Escape and an inert background without a library or injected styles (ADR 0008, CSP).
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);
  const confirm = useMutation({
    mutationFn: (values: Record<string, string>) => sendJson('POST', '/api/auth/reauth', reauthResponse, values),
  });

  const finish = useCallback(
    (ok: boolean) => {
      pending.current?.(ok);
      pending.current = null;
      confirm.reset();
      setOpen(false);
    },
    [confirm],
  );

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const ask = useCallback<Ask>(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        setOpen(true);
      }),
    [],
  );

  return (
    <ReauthContext.Provider value={ask}>
      {children}
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="reauth-title"
        onCancel={(event) => {
          event.preventDefault();
          finish(false);
        }}
      >
        {open ? (
          <form
            className={styles.dialogBody}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              confirm.mutate(formValues(event.currentTarget), { onSuccess: () => finish(true) });
            }}
          >
            <div className={styles.field}>
              <h2 id="reauth-title" className={styles.cardTitle}>
                {t('reauth.title')}
              </h2>
              <p className={styles.muted}>{t('reauth.intro')}</p>
            </div>
            <FormError
              message={
                confirm.isError ? errorText(confirm.error, { INVALID_CREDENTIALS: t('error.INVALID_REAUTH') }) : null
              }
            />
            <PasswordField label={t('reauth.password')} name="password" autoComplete="current-password" required />
            <Field
              label={t('reauth.code')}
              name="code"
              variant="mono"
              inputMode="text"
              autoComplete="one-time-code"
              required
            />
            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={() => finish(false)}>
                {t('reauth.cancel')}
              </button>
              <button type="submit" className={`${styles.btn} ${styles.primary}`} disabled={confirm.isPending}>
                {t('reauth.submit')}
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </ReauthContext.Provider>
  );
}

/**
 * Runs a request that may need a fresh re-authentication: on `REAUTH_REQUIRED` it asks for password and code
 * and retries once. Resolves to null when the person cancels.
 */
export function useElevated() {
  const ask = useContext(ReauthContext);
  if (!ask) throw new Error('useElevated needs a ReauthProvider');
  return useCallback(
    async <T,>(run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'REAUTH_REQUIRED') throw error;
        if (!(await ask())) return null;
        return run();
      }
    },
    [ask],
  );
}
