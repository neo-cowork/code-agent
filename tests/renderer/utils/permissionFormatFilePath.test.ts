import { describe, it, expect } from 'vitest';
import { formatFilePath } from '../../../src/renderer/components/PermissionDialog/utils';

// formatFilePath 同时服务删除后果句、沙箱放行路径、文件夹授权：目录部分不能被吞掉，
// 否则用户按文件名确认时对不上真实目标。
describe('formatFilePath keeps the real target (never reduces to a bare file name)', () => {
  it.each([
    '/tmp/x',
    '/tmp/neo-sandbox/neo-x.txt',
    '/tmp/../etc/passwd',
    '/var/folders/ab/cd/T/sales.csv',
  ])('%s unchanged', (input) => {
    expect(formatFilePath(input)).toBe(input);
  });
  it('long paths are still shortened but keep the leading directories', () => {
    const long = '/Users/me/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/file.txt';
    expect(formatFilePath(long).startsWith('/Users/')).toBe(true);
    expect(formatFilePath(long).endsWith('/file.txt')).toBe(true);
  });
});
