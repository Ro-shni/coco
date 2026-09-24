import { describe, expect, it } from 'vitest';
import { ModelRequestError, ModelUnavailableError, PRIORITY } from '../../src/model/gateway.js';
import { OllamaGateway } from '../../src/model/ollama.js';

type Call = { url: string; body: unknown };

function fakeFetch(handler: (url: string, body: unknown) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return handler(url, body);
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });

describe('OllamaGateway.chat', () => {
  it('posts a non-streaming, non-thinking chat request and returns the content', async () => {
    const f = fakeFetch(() => ok({ message: { content: '<think>x</think>{"speak":false}' } }));
    const gw = new OllamaGateway({ baseUrl: 'http://ollama', model: 'qwen3.5:9b', fetchImpl: f.impl });
    const out = await gw.chat({
      messages: [{ role: 'user', content: 'hi', images: ['abc'] }],
      format: { type: 'object' },
      priority: PRIORITY.user,
      temperature: 0.5,
    });
    expect(out).toBe('{"speak":false}');
    expect(f.calls[0]!.url).toBe('http://ollama/api/chat');
    expect(f.calls[0]!.body).toEqual({
      model: 'qwen3.5:9b',
      stream: false,
      think: false,
      messages: [{ role: 'user', content: 'hi', images: ['abc'] }],
      format: { type: 'object' },
      options: { temperature: 0.5 },
    });
  });

  it('omits format when not given', async () => {
    const f = fakeFetch(() => ok({ message: { content: 'hello' } }));
    const gw = new OllamaGateway({ baseUrl: 'http://ollama', model: 'm', fetchImpl: f.impl });
    await gw.chat({ messages: [], priority: PRIORITY.tick });
    expect(f.calls[0]!.body).not.toHaveProperty('format');
  });

  it('throws ModelUnavailableError when the server is unreachable', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const gw = new OllamaGateway({ baseUrl: 'http://ollama', model: 'm', fetchImpl: f.impl });
    await expect(gw.chat({ messages: [], priority: PRIORITY.tick })).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('throws ModelRequestError on 4xx (a bad request, not an outage), including the status', async () => {
    const f = fakeFetch(() => new Response('model not found', { status: 404 }));
    const gw = new OllamaGateway({ baseUrl: 'http://ollama', model: 'm', fetchImpl: f.impl });
    const err: unknown = await gw.chat({ messages: [], priority: PRIORITY.tick }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(err).not.toBeInstanceOf(ModelUnavailableError);
    expect((err as Error).message).toMatch(/404.*model not found/);
  });

  it('throws ModelUnavailableError on 5xx, including the status', async () => {
    const f = fakeFetch(() => new Response('server exploded', { status: 500 }));
    const gw = new OllamaGateway({ baseUrl: 'http://ollama', model: 'm', fetchImpl: f.impl });
    const err: unknown = await gw.chat({ messages: [], priority: PRIORITY.tick }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as Error).message).toMatch(/500.*server exploded/);
  });

  it('throws when the response has no content', async () => {
    const f = fakeFetch(() => ok({}));
    const gw = new OllamaGateway({ baseUrl: 'http://ollama', model: 'm', fetchImpl: f.impl });
    await expect(gw.chat({ messages: [], priority: PRIORITY.tick })).rejects.toThrow(/no message content/);
  });
});

describe('OllamaGateway.health / supportsVision', () => {
  it('is healthy when the model is listed (with or without :latest)', async () => {
    const f = fakeFetch(() => ok({ models: [{ name: 'llama3:latest' }, { name: 'qwen3.5:9b' }] }));
    expect(await new OllamaGateway({ baseUrl: 'http://o', model: 'qwen3.5:9b', fetchImpl: f.impl }).health()).toBe(true);
    expect(await new OllamaGateway({ baseUrl: 'http://o', model: 'llama3', fetchImpl: f.impl }).health()).toBe(true);
    expect(await new OllamaGateway({ baseUrl: 'http://o', model: 'gemma3', fetchImpl: f.impl }).health()).toBe(false);
  });

  it('is unhealthy when unreachable', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await new OllamaGateway({ baseUrl: 'http://o', model: 'm', fetchImpl: f.impl }).health()).toBe(false);
  });

  it('reads vision support from /api/show capabilities', async () => {
    const yes = fakeFetch(() => ok({ capabilities: ['completion', 'vision'] }));
    const no = fakeFetch(() => ok({ capabilities: ['completion'] }));
    expect(await new OllamaGateway({ baseUrl: 'http://o', model: 'm', fetchImpl: yes.impl }).supportsVision()).toBe(true);
    expect(yes.calls[0]).toEqual({ url: 'http://o/api/show', body: { model: 'm' } });
    expect(await new OllamaGateway({ baseUrl: 'http://o', model: 'm', fetchImpl: no.impl }).supportsVision()).toBe(false);
  });
});
