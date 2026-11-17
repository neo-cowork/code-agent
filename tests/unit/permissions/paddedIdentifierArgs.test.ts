// cleanXmlResidues returns untagged strings byte-for-byte; identifier consumers must trim themselves.
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { cleanXmlResidues } from '../../../src/host/agent/antiPattern/cleanXml';
import { matchSpecifier, parseToolSpecifier } from '../../../src/host/permissions/specifierParser';
import { classifyCommand } from '../../../src/host/security/commandSafety';
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

  it.each(['allow', 'restrict'] as const)('path rule matches padded path (%s)', (intent) => {
    const rule = parseToolSpecifier('Write(/tmp/a.txt)');
    expect(matchSpecifier(rule, '/tmp/a.txt', intent)).toBe(true);
    expect(matchSpecifier(rule, '\n/tmp/a.txt ', intent)).toBe(true);
  });

  it('classifies padded command like the trimmed one', () => {
    expect(classifyCommand('  ls\n')).toBe(classifyCommand('ls'));
  });

  it('resolveInputPath resolves a padded path like the trimmed one', () => {
    expect(resolveInputPath('\n/tmp/a.txt ', '/work')).toBe('/tmp/a.txt');
    expect(resolveInputPath('  sub/a.txt\n', '/work')).toBe(path.join('/work', 'sub/a.txt'));
  });
});
