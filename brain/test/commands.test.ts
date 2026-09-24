import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands.js';

describe('parseCommand', () => {
  it.each([
    ['go to slack', { type: 'focus', target: 'slack', kind: 'app' }],
    ['Coco, switch to VS Code please.', { type: 'focus', target: 'vs code', kind: 'app' }],
    ['bring up the grafana tab', { type: 'focus', target: 'grafana', kind: 'window' }],
    ['open my terminal', { type: 'focus', target: 'terminal', kind: 'app' }],
    ['back to chrome!', { type: 'focus', target: 'chrome', kind: 'app' }],
    ['focus on the devops-rca window', { type: 'focus', target: 'devops-rca', kind: 'window' }],
    ['show me what\'s wrong with this code', null],
    ['can you open it', null],
    ['open the pod logs for widget-feed-resolver in prd', null],
    ['what is this', null],
    ['hello', null],
    ['go to', null],
  ] as const)('%s', (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });
});
