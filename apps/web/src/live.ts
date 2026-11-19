import { streamEventData } from '@rxf/contracts';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import * as z from 'zod/mini';
import { ApiError, okResponse, sendJson } from './api.ts';
import { sessionKey } from './session.ts';

/** After this long in a hidden tab, the tab reports that nothing is visible (ADR 0007). */
const HIDDEN_GRACE_MS = 30_000;
/** Several widgets mount at once; one watch request covers them all. */
const WATCH_DEBOUNCE_MS = 250;

const helloEvent = z.object({ connectionId: z.string() });

/** Turns one stream event into cache invalidations (ADR 0007: events say what changed, never the data). */
function applyStreamEvent(queryClient: QueryClient, type: string, raw: string): void {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  switch (type) {
    case 'entities': {
      const event = streamEventData.entities.safeParse(data);
      if (event.success) void queryClient.invalidateQueries({ queryKey: ['entities', event.data.instanceId] });
      return;
    }
    case 'metrics':
      if (streamEventData.metrics.safeParse(data).success)
        void queryClient.invalidateQueries({ queryKey: ['metrics'] });
      return;
    case 'instance':
      if (streamEventData.instance.safeParse(data).success) {
        void queryClient.invalidateQueries({ queryKey: ['instances'] });
      }
      return;
    case 'session':
      // The server ended the session: drop what it could see, as a manual logout does, and reload the
      // session, which sends the tab to the sign-in screen.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
      void queryClient.invalidateQueries({ queryKey: sessionKey });
      return;
    case 'resync':
      void queryClient.invalidateQueries();
      return;
    default:
  }
}

const EVENT_TYPES = ['entities', 'metrics', 'instance', 'session', 'resync'] as const;

type Register = (instanceId: string, visible: boolean) => void;
const WatchContext = createContext<Register>(() => {});

/**
 * One live connection per tab while signed in (EventSource reconnects with Last-Event-ID by itself), plus
 * the "who is watching" report: widgets register while they are on screen, and the tab sends their
 * instances to `/api/stream/watch` so those collectors poll at the active interval.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [watched, setWatched] = useState<ReadonlyMap<string, number>>(new Map());
  const sent = useRef<string | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    const onHello = (event: MessageEvent<string>) => {
      const hello = helloEvent.safeParse(JSON.parse(event.data));
      if (hello.success) setConnectionId(hello.data.connectionId);
    };
    source.addEventListener('hello', onHello);
    const listeners = EVENT_TYPES.map((type) => {
      const listener = (event: MessageEvent<string>) => applyStreamEvent(queryClient, type, event.data);
      source.addEventListener(type, listener);
      return [type, listener] as const;
    });
    return () => {
      source.removeEventListener('hello', onHello);
      for (const [type, listener] of listeners) source.removeEventListener(type, listener);
      source.close();
    };
  }, [queryClient]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') timer = setTimeout(() => setHidden(true), HIDDEN_GRACE_MS);
      else setHidden(false);
    };
    document.addEventListener('visibilitychange', onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);

  useEffect(() => {
    if (!connectionId) return;
    const instanceIds = hidden ? [] : [...watched.keys()].sort();
    const key = `${connectionId}|${instanceIds.join(',')}`;
    if (sent.current === key) return;
    const timer = setTimeout(() => {
      sent.current = key;
      sendJson('POST', '/api/stream/watch', okResponse, { connectionId, instanceIds }).catch((error: unknown) => {
        // A stream that reconnected in between has a new id; its hello triggers the next report.
        if (!(error instanceof ApiError && error.code === 'STREAM_NOT_FOUND')) throw error;
      });
    }, WATCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [connectionId, hidden, watched]);

  const register = useCallback<Register>((instanceId, visible) => {
    setWatched((current) => {
      const next = new Map(current);
      const count = (next.get(instanceId) ?? 0) + (visible ? 1 : -1);
      if (count > 0) next.set(instanceId, count);
      else next.delete(instanceId);
      return next;
    });
  }, []);

  return createElement(WatchContext.Provider, { value: register }, children);
}

/** Reports an instance as watched while `visible` is true. */
export function useWatch(instanceId: string, visible: boolean): void {
  const register = useContext(WatchContext);
  useEffect(() => {
    if (!visible) return;
    register(instanceId, true);
    return () => register(instanceId, false);
  }, [instanceId, visible, register]);
}
