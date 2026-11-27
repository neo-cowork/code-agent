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

  it('/Users/.. 之类的「账户名」不折成 ~，相对路径与 ~ 写法原样', () => {
    expect(formatPathForDisplay('/Users/../etc/passwd')).toBe('/Users/../etc/passwd');
    expect(formatPathForDisplay('/Users/..')).toBe('/Users/..');
    expect(formatPathForDisplay('C:\\Users\\..\\Windows\\x.ini')).toBe('C:\\Users\\..\\Windows\\x.ini');
    expect(formatPathForDisplay('src/utils/format.ts')).toBe('src/utils/format.ts');
    expect(formatPathForDisplay('~/Documents/secrets/a.txt')).toBe('~/Documents/secrets/a.txt');
  });

  it('Shared / Public 等共享目录不当成家目录折成 ~', () => {
    expect(formatPathForDisplay('/Users/Shared/report.md')).toBe('Shared/report.md');
    expect(formatPathForDisplay('/Users/Shared/Docs/report.md')).toBe('Docs/report.md');
    expect(formatPathForDisplay('C:\\Users\\Public\\Documents\\a.txt')).toBe('Documents/a.txt');
    expect(formatPathForDisplay('/Users/Shared')).toBe('/Users/Shared');
    expect(formatPathForDisplay('C:\\Users\\Deleted Users\\x\\a.txt')).not.toMatch(/^~/);
    expect(formatPathForDisplay('/Users/alice/Shared/a.txt')).toBe('~/Shared/a.txt');
  });

  it('keepLocation：审批面仅按宿主真实 homeDir 折 ~，他人账户/未知家目录/系统路径均保留完整位置', () => {
    const keep = { workspaceRoot: root, homeDir: '/Users/alice', keepLocation: true };
    expect(formatPathForDisplay('/etc/ssh/sshd_config', keep)).toBe('/etc/ssh/sshd_config');
    expect(formatPathForDisplay('/private/etc/sudoers.d/x', keep)).toBe('/private/etc/sudoers.d/x');
    expect(formatPathForDisplay('/Users/Shared/drop/.ssh/authorized_keys', keep)).toBe('/Users/Shared/drop/.ssh/authorized_keys');
    expect(formatPathForDisplay('/Volumes/Backup/Documents/report.docx', keep)).toBe('/Volumes/Backup/Documents/report.docx');
    expect(formatPathForDisplay('/tmp/evil/Documents/report.docx', keep)).toBe('/tmp/evil/Documents/report.docx');
    expect(formatPathForDisplay('/Users/alice/Documents/a.txt', keep)).toBe('~/Documents/a.txt');
    expect(formatPathForDisplay('/Users/bob/.ssh/authorized_keys', keep)).toBe('/Users/bob/.ssh/authorized_keys');
    expect(formatPathForDisplay('/Users/alice2/Documents/a.txt', keep)).toBe('/Users/alice2/Documents/a.txt');
    expect(formatPathForDisplay('/Users/alice/Documents/a.txt', { workspaceRoot: root, keepLocation: true })).toBe('/Users/alice/Documents/a.txt');
    expect(formatPathForDisplay(`${root}/src/a.ts`, keep)).toBe('./src/a.ts');
    expect(formatPathForDisplay('/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z.txt', { ...keep, maxLength: 20 })).toBe('/a/b/…/y/z.txt');
    expect(formatPathForDisplay('/etc/ssh/sshd_config', { ...keep, maxLength: 60 })).toBe('/etc/ssh/sshd_config');
    expect(formatPathForDisplay('/var/folders/ab/../../etc/passwd', keep)).toBe('/var/folders/ab/../../etc/passwd');
    expect(formatPathForDisplay('/Users/bob/up/../../etc/passwd', keep)).toBe('/Users/bob/up/../../etc/passwd');
    expect(formatPathForDisplay('/Users/alice/up/../../etc/passwd', keep)).toBe('~/up/../../etc/passwd');
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
