import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CANNOT_ACT_FALLBACK, ChatResponder, NO_DRAFT_FALLBACK } from '../src/chat.js';
import { Memory } from '../src/memory.js';
import { ModelUnavailableError, PRIORITY } from '../src/model/gateway.js';
import { ScriptedGateway } from './helpers/fakes.js';
import { ctx } from './helpers/messages.js';

const make = (gw: ScriptedGateway, memory = new Memory(':memory:')) =>
  ({ memory, chat: new ChatResponder({ gateway: gw, memory, persona: () => '# persona', userName: 'Roshni', clock: () => 1000 }) });

describe('ChatResponder', () => {
  it('answers with persona, history, then a final message carrying fresh context and the question; stores both turns', async () => {
    const gw = new ScriptedGateway(() => 'You are looking at supply-prd p99. It spiked at 10:40.');
    const { memory, chat } = make(gw);
    memory.addTurn('user', 'earlier question', 1);
    memory.addTurn('assistant', 'earlier answer', 2);
    const reply = await chat.reply('what am I looking at?', { timeline: '10:02 Grafana', current: ctx(), incidentMode: false });
    expect(reply).toEqual({ text: 'You are looking at supply-prd p99. It spiked at 10:40.', draft: null });
    const req = gw.calls[0]!;
    expect(req.priority).toBe(PRIORITY.user);
    expect(req.format).toBeUndefined();
    expect(req.messages[0]!.content).toContain('# persona');
    expect(req.messages[0]!.content).toContain('never repeat an earlier claim about the screen');
    // history comes right after the system message, before the final context+question message
    expect(req.messages[1]).toEqual({ role: 'user', content: 'earlier question' });
    expect(req.messages[2]).toEqual({ role: 'assistant', content: 'earlier answer' });
    expect(req.messages).toHaveLength(4);
    const final = req.messages.at(-1)!;
    expect(final.role).toBe('user');
    expect(final.content).toContain('<untrusted source="screen">');
    expect(final.content).toContain('what am I looking at?');
    expect(req.messages.some((m) => m.content === 'Got it.')).toBe(false);
    expect(memory.recentTurns(2).map((t) => t.text)).toEqual(['what am I looking at?', reply.text]);
  });

  it('defaults historyTurns to 8 when not configured', async () => {
    const gw = new ScriptedGateway(() => 'ok.');
    const memory = new Memory(':memory:');
    for (let i = 0; i < 10; i++) memory.addTurn(i % 2 === 0 ? 'user' : 'assistant', `t${i}`, i);
    const chat = new ChatResponder({ gateway: gw, memory, persona: () => '# persona', userName: 'Roshni', clock: () => 1000 });
    await chat.reply('hi', { timeline: 't', incidentMode: false });
    const req = gw.calls[0]!;
    // system + 8 history turns + final message
    expect(req.messages).toHaveLength(10);
    expect(req.messages[1]).toEqual({ role: 'user', content: 't2' });
  });

  it('omits screen details for private contexts', async () => {
    const gw = new ScriptedGateway(() => 'ok.');
    await make(gw).chat.reply('hi', { timeline: 't', current: ctx({ private: true }), incidentMode: false });
    expect(gw.calls[0]!.messages[1]!.content).not.toContain('source="screen"');
  });

  it('rewrites once when the reply has filler', async () => {
    const gw = new ScriptedGateway((_, i) => (i === 0 ? 'Great question! It is Grafana. Let me know if you need more.' : 'It is Grafana, p99 for supply-prd.'));
    const reply = await make(gw).chat.reply('what is this?', { timeline: 't', incidentMode: false });
    expect(reply).toEqual({ text: 'It is Grafana, p99 for supply-prd.', draft: null });
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
    await expect(withoutLogger.reply('hi', { timeline: 't', incidentMode: false })).resolves.toEqual({ text: 'ok.', draft: null });
  });

  it('tells the model which actions it can and cannot offer', async () => {
    const gw = new ScriptedGateway(() => 'ok.');
    await make(gw).chat.reply('hi', { timeline: 't', incidentMode: false });
    expect(gw.calls[0]!.messages[0]!.content).toContain(
      '- Only offer things you can actually do: explain what\'s on screen, draft text in chat for the user to paste, or bring an app/window to the front. Never offer to send, post, reply, approve, merge, click, type, run, or open links.',
    );
  });

  it('tells the model to write drafts in a fenced block and never claim it sent them', async () => {
    const gw = new ScriptedGateway(() => 'ok.');
    await make(gw).chat.reply('hi', { timeline: 't', incidentMode: false });
    expect(gw.calls[0]!.messages[0]!.content).toContain(
      '- When the user wants to reply, answer or send a message, write the exact message they could send inside a ```draft fenced block, then one short line. Never say you sent it; the user will paste and press Enter themselves.',
    );
  });

  it('carries the persona\'s "only if" rule for the drag-me line into the system prompt', async () => {
    const personaText = readFileSync(fileURLToPath(new URL('../../config/persona.md', import.meta.url)), 'utf8');
    const gw = new ScriptedGateway(() => 'ok.');
    const chat = new ChatResponder({ gateway: gw, memory: new Memory(':memory:'), persona: () => personaText, userName: 'Roshni', clock: () => 1000 });
    await chat.reply('hi', { timeline: 't', incidentMode: false });
    expect(gw.calls[0]!.messages[0]!.content).toContain('only if');
  });

  it('asks for a rewrite when the reply claims an action, and keeps an honest rewrite', async () => {
    const gw = new ScriptedGateway((_, i) => (i === 0 ? 'Sent to Prince.' : "I can't send messages. Here's a draft: \"Approved, go ahead.\""));
    const reply = await make(gw).chat.reply('send', { timeline: 't', incidentMode: false });
    expect(reply).toEqual({ text: "I can't send messages. Here's a draft: \"Approved, go ahead.\"", draft: null });
    expect(gw.calls[1]!.messages.at(-1)!.content).toContain('claims an action you did not perform: "Sent"');
  });

  it('incident regression: a reply that keeps claiming it sent something is replaced by the safe fallback', async () => {
    const gw = new ScriptedGateway(() => "Sent to Prince. He's waiting for the approval.");
    const { memory, chat } = make(gw);
    memory.addTurn('assistant', 'Click the draft reply in the input box to send the approval.', 1);
    const reply = await chat.reply('send', { timeline: 't', current: ctx({ app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', windowTitle: 'Prince Parmar Singh (DM)' }), incidentMode: false });
    expect(gw.calls).toHaveLength(2);
    expect(reply.text).toBe(CANNOT_ACT_FALLBACK);
    expect(reply.text).toBe("I can't send or post anything yet — I can only draft text here and bring apps to the front. Want a draft you can paste?");
    expect(reply.draft).toBeNull();
    expect(reply.text).not.toContain('Sent to');
    expect(memory.recentTurns(1)[0]!.text).toBe(CANNOT_ACT_FALLBACK);
  });

  describe('drafts', () => {
    it('extracts a fenced ```draft block, returning the surrounding text separately', async () => {
      const gw = new ScriptedGateway(() => "Here's a draft:\n```draft\nI'll check the pulse mcp setup tomorrow morning.\n```\nHead over to Slack and paste it.");
      const reply = await make(gw).chat.reply('draft a reply to Prince', { timeline: 't', incidentMode: false });
      expect(reply).toEqual({
        text: "Here's a draft:\nHead over to Slack and paste it.",
        draft: "I'll check the pulse mcp setup tomorrow morning.",
      });
      expect(gw.calls).toHaveLength(1); // no rewrite needed
    });

    it('runs the honesty check on the non-draft text only: quoted claims inside the draft do not trigger a rewrite', async () => {
      const gw = new ScriptedGateway(() => "Here's a draft you can send:\n```draft\nI sent the report already, sorry for the delay.\n```\nPaste it if that works.");
      const reply = await make(gw).chat.reply('draft an apology', { timeline: 't', incidentMode: false });
      expect(gw.calls).toHaveLength(1); // the claim is inside the draft, not Coco's own text — no rewrite
      expect(reply.draft).toBe('I sent the report already, sorry for the delay.');
    });

    it('stores only the non-draft text in memory, not the draft block', async () => {
      const gw = new ScriptedGateway(() => "Here's a draft:\n```draft\nSounds good, see you then.\n```\nGo ahead and send it.");
      const { memory, chat } = make(gw);
      await chat.reply('draft a reply', { timeline: 't', incidentMode: false });
      expect(memory.recentTurns(1)[0]!.text).toBe("Here's a draft:\nGo ahead and send it.");
    });

    it('asks for a rewrite when the reply claims a draft was written but includes no draft block, then extracts it', async () => {
      const gw = new ScriptedGateway((_, i) =>
        i === 0
          ? "I've drafted a reply mentioning the postmortem."
          : "Here you go.\n```draft\nI'll join the postmortem call at 3pm.\n```\nPaste it whenever.",
      );
      const reply = await make(gw).chat.reply('draft a reply about the postmortem', { timeline: 't', incidentMode: false });
      expect(gw.calls).toHaveLength(2);
      expect(gw.calls[1]!.messages.at(-1)!.content).toBe(
        "You said you drafted a reply but didn't include it. Output the exact message inside a ```draft fenced block, then one short line.",
      );
      expect(reply).toEqual({ text: "Here you go.\nPaste it whenever.", draft: "I'll join the postmortem call at 3pm." });
    });

    it('falls back to a plain "no draft yet" message when the model keeps claiming a draft with none included', async () => {
      const gw = new ScriptedGateway(() => "I've drafted a reply for you.");
      const { memory, chat } = make(gw);
      const reply = await chat.reply('draft a reply', { timeline: 't', incidentMode: false });
      expect(gw.calls).toHaveLength(2); // one rewrite attempt only
      expect(reply).toEqual({ text: NO_DRAFT_FALLBACK, draft: null });
      expect(reply.text).toBe("I haven't written a draft yet — tell me what you'd like to say and I'll draft it.");
      expect(memory.recentTurns(1)[0]!.text).toBe(NO_DRAFT_FALLBACK);
    });
  });
});
