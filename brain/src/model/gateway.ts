export const PRIORITY = { user: 0, trigger: 1, tick: 2 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  format?: Record<string, unknown>;
  priority: Priority;
  temperature?: number;
}

export interface ModelGateway {
  chat(req: ChatRequest): Promise<string>;
  health(): Promise<boolean>;
  supportsVision(): Promise<boolean>;
}

export class ModelUnavailableError extends Error {
  override name = 'ModelUnavailableError';
}

/** A request the model rejected outright (HTTP 4xx) — a bad call, not a reachability problem. */
export class ModelRequestError extends Error {
  override name = 'ModelRequestError';
}

export const stripThinking = (text: string): string => text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolChatMessage =
  | ChatMessage
  | { role: 'assistant'; content: string; tool_calls: { function: { name: string; arguments: Record<string, unknown> } }[] }
  | { role: 'tool'; content: string; tool_name: string };

export interface ChatToolsRequest {
  messages: ToolChatMessage[];
  tools: ToolSpec[];
  priority: Priority;
  temperature?: number;
}

export interface ChatToolsResult {
  content: string;
  toolCalls: ToolCall[];
}

/** Separate from ModelGateway so existing fakes don't need a tool-calling stub. */
export interface ToolCapableGateway {
  chatWithTools(req: ChatToolsRequest): Promise<ChatToolsResult>;
}

interface QueueItem {
  priority: Priority;
  seq: number;
  run: () => Promise<void>;
}

export class PriorityQueue {
  private items: readonly QueueItem[] = [];
  private running = false;
  private seq = 0;

  get size(): number {
    return this.items.length;
  }

  enqueue<T>(priority: Priority, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = { priority, seq: this.seq++, run: () => task().then(resolve, reject) };
      this.items = [...this.items, item].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const [next, ...rest] = this.items;
        this.items = rest;
        await next!.run();
      }
    } finally {
      this.running = false;
    }
  }
}
