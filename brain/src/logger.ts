export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

type Level = 'info' | 'warn' | 'error';

export function createLogger(write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Logger {
  const emit = (level: Level) => (event: string, data: Record<string, unknown> = {}) =>
    write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }));
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

const noop = () => undefined;
export const silentLogger: Logger = { info: noop, warn: noop, error: noop };
