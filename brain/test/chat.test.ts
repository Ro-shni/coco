import { describe, expect, it, vi } from 'vitest';
import { ChatResponder } from '../src/chat.js';
import { Memory } from '../src/memory.js';
import { ModelUnavailableError, PRIORITY } from '../src/model/gateway.js';
import { ScriptedGateway } from './helpers/fakes.js';
import { ctx } from './helpers/messages.js';

const make = (gw: ScriptedGateway, memory = new Memory(':memory:')) =>
  ({ memory, chat: new ChatResponder({ gateway: gw, memory, persona: () => '# persona', userName: 'Roshni', clock: () => 1000 }) });

describe('ChatResponder', () => {
  it('answers with persona, untrusted context, history and the question; stores both turns', async () => {
    const gw = new ScriptedGateway(() => 'You are looking at supply-prd p99. It spiked at 10:40.');
    const { memory, chat } = make(gw);
    memory.addTurn('user', 'earlier question', 1);
    memory.addTurn('assistant', 'earlier answer', 2);
    const reply = await chat.reply('what am I looking at?', { timeline: '10:02 Grafana', current: ctx(), incidentMode: false });
    expect(reply).toBe('You are looking at supply-prd p99. It spiked at 10:40.');
    const req = gw.calls[0]!;
    expect(req.priority).toBe(PRIORITY.user);
    expect(req.format).toBeUndefined();
    expect(req.messages[0]!.content).toContain('# persona');
    expect(req.messages[1]!.content).toContain('<untrusted source="screen">');
    expect(req.messages.map((m) => m.content)).toContain('earlier answer');
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'what am I looking at?' });
    expect(memory.recentTurns(2).map((t) => t.text)).toEqual(['what am I looking at?', reply]);
  });

  it('omits screen details for private contexts', async () => {
    const gw = new ScriptedGateway(() => 'ok.');
    await make(gw).chat.reply('hi', { timeline: 't', current: ctx({ private: true }), incidentMode: false });
    expect(gw.calls[0]!.messages[1]!.content).not.toContain('source="screen"');
  });

  it('rewrites once when the reply has filler', async () => {
    const gw = new ScriptedGateway((_, i) => (i === 0 ? 'Great question! It is Grafana. Let me know if you need more.' : 'It is Grafana, p99 for supply-prd.'));
    const reply = await make(gw).chat.reply('what is this?', { timeline: 't', incidentMode: false });
    expect(reply).toBe('It is Grafana, p99 for supply-prd.');
    expect(gw.calls[1]!.messages.at(-1)!.content).toMatch(/filler/);
  });

  it('does not store turns when the model is unavailable', async () => {
    const gw = new ScriptedGateway(() => new ModelUnavailableError('down'));
    const { memory, chat } = make(gw);
    await expect(chat.reply('hi', { timeline: 't', incidentMode: false })).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(memory.recentTurns(5)).toEqual([]);
  });

  it('logs chat_prompt diagnostics (counts only) through an injected logger when a screen block is included', async () => {
    const gw = new ScriptedGateway(() => 'ok.');
    const memory = new Memory(':memory:');
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const chat = new ChatResponder({ gateway: gw, memory, persona: () => '# persona', userName: 'Roshni', clock: () => 1000, logger });
    memory.addTurn('user', 'earlier question', 1);
    memory.addTurn('assistant', 'earlier answer', 2);
    await chat.reply('what am I looking at?', { timeline: '10:02 Grafana', current: ctx(), incidentMode: false });
    expect(logger.info).toHaveBeenCalledWith('chat_prompt', {
      systemChars: expect.any(Number),
      screenBlockChars: expect.any(Number),
      includesScreenBlock: true,
      historyTurns: 2,
    });
    const [, data] = logger.info.mock.calls.find(([event]) => event === 'chat_prompt')!;
    expect((data as { screenBlockChars: number }).screenBlockChars).toBeGreaterThan(0);
  });

  it('logs includesScreenBlock=false for private contexts, and stays silent without an injected logger', async () => {
    const gw = new ScriptedGateway(() => 'ok.');
    const memory = new Memory(':memory:');
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const withLogger = new ChatResponder({ gateway: gw, memory, persona: () => '# persona', userName: 'Roshni', clock: () => 1000, logger });
    await withLogger.reply('hi', { timeline: 't', current: ctx({ private: true }), incidentMode: false });
    expect(logger.info).toHaveBeenCalledWith('chat_prompt', expect.objectContaining({ includesScreenBlock: false, screenBlockChars: 0 }));

    // No logger injected: defaults to silent, must not throw.
    const withoutLogger = new ChatResponder({ gateway: gw, memory, persona: () => '# persona', userName: 'Roshni', clock: () => 1000 });
    await expect(withoutLogger.reply('hi', { timeline: 't', incidentMode: false })).resolves.toBe('ok.');
  });
});
