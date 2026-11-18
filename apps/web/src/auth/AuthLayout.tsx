import type { ReactNode } from 'react';
import { t } from '../i18n.ts';
import styles from './auth.module.css';

/** Two-column sign-in frame from the design preview; the side column collapses on narrow screens. */
export function AuthLayout({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.auth}>
      <section className={styles.side} aria-label={t('auth.side.label')}>
        <span className={styles.brand}>{t('app.name')}</span>
        <h2 className={styles.claim}>{t('auth.side.title')}</h2>
        <ul className={styles.points}>
          <li>{t('auth.side.point1')}</li>
          <li>{t('auth.side.point2')}</li>
          <li>{t('auth.side.point3')}</li>
        </ul>
        <span className={styles.band} aria-hidden="true" />
      </section>
      <main id="main" className={styles.main} tabIndex={-1}>
        <div className={styles.card}>
          <div>
            <h1>{title}</h1>
            {intro ? <p className={styles.sub}>{intro}</p> : null}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
