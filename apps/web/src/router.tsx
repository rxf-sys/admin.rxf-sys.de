import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  type RouterHistory,
  useRouterState,
} from '@tanstack/react-router';
import { AppLayout } from './app/AppLayout.tsx';
import { DashboardPage, SecurityPage } from './app/pages.tsx';
import { EnrolPage, LoginPage, SetupPage, VerifyPage } from './auth/pages.tsx';
import { t } from './i18n.ts';
import { stageOf, stagePaths, useSession } from './session.ts';
import ui from './ui/ui.module.css';

function Status({ text }: { text: string }) {
  return (
    <main id="main" className={`${ui.card} ${ui.standalone}`} tabIndex={-1}>
      <p role="status">{text}</p>
    </main>
  );
}

/**
 * Sends every visitor to the screen their session allows (ADR 0005): setup, sign-in, second factor,
 * enrolment or the app. The server still checks every request; this only picks the screen.
 */
function Root() {
  const session = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (session.isPending) return <Status text={t('app.loading')} />;
  if (session.isError) return <Status text={t('app.offline')} />;
  const stage = stageOf(session.data);
  if (stage !== 'app') {
    const target = stagePaths[stage];
    return pathname === target ? <Outlet /> : <Navigate to={target} replace />;
  }
  if (Object.values(stagePaths).includes(pathname)) return <Navigate to="/" replace />;
  return <Outlet />;
}

function SignedIn() {
  const session = useSession();
  const username = session.data?.authenticated ? session.data.user.username : '';
  return <AppLayout username={username} />;
}

const rootRoute = createRootRoute({ component: Root });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: SignedIn });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/setup', component: SetupPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/login/verify', component: VerifyPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/enrol', component: EnrolPage }),
  appRoute.addChildren([
    createRoute({ getParentRoute: () => appRoute, path: '/', component: DashboardPage }),
    createRoute({ getParentRoute: () => appRoute, path: '/settings/security', component: SecurityPage }),
  ]),
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history ? { history } : {}),
    defaultNotFoundComponent: () => <Navigate to="/" />,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
