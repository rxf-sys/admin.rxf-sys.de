import { Link, Outlet } from '@tanstack/react-router';
import { useLogout } from '../auth/pages.tsx';
import { t } from '../i18n.ts';
import { useLiveUpdates } from '../live.ts';
import { ReauthProvider } from '../ui/reauth.tsx';
import ui from '../ui/ui.module.css';
import styles from './app.module.css';

export function AppLayout({ username }: { username: string }) {
  const logout = useLogout();
  useLiveUpdates();
  return (
    <ReauthProvider>
      <div className={styles.shell}>
        <header className={styles.top}>
          <span className={styles.brand}>{t('app.name')}</span>
          <nav aria-label={t('nav.main')} className={styles.nav}>
            <Link to="/" className={styles.navLink} activeOptions={{ exact: true }}>
              {t('nav.overview')}
            </Link>
            <Link to="/settings/security" className={styles.navLink}>
              {t('nav.settings')}
            </Link>
          </nav>
          <span className={styles.user} title={t('nav.signedInAs', { name: username })}>
            {username}
          </span>
          <button
            type="button"
            className={`${ui.btn} ${ui.ghost} ${ui.small}`}
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            {t('nav.logout')}
          </button>
        </header>
        <main id="main" className={styles.main} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </ReauthProvider>
  );
}
