import { describe, expect, it } from 'vitest';
import { formatPathForDisplay } from '../../../src/renderer/utils/formatPathForDisplay';

describe('formatPathForDisplay', () => {
  const root = '/Users/alice/work/foo';

  it('工作区内 → ./相对（根带或不带尾斜杠）', () => {
    expect(formatPathForDisplay('/Users/alice/work/foo/src/a.ts', { workspaceRoot: root })).toBe('./src/a.ts');
    expect(formatPathForDisplay('/Users/alice/work/foo/src/a.ts', { workspaceRoot: `${root}/` })).toBe('./src/a.ts');
  });

  it('根目录自身 → ./', () => {
    expect(formatPathForDisplay(root, { workspaceRoot: root })).toBe('./');
    expect(formatPathForDisplay(`${root}/`, { workspaceRoot: root })).toBe('./');
    expect(formatPathForDisplay(root, { workspaceRoot: `${root}/` })).toBe('./');
  });

  it('只共享前缀的兄弟目录不算工作区内', () => {
    expect(formatPathForDisplay('/Users/alice/work/foobar/a.ts', { workspaceRoot: root })).toBe('~/work/foobar/a.ts');
  });

  it('家目录折成 ~（macOS / Linux / Windows / 他人账户）', () => {
    expect(formatPathForDisplay('/Users/alice/Documents/a.txt')).toBe('~/Documents/a.txt');
    expect(formatPathForDisplay('/home/bob/notes/a.txt')).toBe('~/notes/a.txt');
    expect(formatPathForDisplay('C:\\Users\\carol\\Documents\\a.txt')).toBe('~\\Documents\\a.txt');
    expect(formatPathForDisplay('/Users/other')).toBe('~');
    expect(formatPathForDisplay('/Users/other/x', { workspaceRoot: root })).toBe('~/x');
  });

  it('工作区和家目录之外 → 上级/文件名', () => {
    expect(formatPathForDisplay('/var/data/reports/q3.xlsx')).toBe('reports/q3.xlsx');
    expect(formatPathForDisplay('D:\\data\\reports\\q3.xlsx')).toBe('reports/q3.xlsx');
  });

  it('含 .. 的路径不缩成「上级/文件名」，只折家目录', () => {
    expect(formatPathForDisplay('/var/folders/ab/cd/T/../../../etc/passwd')).toBe('/var/folders/ab/cd/T/../../../etc/passwd');
    expect(formatPathForDisplay('/Users/alice/up/x/../../../etc/hosts', { workspaceRoot: root })).toBe('~/up/x/../../../etc/hosts');
  });

  it('单段与空串原样', () => {
    expect(formatPathForDisplay('notes.txt')).toBe('notes.txt');
    expect(formatPathForDisplay('/etc')).toBe('/etc');
    expect(formatPathForDisplay('/tmp/x')).toBe('/tmp/x');
    expect(formatPathForDisplay('')).toBe('');
    expect(formatPathForDisplay('   ')).toBe('');
  });

  it('中文文件名', () => {
    expect(formatPathForDisplay('/Users/alice/文档/周报.docx')).toBe('~/文档/周报.docx');
    expect(formatPathForDisplay('/data/季度/周报.docx')).toBe('季度/周报.docx');
    expect(formatPathForDisplay('/Users/alice/工作/项目/a.md', { workspaceRoot: '/Users/alice/工作/项目' })).toBe('./a.md');
  });

  it('结果从不含 /Users/<账户>', () => {
    for (const p of ['/Users/alice/a', '/Users/alice', '/Users/alice/work/foo/x', '/Users/alice/a/b/c/d']) {
      expect(formatPathForDisplay(p, { workspaceRoot: root })).not.toMatch(/\/Users\//);
    }
  });
});
