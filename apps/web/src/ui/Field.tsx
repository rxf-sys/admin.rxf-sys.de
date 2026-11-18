import { type InputHTMLAttributes, useId, useState } from 'react';
import { t } from '../i18n.ts';
import styles from './ui.module.css';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  variant?: 'mono' | 'otp';
}

/** Label, input and optional hint, wired with ids so screen readers announce them together. */
export function Field({ label, hint, variant, className, ...input }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const classes = [styles.input, variant ? styles[variant] : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input id={id} className={classes} aria-describedby={hint ? hintId : undefined} {...input} />
      {hint ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Password input with a show/hide toggle. */
export function PasswordField({ label, hint, ...input }: Omit<FieldProps, 'variant' | 'type'>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [visible, setVisible] = useState(false);
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.inputGroup}>
        <input
          id={id}
          className={styles.input}
          type={visible ? 'text' : 'password'}
          aria-describedby={hint ? hintId : undefined}
          {...input}
        />
        <button
          type="button"
          className={`${styles.btn} ${styles.outline}`}
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible((v) => !v)}
        >
          {t('login.showPassword')}
        </button>
      </div>
      {hint ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Announces a form error to screen readers as soon as it appears. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className={`${styles.callout} ${styles.crit}`} role="alert">
      {message}
    </div>
  );
}

/** The data of a submitted form as strings. */
export function formValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new FormData(form)) out[key] = typeof value === 'string' ? value : '';
  return out;
}
