import { streamEventData } from '@rxf/contracts';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { sessionKey } from './session.ts';

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
      // The server ended the session; reloading it sends the tab to the sign-in screen.
      void queryClient.invalidateQueries({ queryKey: sessionKey });
      return;
    case 'resync':
      void queryClient.invalidateQueries();
      return;
    default:
  }
}

const EVENT_TYPES = ['entities', 'metrics', 'instance', 'session', 'resync'] as const;

/** Keeps one live connection per tab while signed in; EventSource reconnects with Last-Event-ID by itself. */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new EventSource('/api/stream');
    const listeners = EVENT_TYPES.map((type) => {
      const listener = (event: MessageEvent<string>) => applyStreamEvent(queryClient, type, event.data);
      source.addEventListener(type, listener);
      return [type, listener] as const;
    });
    return () => {
      for (const [type, listener] of listeners) source.removeEventListener(type, listener);
      source.close();
    };
  }, [queryClient]);
}
