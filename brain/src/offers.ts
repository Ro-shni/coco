import { parseCommand } from './commands.js';

/** "bring X to the front", "switch X over", "jump to the X window". */
const VERB_WITH_PLACE = /\b(?:bring|switch|take you|jump)\b(?=.*\b(?:front|window|over)\b)/i;
/** "go (back) to X", "switch (over) to X", "take you to X". */
const GO_TO = /\b(?:go|switch|jump|take you)\s+(?:back\s+|over\s+)?to\b/i;
const KNOWN_APP = /\b(?:slack|chrome|vs ?code|terminal|grafana)\b/i;
/** A proper-noun app name such as "Slack", "Arc" or "VS Code" (case-sensitive on purpose). */
const NAMED_APP = /\b[A-Z][\w.-]*(?:\s[A-Z][\w.-]*)?/;

function firstName(rest: string): string | null {
  const hits = [rest.match(KNOWN_APP), rest.match(NAMED_APP)].filter((m): m is RegExpMatchArray => m !== null);
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => (b.index! < a.index! ? b : a))[0];
}

/**
 * Returns the normalised app target when Coco's text offers to bring an app to the front
 * (e.g. "Want me to bring the Slack window to the front?" -> "slack"), otherwise null.
 */
export function detectFocusOffer(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const verb = sentence.match(GO_TO) ?? sentence.match(VERB_WITH_PLACE);
    if (!verb) continue;
    const name = firstName(sentence.slice(verb.index! + verb[0].length));
    const target = name ? parseCommand(`go to ${name}`)?.target : undefined;
    if (target) return target;
  }
  return null;
}

const AFFIRMATION = /^(sure|yes|yep|yeah|ok(ay)?|go ahead|do it|please|pls|yes please)[.! ]*$/i;

export function isAffirmation(text: string): boolean {
  return AFFIRMATION.test(text.trim());
}
