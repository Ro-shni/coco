import { useCallback, useEffect, useState } from 'react';
import { api, SessionExpiredError } from '../api';
import type { ConnectorView } from '../types';

export interface ConnectorsState { connectors: ConnectorView[]; loaded: boolean; error?: string; reload: () => Promise<void> }

/** Loads GET /api/connectors once, then on window focus. Shared by the sidebar and every page. */
export function useConnectors(): ConnectorsState {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      setConnectors(await api<ConnectorView[]>('GET', '/api/connectors'));
      setError(undefined);
    } catch (e) {
      if (e instanceof SessionExpiredError) return; // full-page message already shown
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  return { connectors, loaded, error, reload };
}
