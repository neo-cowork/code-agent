// N-SANDBOX-DENY-ESCALATE · ai-review Important (PR #2191 round 4):
// the escalation policy check runs after the first command run was denied, so the
// getPolicyEnforcer() singleton may have been rebound by a concurrent session in
// another workspace. The check must use the instance ToolExecutor bound for this call.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCanonicalRunPath } from '../../../../src/host/runtime/runContext';
import { getPolicyEnforcer, resetPolicyEnforcer } from '../../../../src/host/security/policyEnforcer';
import {
  approvedSingleFileRmGrant,
  shouldOfferEscalation,
} from '../../../../src/host/tools/shell/sandboxEscalation';

describe('shouldOfferEscalation uses the enforcer bound for this call', () => {
  const dirs: string[] = [];
  const tmp = (prefix: string): string => {
    const dir = resolveCanonicalRunPath(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    resetPolicyEnforcer();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('still hard-denies denied_paths after another workspace rebinds the singleton to null', () => {
    const projectA = tmp('escalate-race-a-');
    const parent = tmp('escalate-race-target-');
    const denied = join(parent, 'denied.txt');
    writeFileSync(denied, 'x');
    writeFileSync(join(projectA, 'code-agent-policy.toml'), [
      '[filesystem]',
      `writable_paths = ["./**", "${parent}/**"]`,
      `denied_paths = ["${denied}"]`,
      '',
    ].join('\n'));

    resetPolicyEnforcer();
    const boundForA = getPolicyEnforcer(projectA);
    expect(boundForA?.isActive).toBe(true);

    // Session B, no policy file, runs Bash while A's command is still executing.
    expect(getPolicyEnforcer(tmp('escalate-race-b-'))).toBeNull();
    expect(getPolicyEnforcer()).toBeNull();

    const input = {
      sandboxDecision: { sandboxed: true },
      foreground: true,
      pty: false,
      background: false,
      unattended: false,
      writeFence: false,
      evalRealRoot: false,
      permissionMode: 'default' as const,
      abortSignal: new AbortController().signal,
      deniedPath: denied,
      newFileGrantSupported: true,
      workingDirectory: projectA,
    };
    expect(shouldOfferEscalation({ ...input, policyEnforcer: boundForA })).toBeUndefined();
    // The singleton (what the old code read) would have offered the card.
    expect(shouldOfferEscalation({ ...input, policyEnforcer: getPolicyEnforcer() })).toBe(denied);
    // Nobody bound an enforcer: unverified, no card.
    expect(shouldOfferEscalation({ ...input, policyEnforcer: undefined })).toBeUndefined();
  });
});

describe('approvedSingleFileRmGrant stays literal and non-recursive', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('mints only the existing regular file named by one plain rm', () => {
    const cwd = resolveCanonicalRunPath(mkdtempSync(join(tmpdir(), 'approved-rm-grant-')));
    dirs.push(cwd);
    const target = join(cwd, 'target.txt');
    writeFileSync(target, 'x');
    const input = {
      sandboxDecision: { sandboxed: true },
      foreground: true,
      pty: false,
      background: false,
      unattended: false,
      writeFence: false,
      evalRealRoot: false,
      permissionMode: 'default' as const,
      abortSignal: new AbortController().signal,
      newFileGrantSupported: true,
      workingDirectory: cwd,
      policyEnforcer: null,
    };

    expect(approvedSingleFileRmGrant(`rm -- '${target}'`, input)).toBe(target);
    expect(approvedSingleFileRmGrant(`rm -f '${target}'`, input)).toBe(target);
    expect(approvedSingleFileRmGrant(`rm '${join(cwd, 'missing.txt')}'`, input)).toBeUndefined();
  });

  it.each([
    'rm -rf ..',
    'rm -rf ~',
    'rm --recursive target.txt',
    'rm target.txt other.txt',
    'rm target.txt; touch other.txt',
    'rm *.txt',
  ])('does not mint a literal grant for %s', (command) => {
    const cwd = resolveCanonicalRunPath(mkdtempSync(join(tmpdir(), 'approved-rm-refuse-')));
    dirs.push(cwd);
    writeFileSync(join(cwd, 'target.txt'), 'x');
    expect(approvedSingleFileRmGrant(command, {
      sandboxDecision: { sandboxed: true },
      foreground: true,
      pty: false,
      background: false,
      unattended: false,
      writeFence: false,
      evalRealRoot: false,
      permissionMode: 'default',
      abortSignal: new AbortController().signal,
      newFileGrantSupported: true,
      workingDirectory: cwd,
      policyEnforcer: null,
    })).toBeUndefined();
  });


  it.each([
    'rm TARGET; echo "exit=$?"',
    'rm TARGET && echo done',
    'echo before && rm --force TARGET || printf "%s" done; true; :',
    'true; rm -f -- TARGET; echo done; printf "%s" "$?"',
  ])('grants exactly one file for harmless compound %s', (shape) => {
    const cwd = resolveCanonicalRunPath(mkdtempSync('/tmp/approved-rm-compound-'));
    dirs.push(cwd);
    const target = join(cwd, 'target.txt');
    writeFileSync(target, 'x');
    const command = shape.replace('TARGET', `'${target}'`);
    const grant = approvedSingleFileRmGrant(command, {
      sandboxDecision: { sandboxed: true }, foreground: true, pty: false, background: false,
      unattended: false, writeFence: false, evalRealRoot: false, permissionMode: 'default',
      abortSignal: new AbortController().signal, newFileGrantSupported: true,
      workingDirectory: cwd, policyEnforcer: null,
    });
    console.log(`COMPOUND_GRANT command=${command} grant=${String(grant)}`);
    expect(grant).toBe(target);
  });

  it.each([
    'rm a; rm b',
    'rm a; echo x > /tmp/f',
    'rm a | cat',
    'rm a; touch b',
    'rm -rf a; echo $?',
    'rm a;',
    'rm a &&',
    'rm a ||',
    'rm a & echo done',
    'rm a; echo x 2>&1',
    'rm a; echo x < b',
    'rm a < b; echo done',
    'rm a; echo "$(touch b)"',
    'rm a; echo "`touch b`"',
    'rm a; printf -v state x',
    'echo before || rm a',
    'rm a; ./echo done',
  ])('refuses unsafe compound %s and leaves files intact', (command) => {
    const cwd = resolveCanonicalRunPath(mkdtempSync('/tmp/approved-rm-negative-'));
    dirs.push(cwd);
    for (const name of ['a', 'b']) writeFileSync(join(cwd, name), 'keep');
    const grant = approvedSingleFileRmGrant(command, {
      sandboxDecision: { sandboxed: true }, foreground: true, pty: false, background: false,
      unattended: false, writeFence: false, evalRealRoot: false, permissionMode: 'default',
      abortSignal: new AbortController().signal, newFileGrantSupported: true,
      workingDirectory: cwd, policyEnforcer: null,
    });
    console.log(`NEGATIVE_GRANT command=${command} grant=${String(grant)} a.exists=${existsSync(join(cwd, 'a'))} b.exists=${existsSync(join(cwd, 'b'))}`);
    expect(grant).toBeUndefined();
    expect(existsSync(join(cwd, 'a'))).toBe(true);
    expect(existsSync(join(cwd, 'b'))).toBe(true);
  });

  it('does not mint a grant for a symlink target', () => {
    const cwd = resolveCanonicalRunPath(mkdtempSync(join(tmpdir(), 'approved-rm-symlink-')));
    dirs.push(cwd);
    const real = join(cwd, 'real.txt');
    const link = join(cwd, 'link.txt');
    writeFileSync(real, 'x');
    symlinkSync(real, link);
    expect(approvedSingleFileRmGrant(`rm '${link}'`, {
      sandboxDecision: { sandboxed: true },
      foreground: true,
      pty: false,
      background: false,
      unattended: false,
      writeFence: false,
      evalRealRoot: false,
      permissionMode: 'default',
      abortSignal: new AbortController().signal,
      newFileGrantSupported: true,
      workingDirectory: cwd,
      policyEnforcer: null,
    })).toBeUndefined();
  });
});
