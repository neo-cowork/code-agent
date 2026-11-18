import { describe, expect, it } from 'vitest';
import { trimIdentifierArgs } from '../../../src/host/tools/trimIdentifierArgs';

describe('trimIdentifierArgs', () => {
  it('trims top-level path-like keys and command only; bodies, nested values, non-path keys untouched', () => {
    const args = {
      file_path: '\n/tmp/a.txt ', outputPath: ' out.md\n', command: '  ls\n',
      content: '  body\n', old_string: ' o ', new_string: ' n ',
      target: 'screen ', axPath: ' 0/1 ', nested: { file_path: ' keep ' },
    };
    expect(trimIdentifierArgs(args, { includeCommand: true })).toEqual({
      file_path: '/tmp/a.txt', outputPath: 'out.md', command: 'ls',
      content: '  body\n', old_string: ' o ', new_string: ' n ',
      target: 'screen ', axPath: ' 0/1 ', nested: { file_path: ' keep ' },
    });
  });

  it('leaves command byte-exact when includeCommand is false', () => {
    expect(trimIdentifierArgs({ command: 'x ', path: ' p ' }, { includeCommand: false })).toEqual({ command: 'x ', path: 'p' });
  });
});
