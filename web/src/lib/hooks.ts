import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

/**
 * Data-fetching hooks.
 *
 * `usePoll` powers the dashboard's auto-refresh: it re-runs the loader on an
 * interval, keeps the previous value visible while refreshing (so the UI never
 * flashes empty), pauses when the tab is hidden, and can be triggered manually.
 */

export interface PollState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  /** True while a background refresh is in flight (previous data still shown). */
  refreshing: boolean;
  refresh: () => void;
  setData: (updater: (previous: T | null) => T | null) => void;
}

export function usePoll<T>(loader: () => Promise<T>, intervalMs: number | null, deps: unknown[] = []): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Keep the latest loader without making it a dependency of the effect.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const generationRef = useRef(0);

  const run = useCallback(async (background: boolean) => {
    const generation = ++generationRef.current;
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await loaderRef.current();
      // Ignore results from a superseded request.
      if (generation !== generationRef.current) return;
      setData(result);
      setError(null);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await run(false);
    })();
    return () => {
      cancelled = true;
      generationRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  useEffect(() => {
    if (!intervalMs || intervalMs <= 0) return;
    let timer: number | null = null;
    const tick = (): void => {
      // Don't hammer the API for a tab nobody is looking at.
      if (typeof document !== 'undefined' && document.hidden) return;
      void run(true);
    };
    timer = window.setInterval(tick, intervalMs);
    const onVisible = (): void => {
      if (!document.hidden) void run(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, run]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const update = useCallback((updater: (previous: T | null) => T | null) => {
    setData((previous) => updater(previous));
  }, []);

  return { data, error, loading, refreshing, refresh, setData: update };
}

/** One-shot fetch keyed by an arbitrary parameter (used by detail views). */
export function useFetch<T>(loader: () => Promise<T>, deps: unknown[] = []): {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
} {
  return usePoll(loader, null, deps);
}

/** Debounce a rapidly changing value (search inputs). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Persist a small preference (theme, refresh interval) in localStorage. */
export function useLocalStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage may be unavailable; the preference is simply not persisted */
      }
    },
    [key],
  );
  return [value, update];
}
