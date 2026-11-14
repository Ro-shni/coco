import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isMap, parseDocument } from 'yaml';

const DEFAULT_MODE = 0o600;

/** Appends dir to connectors.scanDirs in the user's config.yaml, preserving comments; no duplicates. */
export function appendScanDir(configPath: string, dir: string): void {
  const exists = existsSync(configPath);
  const doc = parseDocument(exists ? readFileSync(configPath, 'utf8') : '');
  // M9: a scalar or null `connectors:` (e.g. `connectors: null`) can't hold `scanDirs` — yaml's setIn throws
  // "Expected YAML collection" in that case. Drop it so setIn can (re)build it as a map.
  if (doc.has('connectors') && !isMap(doc.get('connectors', true))) doc.delete('connectors');
  const current = (doc.getIn(['connectors', 'scanDirs']) as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? [];
  const list = Array.isArray(current) ? current.filter((x): x is string => typeof x === 'string') : [];
  if (list.includes(dir)) return;
  doc.setIn(['connectors', 'scanDirs'], [...list, dir]);
  // M9: preserve the existing file's permission bits rather than falling back to the process umask.
  const mode = exists ? statSync(configPath).mode & 0o777 : DEFAULT_MODE;
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, doc.toString(), { mode });
  renameSync(tmp, configPath);
}
