// cleanXmlResidues returns untagged strings byte-for-byte; identifier consumers must trim themselves.
import { describe, expect, it } from 'vitest';
import { cleanXmlResidues } from '../../../src/host/agent/antiPattern/cleanXml';
import { matchSpecifier, parseToolSpecifier } from '../../../src/host/permissions/specifierParser';
import { classifyCommand } from '../../../src/host/security/commandSafety';
import { resolveToolPath } from '../../../src/host/tools/writeTargets';
import { resolveInputPath } from '../../../src/host/tools/utils/resolveInputPath';

describe('padded identifier arguments behave like the trimmed form', () => {
  it('cleanXml: untagged bodies stay byte-exact, tagged strings are cleaned and trimmed', () => {
    expect(cleanXmlResidues('  body\n')).toBe('  body\n');
    expect(cleanXmlResidues('  <arg_value>x\n')).toBe('x');
  });

  it.each(['allow', 'restrict'] as const)('command rule matches padded command (%s)', (intent) => {
    const rule = parseToolSpecifier('Bash(rm -rf /tmp/x)');
    expect(matchSpecifier(rule, 'rm -rf /tmp/x\n', intent)).toBe(matchSpecifier(rule, 'rm -rf /tmp/x', intent));
    expect(matchSpecifier(rule, '  rm -rf /tmp/x\n', intent)).toBe(true);
    const ls = parseToolSpecifier('Bash(ls)');
    expect(matchSpecifier(ls, '  ls\n', intent)).toBe(true);
  });

  it('path rule: deny/ask match the padded spelling, allow never does', () => {
    const rule = parseToolSpecifier('Write(/tmp/a.txt)');
    expect(matchSpecifier(rule, '/tmp/a.txt', 'allow')).toBe(true);
    expect(matchSpecifier(rule, '\n/tmp/a.txt ', 'restrict')).toBe(true);
    expect(matchSpecifier(rule, '\n/tmp/a.txt ', 'allow')).toBe(false);
  });

  it('classifies padded command like the trimmed one', () => {
    expect(classifyCommand('  ls\n')).toBe(classifyCommand('ls'));
  });

  it('executor and authorization side resolve a padded path to the same (literal) target outside the engine', () => {
    for (const padded of ['\n/etc/passwd ', '\n~/.ssh/config ']) {
      expect(resolveInputPath(padded, '/work')).toBe(resolveToolPath(padded, '/work'));
    }
  });
});
