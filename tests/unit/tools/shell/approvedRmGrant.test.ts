import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const logs = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../../src/host/services/infra/logger', () => ({ createLogger: () => logs }));

import { getPermissionModeManager, resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';
import { getPolicyEnforcer, resetPolicyEnforcer } from '../../../../src/host/security/policyEnforcer';
import { resolveCanonicalRunPath } from '../../../../src/host/runtime/runContext';
import { approvedSingleFileRmGrantForToolApproval } from '../../../../src/host/tools/shell/approvedRmGrant';
import { isApprovedRmVerifyProbe } from '../../../../src/host/tools/shell/approvedRmVerifyProbe';

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

  it.each([
    `rm -v -- F0 F1; printf 'exit=%s\\n' "$?"`,
    `rm -v -- F0 F1; printf 'exit=%s\\\\n' "$?"`,
    `rm -v -- F0 F1; printf 'rm_exit=%s' "$?"`,
  ])('mints both files with the printf exit-status suffix %#', (command) => {
    input.params.command = command.replace('F0', `'${files[0]}'`).replace('F1', `'${files[1]}'`);
    expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(files.slice(0, 2));
    expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('APPROVED_RM_GRANT_MINTED'));
    expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('"conditions":[]'));
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it.each([
    [`rm -v -- F0 F1; printf 'exit=%s\\n' "$?" > report.txt`, 'redirect_non_dup'],
    [`rm -v -- F0 F1; printf "$(date) exit=%s" "$?"`, 'expansion'],
    [`rm -v -- F0 F1; printf 'exit=%s\\n' "$?" stale`, 'command_shape'],
    [`rm -v -- F0 F1; printf 'exit=%s\\n' "$?" "${'${?}'}"`, 'command_shape'],
    [`rm -v -- F0 F1; printf -v state 'exit=%s\\n'`, 'command_shape'],
    [`rm -v -- F0 F1; printf '%n'`, 'command_shape'],
    [`rm -v -- F0 F1; printf '%5n'`, 'command_shape'],
    [`rm -v -- F0 F1; printf '%ln'`, 'command_shape'],
  ])('refuses the unsafe printf suffix %#', (command, reason) => {
    input.params.command = command.replace('F0', `'${files[0]}'`).replace('F1', `'${files[1]}'`);
    refused(reason);
  });

  it.each([
    ['rm -v cache-0.tmp', 1],
    ['rm --verbose -- cache-0.tmp', 1],
    ['rm -f -v cache-0.tmp cache-1.tmp', 2],
  ])('treats verbose output flags like -f: %s', (command, count) => {
    input.params.command = command;
    expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(count === 1 ? files[0] : files.slice(0, count));
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

  it.each([';', '&&', '||', '\n'])('mints absolute multi-rm files joined by %s, with descriptor duplication', separator => {
    input.params.command = `rm -f -- "${files[0]}" 2>&1 ${separator} rm -f -- "${files[1]}"; echo "exit=$?" 2>&1`;
    expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(files.slice(0, 2));
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('counts canonical distinct files across rm segments, not repeated operands', () => {
    input.params.command = `rm -f -- ${files.slice(0, 8).map(file => `'${file}'`).join(' ')}; rm -f -- '${files[0]}'`;
    expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(files.slice(0, 8));
  });

  it.each(['2>/tmp/x', '>file', '&>file', '>>file', '<file', '>|file', '>&-', '1>&2', '12>&1', '02>&1', '2>&10', '2>&-','2 >&1', '2>&1file', '<<EOF\nx\nEOF'])(
    'refuses redirect %s with redirect_non_dup', redirect => {
      input.params.command = `rm -- "${files[0]}" ${redirect}`;
      refused('redirect_non_dup');
    },
  );

  it.each(['cd /x', 'pushd /x', 'popd'])(
    'refuses cwd mutation %s across the whole approval', mutation => {
      input.params.command = `${mutation}; rm -f -- a`;
      refused('multi_rm_cwd_change');
    },
  );

  it.each(['mv', 'cp', 'ln', 'touch'])(
    'refuses filesystem mutation %s across the whole approval', mutation => {
      input.params.command = `${mutation} '${files[0]}' '${files[2]}'; rm -f -- '${files[1]}'`;
      refused('filesystem_change');
    },
  );

  it('refuses nine distinct absolute operands across two rm segments atomically', () => {
    input.params.command = `rm -f -- ${files.slice(0, 5).map(file => `'${file}'`).join(' ')}; rm -f -- ${files.slice(5).map(file => `'${file}'`).join(' ')}`;
    refused('operand_count>8');
  });

  it('refuses a directory in the second rm without granting the first file', () => {
    const directory = join(cwd, 'directory'); mkdirSync(directory);
    input.params.command = `rm -f -- '${files[0]}'; rm -f -- '${directory}'`;
    refused('operand_not_regular_file');
  });

  it('refuses policy denial in the second rm and leaves the first file untouched', () => {
    getPolicyEngine().loadUserRules({ deny: [`Edit(${files[1]})`] }, 'user-ui');
    input.params.command = `rm -f -- '${files[0]}'; rm -f -- '${files[1]}'`;
    refused('policy_denied');
    expect(existsSync(files[0])).toBe(true);
  });

  it.each([
    ['rm -f -- "ABS"; rm -f -- /tmp/*.tmp', 'literal_operand'],
    ['rm -f -- "ABS"; rm -f -- "$(printf /tmp/x)"', 'expansion'],
    ['rm -f -- "ABS"; rm -r -- /tmp/x', 'option'],
    ['rm -f -- "ABS"; rm -d -- /tmp/x', 'option'],
    ['rm -f -- "ABS"; rm -f -- ~/x', 'operand_not_absolute_literal'],
    ['F1="ABS"; rm -f -- "ABS"; rm -f -- "$F1"', 'operand_not_absolute_literal'],
  ])('refuses unsafe multi-rm %s', (command, reason) => {
    input.params.command = command.replaceAll('ABS', files[0]);
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
    ['rm -i cache-0.tmp', 'option'],
    ['rm -rv cache-0.tmp', 'option'],
    ['rm -fv cache-0.tmp', 'option'],
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
  describe('literal-path for loop around rm', () => {
    const loop = (body: string, items = `${'${F0}'} ${'${F1}'}`) => {
      input.params.command = `for f in ${items.replace('${F0}', `'${files[0]}'`).replace('${F1}', `"${files[1]}"`)}; do\n${body}\ndone`;
    };

    it.each([
      'if rm -- "$f"; then echo "removed $f"; else echo "FAILED exit=$?"; fi',
      'echo "--- rm: $f"; rm -f -v -- "$f"; printf "rm_exit=%s" "$?"',
      'rm "$f"',
    ])('mints exactly the two literal files for body %#', (body) => {
      loop(body);
      expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(files.slice(0, 2));
      expect(logs.warn).not.toHaveBeenCalled();
      expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('APPROVED_RM_GRANT_MINTED'));
    });

    it.each([
      ['rm -r "$f"', 'option'],
      ['rm -rf "$f"', 'option'],
      ['rm "$f" "${f}.bak"', 'literal_operand'],
      ['rm "${f}.bak"', 'literal_operand'],
      ['rm $f', 'expansion'],
      ['rm "$g"', 'literal_operand'],
      ['rm "$f"; touch "$f"', 'command_shape'],
      ['rm "$f"; cat "$f"', 'command_shape'],
      ['rm "$f" > out.txt', 'command_shape'],
    ])('refuses body %s with reason and a log line', (body, reason) => {
      loop(body);
      expect(approvedSingleFileRmGrantForToolApproval(input)).toBeUndefined();
      expect(logs.warn).toHaveBeenCalledTimes(1);
      expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining(reason));
      expect(files.every(file => existsSync(file))).toBe(true);
    });

    it.each([
      ['/tmp/*.tmp'], ['relative.tmp'], ['"/tmp/a b.tmp"'], ['~/x.tmp'], ['$HOME/x.tmp'],
    ])('refuses non-literal loop item %s', (item) => {
      loop('rm "$f"', item);
      expect(approvedSingleFileRmGrantForToolApproval(input)).toBeUndefined();
      expect(logs.warn).toHaveBeenCalledTimes(1);
      expect(logs.warn).toHaveBeenCalledWith(expect.stringMatching(/loop_item|expansion/));
    });

    it('refuses a loop whose body has no rm, without claiming an rm refusal', () => {
      loop('echo "$f"');
      expect(approvedSingleFileRmGrantForToolApproval(input)).toBeUndefined();
      expect(logs.warn).not.toHaveBeenCalled();
    });
  });

  describe('post-delete existence check of exactly the approved files', () => {
    const SESSION = 'approved-rm-public-entry';
    const approveDelete = (command = `rm -v -- '${files[0]}' '${files[1]}'`) => {
      input.params.command = command;
      expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(files.slice(0, 2));
    };

    it.each([
      (f: string[]) => `test ! -e "${f[0]}" && echo gone`,
      (f: string[]) => `[ -e "${f[0]}" ] && echo STILL || echo GONE; ls -l ${f[1]} 2>&1; echo "exit=$?"`,
      (f: string[]) => `stat "${f[0]}"; test -f ${f[1]}`,
      (f: string[]) => `for p in ${f[0]} "${f[1]}"; do\n  if [ -e "$p" ]; then echo "STILL: $p"; ls -l "$p"; else echo "GONE: $p"; fi\ndone`,
      (f: string[]) => `for p in ${f[0]} "${f[1]}"; do if [ -e "$p" ]; then echo "STILL PRESENT: $p"; else echo "GONE: $p"; fi; done`,
    ])('answers %# without a card after the approved delete', (build) => {
      approveDelete();
      expect(isApprovedRmVerifyProbe(build(files), cwd, SESSION)).toBe(true);
      expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('APPROVED_RM_VERIFY_EXEMPTION'));
    });

    it('answers the literal-path for loop without a card after the printf-suffix mint', () => {
      approveDelete(`rm -v -- '${files[0]}' '${files[1]}'; printf 'exit=%s\\n' "$?"`);
      const probe = `for p in '${files[0]}' '${files[1]}'; do\n  if [ -e "$p" ]; then echo "STILL: $p"; ls -l "$p"; else echo "GONE: $p"; fi\ndone`;
      expect(isApprovedRmVerifyProbe(probe, cwd, SESSION)).toBe(true);
      expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('APPROVED_RM_VERIFY_EXEMPTION'));
    });

    it.each([
      (f: string[]) => `for p in ${f[0]} ${f[2]}; do test -e "$p"; done`,
      (_f: string[]) => `for p in ${join(cwd, '*.tmp')}; do test -e "$p"; done`,
      (_f: string[]) => 'for p in "$x"; do test -e "$p"; done',
      (f: string[]) => `for p in ${f[0]} ${f[1]}; do rm "$p"; done`,
    ])('keeps asking %#: unapproved path, glob, expansion, non-read-only body', (build) => {
      approveDelete(`rm -v -- '${files[0]}' '${files[1]}'; printf 'exit=%s\\n' "$?"`);
      expect(isApprovedRmVerifyProbe(build(files), cwd, SESSION)).toBe(false);
    });

    it.each([
      (f: string[]) => `ls -l ${f[2]}`,
      (f: string[]) => `test -e "${f[0]}" && cat "${f[0]}"`,
      (f: string[]) => `ls ${f[0]} > ${f[1]}`,
      (f: string[]) => `ls ${f[0]} $(printf x)`,
      (f: string[]) => `for p in ${f[0]}; do rm "$p"; done`,
      (f: string[]) => `for p in ${f[0]} ${f[2]}; do test -e "$p"; done`,
      (f: string[]) => `for p in ${f[0]}; do test -e "$q"; done`,
      (f: string[]) => `for p in ${f[0]}; do ls "$p" "$other"; done`,
      (f: string[]) => `while true; do test -e ${f[0]}; done`,
      (f: string[]) => `for p in ${f[0]}; do test -e "$p"; done < /etc/passwd`,
      (_f: string[]) => `ls ${join(cwd, '*.tmp')}`,
      (_f: string[]) => 'echo done',
    ])('keeps asking for %#: unrelated path, other program, redirect, expansion, loop, glob', (build) => {
      approveDelete();
      expect(isApprovedRmVerifyProbe(build(files), cwd, SESSION)).toBe(false);
    });

    it('a path not on the approved card is not covered: a probe on c alone or on a+c still asks', () => {
      approveDelete();
      expect(isApprovedRmVerifyProbe(`test -e ${files[2]}`, cwd, SESSION)).toBe(false);
      expect(isApprovedRmVerifyProbe(`ls -l ${files[0]} ${files[2]}`, cwd, SESSION)).toBe(false);
      expect(isApprovedRmVerifyProbe(`for p in ${files[0]} ${files[1]}; do test -e "$p"; done; ls -l ${files[2]}`, cwd, SESSION)).toBe(false);
    });

    it('does not answer for another session, before any approval, or after the window', () => {
      expect(isApprovedRmVerifyProbe(`test -e ${files[0]}`, cwd, SESSION)).toBe(false);
      approveDelete();
      expect(isApprovedRmVerifyProbe(`test -e ${files[0]}`, cwd, 'another-session')).toBe(false);
      expect(isApprovedRmVerifyProbe(`test -e ${files[0]}`, cwd, SESSION, Date.now() + 6 * 60 * 1000)).toBe(false);
    });

    it('does not loop over an approved path that word-splits (space) onto another path', () => {
      const spaced = join(cwd, 'cache dir.tmp');
      writeFileSync(spaced, 'x');
      input.params.command = `rm -- '${spaced}'`;
      expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(spaced);
      expect(isApprovedRmVerifyProbe(`for p in "${spaced}"; do ls -la $p; done`, cwd, SESSION)).toBe(false);
      expect(isApprovedRmVerifyProbe(`ls -la "${spaced}"`, cwd, SESSION)).toBe(true);
    });

    it('does not treat ~ or .. spellings as the approved file (bash reads a different path)', () => {
      const homeFile = join(homedir(), `approved-rm-tilde-${process.pid}.tmp`);
      writeFileSync(homeFile, 'x');
      try {
        input.params.command = `rm -- '${homeFile}'`;
        expect(approvedSingleFileRmGrantForToolApproval(input)).toEqual(homeFile);
        const name = homeFile.slice(homedir().length + 1);
        expect(isApprovedRmVerifyProbe(`test -e ${homeFile}`, cwd, SESSION)).toBe(true);
        expect(isApprovedRmVerifyProbe(`if [ -e "~/${name}" ]; then echo STILL; else echo GONE; fi`, cwd, SESSION)).toBe(false);
        expect(isApprovedRmVerifyProbe(`for p in "~/${name}"; do ls -l "$p"; done`, cwd, SESSION)).toBe(false);
        expect(isApprovedRmVerifyProbe(`ls ~/${name}`, cwd, SESSION)).toBe(false);
        expect(isApprovedRmVerifyProbe(`[ -e /tmp/../${homeFile.slice(1)} ]`, cwd, SESSION)).toBe(false);
      } finally { rmSync(homeFile, { force: true }); }
    });

    it('does not remember files when the approval is refused', () => {
      input.params.command = `rm -rf ${files[0]}`;
      expect(approvedSingleFileRmGrantForToolApproval(input)).toBeUndefined();
      expect(isApprovedRmVerifyProbe(`test -e ${files[0]}`, cwd, SESSION)).toBe(false);
    });
  });
});
