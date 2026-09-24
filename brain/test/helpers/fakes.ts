import type { ChatRequest, ModelGateway } from '../../src/model/gateway.js';

export class ScriptedGateway implements ModelGateway {
  readonly calls: ChatRequest[] = [];
  healthy = true;
  vision = true;

  constructor(private readonly responder: (req: ChatRequest, index: number) => string | Error) {}

  async chat(req: ChatRequest): Promise<string> {
    this.calls.push(req);
    const result = this.responder(req, this.calls.length - 1);
    if (result instanceof Error) throw result;
    return result;
  }

  async health(): Promise<boolean> {
    return this.healthy;
  }

  async supportsVision(): Promise<boolean> {
    return this.vision;
  }
}

export const json = (o: unknown): string => JSON.stringify(o);
