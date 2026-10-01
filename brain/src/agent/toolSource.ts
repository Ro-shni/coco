import type { ConnectorManager, ToolResult } from '../connectors/manager.js';
import type { ToolInfo } from '../connectors/types.js';
import type { ShellPolicy } from './shell.js';

/** What the tool loop needs: connector tools plus Coco's built-in ones, behind one interface. */
export interface ToolSource {
  tools(): ToolInfo[];
  callTool(qualified: string, args: Record<string, unknown>): Promise<ToolResult>;
  ensureConnected(serverId: string): Promise<unknown>;
  /** Per-call policy for built-in tools whose safety depends on the arguments (terminal command, Claude task). */
  policyFor?(qualified: string, args: Record<string, unknown>): ShellPolicy | undefined;
}

/** A Coco built-in tool (terminal, Claude Code hand-off): always available, decides per call. */
export interface BuiltinTool {
  readonly info: ToolInfo;
  policy(args: Record<string, unknown>): ShellPolicy;
  call(args: Record<string, unknown>): Promise<ToolResult>;
}

export class CompositeToolSource implements ToolSource {
  private readonly builtins: BuiltinTool[];

  constructor(
    private readonly manager: Pick<ConnectorManager, 'tools' | 'callTool' | 'ensureConnected'>,
    ...builtins: (BuiltinTool | undefined)[]
  ) {
    this.builtins = builtins.filter((b): b is BuiltinTool => b !== undefined);
  }

  private builtin(qualified: string): BuiltinTool | undefined {
    return this.builtins.find((b) => b.info.qualified === qualified);
  }

  tools(): ToolInfo[] {
    return [...this.manager.tools(), ...this.builtins.map((b) => b.info)];
  }

  callTool(qualified: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.builtin(qualified)?.call(args) ?? this.manager.callTool(qualified, args);
  }

  async ensureConnected(serverId: string): Promise<unknown> {
    if (this.builtins.some((b) => b.info.serverId === serverId)) return undefined;
    return this.manager.ensureConnected(serverId);
  }

  policyFor(qualified: string, args: Record<string, unknown>): ShellPolicy | undefined {
    return this.builtin(qualified)?.policy(args);
  }
}
