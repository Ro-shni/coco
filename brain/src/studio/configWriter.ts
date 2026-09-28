import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

/** Appends dir to connectors.scanDirs in the user's config.yaml, preserving comments; no duplicates. */
export function appendScanDir(configPath: string, dir: string): void {
  const doc = parseDocument(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');
  const current = (doc.getIn(['connectors', 'scanDirs']) as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? [];
  const list = Array.isArray(current) ? current.filter((x): x is string => typeof x === 'string') : [];
  if (list.includes(dir)) return;
  doc.setIn(['connectors', 'scanDirs'], [...list, dir]);
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, doc.toString());
  renameSync(tmp, configPath);
}
