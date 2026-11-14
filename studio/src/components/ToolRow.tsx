import type { ToolView } from '../types';
import { PermissionControl } from './PermissionControl';
import { TryIt } from './TryIt';

export function ToolRow({ tool, onChanged }: { tool: ToolView; onChanged: () => void }) {
  return (
    <li className="tool" data-testid={`tool-${tool.name}`}>
      <div className="tool-main">
        <h3 className="tool-name">{tool.name}</h3>
        <p className="muted small tool-desc">{firstLine(tool.description)}</p>
      </div>
      <PermissionControl qualified={tool.qualified} name={tool.name} mode={tool.mode} onChanged={onChanged} />
      <TryIt tool={tool} />
    </li>
  );
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}
