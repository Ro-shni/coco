import { type ChatRequest, type ModelGateway, ModelRequestError, ModelUnavailableError, PriorityQueue, stripThinking } from './gateway.js';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OllamaGateway implements ModelGateway {
  private readonly queue = new PriorityQueue();

  constructor(private readonly opts: OllamaOptions) {}

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  chat(req: ChatRequest): Promise<string> {
    return this.queue.enqueue(req.priority, () => this.post(req));
  }

  private async post(req: ChatRequest): Promise<string> {
    const body = {
      model: this.opts.model,
      stream: false,
      think: false,
      messages: req.messages,
      ...(req.format ? { format: req.format } : {}),
      options: { temperature: req.temperature ?? 0.7 },
    };
    let res: Response;
    try {
      res = await this.fetch(`${this.opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw new ModelUnavailableError(`Ollama unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = `Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      // 4xx is a bad request (prompt/schema/etc.), not a reachability problem; only network errors and 5xx flip us offline.
      if (res.status >= 400 && res.status < 500) throw new ModelRequestError(detail);
      throw new ModelUnavailableError(detail);
    }
    const json = (await res.json()) as { message?: { content?: unknown } };
    const content = json.message?.content;
    if (typeof content !== 'string') throw new ModelUnavailableError('Ollama returned no message content');
    return stripThinking(content);
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.opts.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const json = (await res.json()) as { models?: { name: string }[] };
      const wanted = new Set([this.opts.model, `${this.opts.model}:latest`]);
      return (json.models ?? []).some((m) => wanted.has(m.name));
    } catch {
      return false;
    }
  }

  async supportsVision(): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.opts.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.opts.model }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { capabilities?: string[] };
      return (json.capabilities ?? []).includes('vision');
    } catch {
      return false;
    }
  }
}
