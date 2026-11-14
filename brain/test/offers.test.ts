import { describe, expect, it } from 'vitest';
import { detectFocusOffer, isAffirmation } from '../src/offers.js';

describe('detectFocusOffer', () => {
  it.each([
    ['You missed a request in the DM. Want me to bring the Slack window to the front?', 'slack'],
    ['Want me to bring Grafana over?', 'grafana'],
    ['Should I switch you over to VS Code?', 'vs code'],
    ['Want me to take you to Slack?', 'slack'],
    ['I can go back to Chrome if you want.', 'chrome'],
    ['Jump to the terminal window?', 'terminal'],
  ])('extracts the target from: %s', (text, target) => {
    expect(detectFocusOffer(text)).toBe(target);
  });

  it.each([
    'p99 jumped at 10:40. Check the 10:38 deploy?',
    'Want me to bring up the diff window?',
    "Switched to Slack.",
    "That switch didn't go through.",
    '',
  ])('finds no offer in: %s', (text) => {
    expect(detectFocusOffer(text)).toBeNull();
  });
});

describe('isAffirmation', () => {
  it.each(['sure', 'Sure!', 'yes', 'yep', 'yeah', 'ok', 'okay.', 'go ahead', 'do it', 'please', 'pls', 'yes please', ' Yes please! ', 'Yes, please.', 'Sure, go ahead.', 'Ok, do it', 'yeah ok'])('accepts %s', (t) => {
    expect(isAffirmation(t)).toBe(true);
  });
  it.each(['sure, but what is this?', 'no', 'send', 'yes send it', 'ok, send it', 'yes?', '', ', .'])('rejects %s', (t) => {
    expect(isAffirmation(t)).toBe(false);
  });
});
