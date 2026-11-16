import styles from './App.module.css';
import { HealthStatus } from './HealthStatus.tsx';
import { t } from './i18n.ts';

export function App() {
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        {t('app.skipToContent')}
      </a>
      <header className={styles.top}>
        <span className={styles.brand}>{t('app.name')}</span>
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>
        <h1>{t('app.name')}</h1>
        <HealthStatus />
      </main>
    </div>
  );
}
