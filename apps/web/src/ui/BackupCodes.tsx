import { useState } from 'react';
import { t } from '../i18n.ts';
import styles from './ui.module.css';

/** One-time codes as a list plus a copy button; the copy confirmation is announced politely. */
export function BackupCodes({ codes }: { codes: readonly string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.field}>
      <ul className={styles.codes} aria-label={t('codes.label')}>
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className={styles.actions}>
        <span className={styles.muted} role="status">
          {copied ? t('codes.copied') : ''}
        </span>
        <button
          type="button"
          className={`${styles.btn} ${styles.outline} ${styles.small}`}
          onClick={() => {
            void navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true));
          }}
        >
          {t('codes.copy')}
        </button>
      </div>
    </div>
  );
}
