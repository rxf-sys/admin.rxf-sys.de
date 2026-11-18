import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import styles from './App.module.css';
import { t } from './i18n.ts';
import { createAppRouter } from './router.tsx';

export function App({ router }: { router?: ReturnType<typeof createAppRouter> }) {
  const [instance] = useState(() => router ?? createAppRouter());
  return (
    <>
      <a className={styles.skip} href="#main">
        {t('app.skipToContent')}
      </a>
      <RouterProvider router={instance} />
    </>
  );
}
