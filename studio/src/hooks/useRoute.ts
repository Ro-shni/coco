import { useEffect, useState } from 'react';

export type Route =
  | { page: 'home' } | { page: 'connectors' } | { page: 'connector'; id: string }
  | { page: 'terminal' } | { page: 'playground' } | { page: 'activity' };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [head, ...rest] = raw.split('/');
  const tail = rest.join('/');
  if (head === 'connectors' && tail) return { page: 'connector', id: decodeURIComponent(tail) };
  if (head === 'connectors' || head === 'terminal' || head === 'playground' || head === 'activity') return { page: head };
  return { page: 'home' };
}

export function connectorHref(id: string): string {
  return `#connectors/${encodeURIComponent(id)}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
