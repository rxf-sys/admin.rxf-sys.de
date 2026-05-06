import { useEffect, useRef, useState } from 'react';

export interface PollState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  lastFetched: number;
  refresh: () => void;
}

export function usePoll<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState(0);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);

    loaderRef
      .current(controller.signal)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
        setLastFetched(Date.now());
      })
      .catch((e: Error) => {
        if (cancelled || controller.signal.aborted) return;
        setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  useEffect(() => {
    if (intervalMs <= 0) return;
    const t = setInterval(() => setTick((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  return { data, error, loading, lastFetched, refresh: () => setTick((x) => x + 1) };
}
