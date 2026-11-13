import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { assertIsolatedVerificationDir, assertNoLoginSession } from '../../scripts/lib/verificationIsolation';
import { seedVerificationModels } from '../../scripts/lib/verificationModelSeed';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-isolation-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('verification isolation shared by sibling runners', () => {
  it('rejects live resident paths, including symlinks, and requires an explicit target', () => {
    expect(() => assertIsolatedVerificationDir(undefined)).toThrow(/explicit isolated/);
    for (const name of ['.code-agent', '.code-agent-dev', '.code-agent-dev7', '.code-agent-chatprobe']) {
      expect(() => assertIsolatedVerificationDir(path.join(os.homedir(), name))).toThrow(/live data directory/);
    }
    const dir = temp();
    symlinkSync(os.homedir(), path.join(dir, 'home'));
    expect(() => assertIsolatedVerificationDir(path.join(dir, 'home', '.code-agent-dev'))).toThrow(/live data directory/);
    expect(assertIsolatedVerificationDir(dir)).toBeTruthy();
  });

  it('rejects a live data directory that does not exist yet, reached through a symlink', () => {
    const neverCreated = '.code-agent-dev987654321';
    expect(existsSync(path.join(os.homedir(), neverCreated))).toBe(false);
    expect(() => assertIsolatedVerificationDir(path.join(os.homedir(), neverCreated))).toThrow(/live data directory/);
    const dir = temp();
    symlinkSync(os.homedir(), path.join(dir, 'home'));
    expect(() => assertIsolatedVerificationDir(path.join(dir, 'home', neverCreated))).toThrow(/live data directory/);
    symlinkSync(path.join(os.homedir(), neverCreated), path.join(dir, 'direct'));
    expect(() => assertIsolatedVerificationDir(path.join(dir, 'direct'))).toThrow(/live data directory/);
    symlinkSync(path.join('home', neverCreated), path.join(dir, 'chained'));
    expect(() => assertIsolatedVerificationDir(path.join(dir, 'chained'))).toThrow(/live data directory/);
    symlinkSync('loop', path.join(dir, 'loop'));
    expect(() => assertIsolatedVerificationDir(path.join(dir, 'loop'))).toThrow(/symlink loop/);
    expect(assertIsolatedVerificationDir(path.join(dir, 'fresh', 'data'))).toBe(path.join(realpathSync(dir), 'fresh', 'data'));
  });

  it('fails closed on a dangling secure-store link', () => {
    const dir = temp();
    symlinkSync(path.join(dir, 'absent'), path.join(dir, 'secure-storage.json'));
    expect(() => assertNoLoginSession(dir)).toThrow(/login session/);
  });

  it('seeds model config through the selective reader without copying auth, approval, OAuth or the encryption pair', async () => {
    const source = temp(), target = temp();
    const secret = randomBytes(32).toString('hex');
    writeFileSync(path.join(source, '.secure-key'), secret, { mode: 0o600 });
    writeFileSync(path.join(source, 'config.json'), JSON.stringify({ models: { providers: { test: { enabled: true } } } }));
    const key = createHash('sha256').update(secret).digest();
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({
      'apikey.test': 'fixture-model-key', 'auth.user': 'forbidden-identity',
      'supabase.session': 'forbidden-session', 'sb-test-auth-token': 'forbidden-session',
      'settings.devModeAutoApprove': 'forbidden-approval', 'mcp-oauth:test': 'forbidden-oauth',
    })), cipher.final()]);
    writeFileSync(path.join(source, 'secure-storage.json'), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
    const before = readFileSync(path.join(source, 'secure-storage.json'), 'utf8');
    await seedVerificationModels(source, target);
    const config = readFileSync(path.join(target, 'config.json'), 'utf8');
    expect(JSON.parse(config).models.providers.test.apiKey).toBe('fixture-model-key');
    expect(config).not.toContain('forbidden');
    for (const file of ['secure-storage.json', '.secure-key']) expect(existsSync(path.join(target, file))).toBe(false);
    expect(readFileSync(path.join(source, 'secure-storage.json'), 'utf8')).toBe(before);
  });
});
