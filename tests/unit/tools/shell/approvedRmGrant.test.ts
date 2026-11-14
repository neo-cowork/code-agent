import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const logs = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../../src/host/services/infra/logger', () => ({ createLogger: () => logs }));

import { getPermissionModeManager, resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';
import { getPolicyEnforcer, resetPolicyEnforcer } from '../../../../src/host/security/policyEnforcer';
import { resolveCanonicalRunPath } from '../../../../src/host/runtime/runContext';
import { approvedSingleFileRmGrantForToolApproval } from '../../../../src/host/tools/shell/approvedRmGrant';

type Input = Parameters<typeof approvedSingleFileRmGrantForToolApproval>[0];

describe('approved rm production approval boundary', () => {
  let cwd: string;
  let files: string[];
  let input: Input;
  const originalEvalRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;

  beforeEach(() => {
    delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
    resetPermissionModeManager();
    resetPolicyEngine();
    getPermissionModeManager().setMode('default', true);
    getPermissionModeManager().setSessionMode('approved-rm-public-entry', 'default', true);
    cwd = resolveCanonicalRunPath(mkdtempSync(join(tmpdir(), 'approved-rm-entry-')));
    files = Array.from({ length: 9 }, (_, i) => join(cwd, `cache-${i}.tmp`));
    files.forEach((file) => writeFileSync(file, 'keep unless approved'));
    input = {
      approvalSource: 'user', toolName: 'Bash', params: { command: `rm -f -- '${files[0]}' '${files[1]}'` },
      permissionRequest: { tool: 'Bash', type: 'command', details: { sandbox: { applied: true } } },
      sessionId: 'approved-rm-public-entry', context: {}, workingDirectory: cwd, policyEnforcer: null,
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetPermissionModeManager();
    resetPolicyEngine();
    resetPolicyEnforcer();
    rmSync(cwd, { recursive: true, force: true });
    if (originalEvalRoot === undefined) delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
    else process.env.CODE_AGENT_EVAL_REAL_ROOT = originalEvalRoot;
  });

  it('mints both literal files through user approval, with the report status suffix', () => {
    input.params.command += '; echo "rm_exit=$?"';
    expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(files.slice(0, 2));
    expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('APPROVED_RM_GRANT_MINTED'));
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('mints both literal files for explicitly approved attended background Bash', () => {
    input.params.run_in_background = true;
    expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(files.slice(0, 2));
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('substitutes static assignments around read-only probes at the approval entry', () => {
    input.params.command = `F1="${files[0]}"; F2="${files[1]}"
      test -f "$F1" && echo "before $F1"; [ -f "$F2" ] && ls -l "$F2"
      stat "$F1"; rm -f -- "$F1" "${'${F2}'}"; printf "rm_exit=%s" "$?"
      test ! -e "$F1" && echo done`;
    expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(files.slice(0, 2));
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it.each(['ls cache-0.tmp', 'stat cache-0.tmp; echo done', 'printf "%s" rm', 'test -f cache-0.tmp'])(
    'does not log an rm refusal for approved non-rm %s', command => {
      input.params.command = command;
      expect(approvedSingleFileRmGrantForToolApproval(input)).toBeUndefined();
      expect(logs.warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['F1="$(printf cache-0.tmp)"; rm "$F1"', 'expansion'],
    ['F1="$HOME/cache-0.tmp"; rm "$F1"', 'assignment_value'],
    ['F1="cache-0.tmp"; F2="$F1"; rm "$F2"', 'assignment_value'],
    ['F1="cache-0.tmp"; rm $F1', 'expansion'],
    ['PATH="/tmp"; rm cache-0.tmp', 'assignment_control'],
    ['F1="cache-0.tmp"; echo done; F1="cache-1.tmp"; rm "$F1"', 'assignment_position'],
    ['F1="cache-0.tmp"; printf -v F1 "%s" cache-1.tmp; rm "$F1"', 'command_shape'],
    ['F1="cache-0.tmp"; printf "%n" F1; rm "$F1"', 'command_shape'],
    ['F1="*.tmp"; rm "$F1"', 'assignment_value'],
    ['for f in *.tmp; do echo "$f"; done; rm cache-0.tmp', 'command_shape'],
  ])('refuses unsafe assignment/probe script %s', (command, reason) => {
    input.params.command = command;
    refused(reason);
  });

  it('accepts eight operands and preserves the one-file grant', () => {
    input.params.command = `rm -- ${files.slice(0, 8).map(file => `'${file}'`).join(' ')}`;
    expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(files.slice(0, 8));
    input.params.command = `rm '${files[0]}'`;
    expect(approvedSingleFileRmGrantForToolApproval(input)).toBe(files[0]);
  });

  function refused(reason: string): void {
    expect(approvedSingleFileRmGrantForToolApproval(input)).toBeUndefined();
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining(reason));
    expect(files.every(file => existsSync(file))).toBe(true);
  }

  it.each([
    ['rm *.tmp', 'literal_operand'],
    ['rm cache-[01].tmp', 'literal_operand'],
    ['rm -rf cache-0.tmp', 'option'],
    ['rm cache-0.tmp > output', 'command_shape'],
    ['rm cache-0.tmp; rm cache-1.tmp', 'command_shape'],
    ['rm cache-0.tmp &', 'command_shape'],
    ['rm cache-0.tmp; touch other', 'command_shape'],
  ])('refuses %s atomically', (command, reason) => {
    input.params.command = command;
    refused(reason);
  });

  it('refuses nine existing operands atomically', () => {
    input.params.command = `rm -- ${files.map(file => `'${file}'`).join(' ')}`;
    refused('operand_count');
  });

  it.each(['directory', 'symlink', 'missing'])('refuses a %s operand after an eligible file atomically', shape => {
    const other = join(cwd, 'other');
    if (shape === 'directory') mkdirSync(other);
    if (shape === 'symlink') symlinkSync(files[1], other);
    input.params.command = `rm -- '${files[0]}' '${other}'`;
    refused('path_class:operand_2');
  });

  it('checks the bound filesystem policy for every operand', () => {
    writeFileSync(join(cwd, 'code-agent-policy.toml'), `[filesystem]\nwritable_paths = ["./**"]\ndenied_paths = ["${files[1]}"]\n`);
    input.policyEnforcer = getPolicyEnforcer(cwd);
    expect(input.policyEnforcer?.isActive).toBe(true);
    refused('path_policy:operand_2');
  });

  it('checks user path denies for every operand', () => {
    getPolicyEngine().loadUserRules({ deny: [`Edit(${files[1]})`] }, 'user-ui');
    refused('path_policy:operand_2');
  });

  it.each(['unattended_background', 'pty', 'unattended', 'write_fence', 'mode', 'sandboxed', 'aborted', 'eval_real_root', 'policy_unbound', 'approval_source'])(
    'keeps %s refused with exactly one reason log', condition => {
      if (condition === 'unattended_background') {
        input.params.run_in_background = true;
        getPermissionModeManager().markUnattendedSession('approved-rm-public-entry');
      }
      if (condition === 'pty') input.params.pty = true;
      if (condition === 'unattended') getPermissionModeManager().markUnattendedSession('approved-rm-public-entry');
      if (condition === 'write_fence') input.context.requiresOsWriteFence = true;
      if (condition === 'mode') getPermissionModeManager().setSessionMode('approved-rm-public-entry', 'bypassPermissions', true);
      if (condition === 'sandboxed') input.permissionRequest.details.sandbox = { applied: false };
      if (condition === 'aborted') input.abortSignal = AbortSignal.abort();
      if (condition === 'eval_real_root') process.env.CODE_AGENT_EVAL_REAL_ROOT = cwd;
      if (condition === 'policy_unbound') input.policyEnforcer = undefined;
      if (condition === 'approval_source') input.approvalSource = 'dev-auto-approve';
      refused(condition === 'unattended_background' ? 'unattended' : condition);
    },
  );
});
