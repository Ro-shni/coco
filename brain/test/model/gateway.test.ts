import { describe, expect, it } from 'vitest';
import { PRIORITY, PriorityQueue, stripThinking } from '../../src/model/gateway.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('PriorityQueue', () => {
  it('runs one task at a time, higher priority first, FIFO within a priority', async () => {
    const q = new PriorityQueue();
    const order: string[] = [];
    const gate = deferred();
    const first = q.enqueue(PRIORITY.tick, async () => {
      await gate.promise;
      order.push('tick-running');
    });
    const a = q.enqueue(PRIORITY.tick, async () => void order.push('tick-a'));
    const b = q.enqueue(PRIORITY.user, async () => void order.push('user-b'));
    const c = q.enqueue(PRIORITY.trigger, async () => void order.push('trigger-c'));
    const d = q.enqueue(PRIORITY.user, async () => void order.push('user-d'));
    expect(q.size).toBe(4);
    gate.resolve();
    await Promise.all([first, a, b, c, d]);
    expect(order).toEqual(['tick-running', 'user-b', 'user-d', 'trigger-c', 'tick-a']);
  });

  it('propagates task errors to the caller and keeps draining', async () => {
    const q = new PriorityQueue();
    const failing = q.enqueue(PRIORITY.user, async () => {
      throw new Error('boom');
    });
    const ok = q.enqueue(PRIORITY.user, async () => 42);
    await expect(failing).rejects.toThrow('boom');
    await expect(ok).resolves.toBe(42);
  });
});

describe('stripThinking', () => {
  it('removes <think> blocks and trims', () => {
    expect(stripThinking('<think>hmm\nok</think>\n  {"a":1} ')).toBe('{"a":1}');
  });
});
