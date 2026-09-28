import { useEffect, useState } from 'react';
import { hasSession, onSessionExpired } from './api';
import { Activity } from './tabs/Activity';
import { Connectors } from './tabs/Connectors';
import { Home } from './tabs/Home';

const TABS = { home: 'Home', connectors: 'Connectors', activity: 'Activity' } as const;
type Tab = keyof typeof TABS;

// AUTH deviation from the brief: no cookies, no retry loop. If sessionStorage has no session token at
// startup, or any /api call comes back 401, show this full-page message instead of the tabs.
const SESSION_ENDED_MESSAGE = 'Your Studio session ended — reopen Studio from the Coco menu (⌘,).';

export function App() {
  const initial = (location.hash.slice(1) as Tab) in TABS ? (location.hash.slice(1) as Tab) : 'home';
  const [tab, setTab] = useState<Tab>(initial);
  const [expired, setExpired] = useState(() => !hasSession());

  useEffect(() => onSessionExpired(() => setExpired(true)), []);

  if (expired) {
    return (
      <div className="session-expired" role="alert">
        <p>{SESSION_ENDED_MESSAGE}</p>
      </div>
    );
  }

  return (
    <div className="app">
      <nav aria-label="Studio">
        <div className="brand">Coco Studio</div>
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => { setTab(t); location.hash = t; }}>{TABS[t]}</button>
        ))}
      </nav>
      <main>{tab === 'home' ? <Home /> : tab === 'connectors' ? <Connectors /> : <Activity />}</main>
    </div>
  );
}
