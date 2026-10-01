import { useEffect, useState } from 'react';
import { hasSession, onSessionExpired } from './api';
import { Sidebar } from './components/Sidebar';
import { useConnectors } from './hooks/useConnectors';
import { useRoute } from './hooks/useRoute';
import { Activity } from './tabs/Activity';
import { Connectors } from './tabs/Connectors';
import { Home } from './tabs/Home';

// AUTH deviation from the brief: no cookies, no retry loop. If sessionStorage has no session token at
// startup, or any /api call comes back 401, show this full-page message instead of the app.
const SESSION_ENDED_MESSAGE = 'Your Studio session ended — reopen Studio from the Coco menu (⌘,).';

export function App() {
  const route = useRoute();
  const [expired, setExpired] = useState(() => !hasSession());
  const data = useConnectors();

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
      <Sidebar route={route} connectors={data.connectors} />
      <main>
        {route.page === 'activity' ? <Activity />
          : route.page === 'home' ? <Home />
          : <Connectors />}
      </main>
    </div>
  );
}
