import { describe, expect, it } from 'vitest';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const STORAGE_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const storagePath = `/Users/me/.code-agent/uploads/${STORAGE_UUID}/notes.txt`;

describe('humanizeToolStep — UUID storage directory', () => {
  it('read row shows only the file name in zh and en', () => {
    const zhLine = humanizeToolStep('Read', { file_path: storagePath }, zh);
    const enLine = humanizeToolStep('Read', { file_path: storagePath }, en);
    expect(zhLine).toBe('读取了 notes.txt');
    expect(enLine).toBe('Read notes.txt');
    for (const line of [zhLine, enLine]) {
      expect(line).not.toContain('内部记录');
      expect(line).not.toMatch(/internal record/i);
      expect(line).not.toContain(STORAGE_UUID);
      expect(line.endsWith('notes.txt')).toBe(true);
    }
  });

  it('write row shows only the file name in zh and en', () => {
    const zhLine = humanizeToolStep('Write', { file_path: storagePath }, zh);
    const enLine = humanizeToolStep('Write', { file_path: storagePath }, en);
    expect(zhLine).toBe('写入了 notes.txt');
    expect(enLine).toBe('Wrote notes.txt');
    for (const line of [zhLine, enLine]) {
      expect(line).not.toContain('内部记录');
      expect(line).not.toMatch(/internal record/i);
      expect(line).not.toContain(STORAGE_UUID);
      expect(line.endsWith('notes.txt')).toBe(true);
    }
  });

  it('workspace relative path stays the relative path', () => {
    expect(humanizeToolStep('Read', { file_path: 'docs/报告.md' }, zh)).toBe('读取了 docs/报告.md');
    expect(humanizeToolStep('Write', { file_path: 'docs/报告.md' }, en)).toBe('Wrote docs/报告.md');
    expect(humanizeToolStep('Read', { file_path: '/Users/me/project/docs/报告.md' }, zh))
      .toBe('读取了 …/docs/报告.md');
  });
});
