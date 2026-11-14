import { type ChatRequest, type ChatToolsRequest, type ChatToolsResult, type ModelGateway, type ToolCall, type ToolCapableGateway, ModelRequestError, ModelUnavailableError, PriorityQueue, stripThinking } from './gateway.js';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OllamaGateway implements ModelGateway, ToolCapableGateway {
  private readonly queue = new PriorityQueue();

  constructor(private readonly opts: OllamaOptions) {}

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  chat(req: ChatRequest): Promise<string> {
    return this.queue.enqueue(req.priority, async () => {
      const json = await this.postRaw({
        messages: req.messages,
        ...(req.format ? { format: req.format } : {}),
        options: { temperature: req.temperature ?? 0.7 },
      });
      const content = json.message?.content;
      if (typeof content !== 'string') throw new ModelUnavailableError('Ollama returned no message content');
      return stripThinking(content);
    });
  }

  chatWithTools(req: ChatToolsRequest): Promise<ChatToolsResult> {
    return this.queue.enqueue(req.priority, async () => {
      const json = await this.postRaw({
        messages: req.messages,
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        options: { temperature: req.temperature ?? 0.3 },
      });
      const content = typeof json.message?.content === 'string' ? stripThinking(json.message.content) : '';
      return { content, toolCalls: parseToolCalls(json.message?.tool_calls) };
    });
  }

  private async postRaw(extra: Record<string, unknown>): Promise<{ message?: { content?: unknown; tool_calls?: unknown } }> {
    const body = { model: this.opts.model, stream: false, think: false, ...extra };
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
      if (res.status >= 400 && res.status < 500) throw new ModelRequestError(detail);
      throw new ModelUnavailableError(detail);
    }
    return (await res.json()) as { message?: { content?: unknown; tool_calls?: unknown } };
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

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const item of raw) {
    const fn = (item as { function?: { name?: unknown; arguments?: unknown } })?.function;
    if (!fn || typeof fn.name !== 'string' || fn.name === '') continue;
    let args: unknown = fn.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) continue;
    out.push({ name: fn.name, arguments: args as Record<string, unknown> });
  }
  return out;
}
