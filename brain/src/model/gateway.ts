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

export const stripThinking = (text: string): string => text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

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
