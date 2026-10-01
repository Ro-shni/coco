import type { ConnectorManager, ToolResult } from '../connectors/manager.js';
import type { ToolInfo } from '../connectors/types.js';
import type { ShellPolicy, ShellTool } from './shell.js';

/** What the tool loop needs: connector tools plus Coco's built-in ones, behind one interface. */
export interface ToolSource {
  tools(): ToolInfo[];
  callTool(qualified: string, args: Record<string, unknown>): Promise<ToolResult>;
  ensureConnected(serverId: string): Promise<unknown>;
  /** Per-call policy for built-in tools whose safety depends on the arguments (the terminal command). */
  policyFor?(qualified: string, args: Record<string, unknown>): ShellPolicy | undefined;
}

export class CompositeToolSource implements ToolSource {
  constructor(
    private readonly manager: Pick<ConnectorManager, 'tools' | 'callTool' | 'ensureConnected'>,
    private readonly shell?: ShellTool,
  ) {}

  tools(): ToolInfo[] {
    return this.shell ? [...this.manager.tools(), this.shell.info] : this.manager.tools();
  }

  callTool(qualified: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.shell && qualified === this.shell.info.qualified) return this.shell.call(args);
    return this.manager.callTool(qualified, args);
  }

  async ensureConnected(serverId: string): Promise<unknown> {
    if (this.shell && serverId === this.shell.info.serverId) return undefined;
    return this.manager.ensureConnected(serverId);
  }

  policyFor(qualified: string, args: Record<string, unknown>): ShellPolicy | undefined {
    return this.shell && qualified === this.shell.info.qualified ? this.shell.policy(args) : undefined;
  }
}
