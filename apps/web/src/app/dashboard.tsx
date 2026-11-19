import { type InstanceResponse, instanceListResponse, queryKeys } from '@rxf/contracts';
import type { WidgetDefinition, WidgetProps } from '@rxf/web-sdk';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Component,
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from 'react';
import { getJson } from '../api.ts';
import { t } from '../i18n.ts';
import { useWatch } from '../live.ts';
import { dataAccess, loadWebPlugin } from '../plugins.ts';
import ui from '../ui/ui.module.css';
import styles from './dashboard.module.css';

/** True while the element is on screen; `seen` stays true once it was, so code is loaded only once. */
function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [state, setState] = useState({ visible: false, seen: false });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      const visible = entry?.isIntersecting ?? false;
      setState((s) => ({ visible, seen: s.seen || visible }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, ...state };
}

const lazyWidgets = new Map<string, LazyExoticComponent<ComponentType<WidgetProps>>>();

function widgetComponent(key: string, definition: WidgetDefinition) {
  let component = lazyWidgets.get(key);
  if (!component) {
    component = lazy(definition.component);
    lazyWidgets.set(key, component);
  }
  return component;
}

class WidgetBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <p className={ui.muted}>{t('dashboard.widgetError')}</p> : this.props.children;
  }
}

function healthNote(instance: InstanceResponse): string | null {
  if (instance.status === 'paused') return t('dashboard.paused');
  if (instance.health === 'failing') return t('dashboard.failing');
  if (instance.health === 'breaker-open') return t('dashboard.breakerOpen');
  return null;
}

/** The widgets of one instance; plugin code loads only when the frame first scrolls into view (ADR 0003). */
function InstanceWidgets({ instance }: { instance: InstanceResponse }) {
  const { ref, visible, seen } = useInView<HTMLElement>();
  useWatch(instance.id, visible && instance.status === 'active');
  const plugin = useQuery({
    queryKey: ['web-plugin', instance.pluginId],
    queryFn: () => loadWebPlugin(instance.pluginId),
    enabled: seen,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const note = healthNote(instance);
  const widgets = plugin.data ? Object.entries(plugin.data.widgets) : [];
  return (
    <section ref={ref} className={styles.frame} aria-labelledby={`instance-${instance.id}`}>
      <header className={styles.frameHead}>
        <h2 id={`instance-${instance.id}`} className={ui.cardTitle}>
          {instance.name}
        </h2>
        {note ? (
          <span className={styles.note} data-status={instance.status === 'paused' ? 'paused' : 'warn'}>
            {note}
          </span>
        ) : null}
      </header>
      {plugin.data === null ? <p className={ui.muted}>{t('dashboard.unknownPlugin')}</p> : null}
      {widgets.map(([widgetId, definition]) => {
        const Widget = widgetComponent(`${instance.pluginId}:${widgetId}`, definition);
        return (
          <div key={widgetId} className={styles.widget}>
            <h3 className={styles.widgetTitle}>{definition.title.de}</h3>
            <WidgetBoundary>
              <Suspense fallback={<p className={ui.muted}>{t('app.loading')}</p>}>
                <Widget instanceId={instance.id} size="L" data={dataAccess} locale="de" />
              </Suspense>
            </WidgetBoundary>
          </div>
        );
      })}
    </section>
  );
}

/** Fixed board template (owner decision 18.11.2026): the widgets of every active or paused instance. */
export function DashboardPage({ isAdmin }: { isAdmin: boolean }) {
  const instances = useQuery({
    queryKey: queryKeys.instances,
    queryFn: () => getJson('/api/instances', instanceListResponse),
  });
  const shown = instances.data?.instances.filter((instance) => instance.status !== 'draft') ?? [];
  return (
    <>
      <div className={styles.head}>
        <h1>{t('dashboard.title')}</h1>
        {isAdmin && shown.length > 0 ? (
          <Link to="/onboarding" className={`${ui.btn} ${ui.outline} ${ui.small}`}>
            {t('dashboard.add')}
          </Link>
        ) : null}
      </div>
      {instances.isPending ? <p className={ui.muted}>{t('app.loading')}</p> : null}
      {instances.data && shown.length === 0 ? (
        <section className={ui.card}>
          <p>{t('dashboard.empty')}</p>
          <p className={ui.muted}>{isAdmin ? t('dashboard.emptyAdmin') : t('dashboard.emptyViewer')}</p>
          {isAdmin ? (
            <div>
              <Link to="/onboarding" className={`${ui.btn} ${ui.primary}`}>
                {t('dashboard.add')}
              </Link>
            </div>
          ) : null}
        </section>
      ) : null}
      <div className={styles.board}>
        {shown.map((instance) => (
          <InstanceWidgets key={instance.id} instance={instance} />
        ))}
      </div>
    </>
  );
}
