import type { ServerState } from '../types';

export const STATE_LABEL: Record<ServerState, string> = {
  connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected', needs_auth: 'Needs sign-in', error: 'Error', disabled: 'Disabled',
};

export function StatusDot({ state }: { state: ServerState }) {
  return <span className={`dot dot-${state}`} title={STATE_LABEL[state]} role="img" aria-label={STATE_LABEL[state]} />;
}

export function StatusPill({ state }: { state: ServerState }) {
  return <span className={`pill pill-${state}`}>{STATE_LABEL[state]}</span>;
}
