import type { ContextMsg } from '../protocol.js';

const INCIDENT = /\b(incident|outage|sev[ -]?[0-3]|p0|firing|war ?room|pagerduty)\b/i;

export function isIncident(msg: ContextMsg | undefined): boolean {
  if (!msg || msg.private) return false;
  const haystack = [msg.windowTitle, msg.url ?? '', msg.selection ?? '', (msg.ocrText ?? '').slice(0, 2000)].join(' ');
  return INCIDENT.test(haystack);
}
