import type { ServerState } from '../types';
const LABEL: Record<ServerState, string> = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected', needs_auth: 'Needs sign-in', error: 'Error', disabled: 'Disabled' };
export function StatusDot({ state }: { state: ServerState }) {
  return <span className={`dot dot-${state}`} title={LABEL[state]} aria-label={LABEL[state]} />;
}
