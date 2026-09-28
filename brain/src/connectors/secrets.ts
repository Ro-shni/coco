import { spawn } from 'node:child_process';

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const secretKey = (serverId: string, name: string): string => `coco.connector.${serverId}.${name}`;

export type SecurityRunner = (args: string[], stdin: string | undefined) => Promise<{ code: number; stdout: string }>;

const KEY = /^coco\.connector\.[a-z0-9-]+\.[A-Za-z0-9_.-]+$/;
const NOT_FOUND = 44;
const ACCOUNT = 'coco';

export const runSecurity: (args: string[], stdin: string | undefined, executable?: string) => Promise<{ code: number; stdout: string }> = (args, stdin, executable = '/usr/bin/security') =>
  new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: { resolve: { code: number; stdout: string } } | { reject: Error }) => {
      if (settled) return;
      settled = true;
      if ('resolve' in outcome) {
        resolve(outcome.resolve);
      } else {
        reject(outcome.reject);
      }
    };

    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.on('error', (err) => settle({ reject: err as Error }));
    child.stdin.on('error', (err) => settle({ reject: err as Error }));
    child.on('close', (code) => settle({ resolve: { code: code ?? 1, stdout } }));
    child.stdin.end(stdin ?? '');
  });

const defaultRunner: SecurityRunner = (args, stdin) => runSecurity(args, stdin);

function checkKey(key: string): void {
  if (!KEY.test(key)) throw new Error('invalid secret key');
}

const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class KeychainSecretStore implements SecretStore {
  constructor(private readonly run: SecurityRunner = defaultRunner) {}

  async get(key: string): Promise<string | undefined> {
    checkKey(key);
    const r = await this.run(['find-generic-password', '-a', ACCOUNT, '-s', key, '-w'], undefined);
    if (r.code === NOT_FOUND) return undefined;
    if (r.code !== 0) throw new Error(`keychain read failed (${r.code})`);
    return r.stdout.replace(/\n$/, '');
  }

  async set(key: string, value: string): Promise<void> {
    checkKey(key);
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('secret values must be single-line');
    const r = await this.run(['-i'], `add-generic-password -U -a ${ACCOUNT} -s ${quote(key)} -w ${quote(value)}\n`);
    if (r.code !== 0) throw new Error(`keychain write failed (${r.code})`);
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    const r = await this.run(['delete-generic-password', '-a', ACCOUNT, '-s', key], undefined);
    if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`keychain delete failed (${r.code})`);
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  async get(key: string) { checkKey(key); return this.map.get(key); }
  async set(key: string, value: string) { checkKey(key); this.map.set(key, value); }
  async delete(key: string) { checkKey(key); this.map.delete(key); }
}
