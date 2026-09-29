import { describe, expect, it } from 'vitest';
import { KeychainSecretStore, MemorySecretStore, secretKey, runSecurity, type SecurityRunner } from '../../src/connectors/secrets.js';

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

  it('rejects values with control characters (including tab)', async () => {
    const s = new KeychainSecretStore(recorder().run);
    await expect(s.set(secretKey('qmd', 'T'), 'a\tb')).rejects.toThrow();
    await expect(s.set(secretKey('qmd', 'T'), 'a\x00b')).rejects.toThrow();
    await expect(s.set(secretKey('qmd', 'T'), 'a\x1fb')).rejects.toThrow();
    await expect(s.set(secretKey('qmd', 'T'), 'a\x7fb')).rejects.toThrow(); // DEL
  });

  it('ignores "not found" on delete', async () => {
    await expect(new KeychainSecretStore(recorder({ code: 44, stdout: '' }).run).delete(secretKey('qmd', 'T'))).resolves.toBeUndefined();
  });

  it('survives an early-exiting security process (runSecurity rejects, not throws)', async () => {
    // Test that runSecurity handles EPIPE and other errors by rejecting the promise
    // rather than throwing an unhandled error. Use a nonexistent executable path.
    await expect(runSecurity(['-i'], 'test', '/nonexistent/security')).rejects.toThrow();
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

describe('MemorySecretStore value check', () => {
  it('rejects control characters like the Keychain store', async () => {
    await expect(new MemorySecretStore().set(secretKey('a', 'B'), 'x\ny')).rejects.toThrow();
  });
});
