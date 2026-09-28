import { describe, expect, it } from 'vitest';
import { KeychainSecretStore, MemorySecretStore, secretKey, type SecurityRunner } from '../../src/connectors/secrets.js';

function recorder(result: { code: number; stdout: string } = { code: 0, stdout: '' }) {
  const calls: { args: string[]; stdin: string | undefined }[] = [];
  const run: SecurityRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    return result;
  };
  return { run, calls };
}

describe('KeychainSecretStore', () => {
  it('writes via `security -i` with the secret on stdin, never in argv', async () => {
    const r = recorder();
    await new KeychainSecretStore(r.run).set(secretKey('bifrost', 'Authorization'), 'Bearer sk-"x"\\y');
    expect(r.calls[0]!.args).toEqual(['-i']);
    expect(r.calls[0]!.args.join(' ')).not.toContain('sk-');
    expect(r.calls[0]!.stdin).toBe('add-generic-password -U -a coco -s "coco.connector.bifrost.Authorization" -w "Bearer sk-\\"x\\"\\\\y"\n');
  });

  it('reads with find-generic-password -w and trims the trailing newline', async () => {
    const r = recorder({ code: 0, stdout: 'value\n' });
    expect(await new KeychainSecretStore(r.run).get(secretKey('qmd', 'TOKEN'))).toBe('value');
    expect(r.calls[0]!.args).toEqual(['find-generic-password', '-a', 'coco', '-s', 'coco.connector.qmd.TOKEN', '-w']);
  });

  it('returns undefined when the item does not exist (exit 44)', async () => {
    expect(await new KeychainSecretStore(recorder({ code: 44, stdout: '' }).run).get(secretKey('qmd', 'T'))).toBeUndefined();
  });

  it('rejects bad keys and multi-line values', async () => {
    const s = new KeychainSecretStore(recorder().run);
    await expect(s.set('login.keychain.password', 'x')).rejects.toThrow();
    await expect(s.set(secretKey('qmd', 'T'), 'a\nb')).rejects.toThrow();
  });

  it('ignores "not found" on delete', async () => {
    await expect(new KeychainSecretStore(recorder({ code: 44, stdout: '' }).run).delete(secretKey('qmd', 'T'))).resolves.toBeUndefined();
  });
});

describe('MemorySecretStore', () => {
  it('round-trips', async () => {
    const m = new MemorySecretStore();
    await m.set(secretKey('a', 'B'), 'v');
    expect(await m.get(secretKey('a', 'B'))).toBe('v');
    await m.delete(secretKey('a', 'B'));
    expect(await m.get(secretKey('a', 'B'))).toBeUndefined();
  });
});
