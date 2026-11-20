// N-FIX-MEMORY-PACKER-INJECTS-UNMATCHED-USER-MEMORY：自动注入只带"这轮问题命中"的 user-memory。
// packer 不 mock：真 light memory 文件 + 真 packMemoryEntries / buildPackedSeedMemory。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/config/configPaths')>(),
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../src/host/services', () => ({ getDatabase: () => null }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { packMemoryEntries, rebuildMemoryMirrorFromLightFiles } from '../../../src/host/memory/memoryEntryRuntime';
import {
  buildPackedManualPreferences,
  buildPackedSeedMemory,
  buildPackedUserDirectives,
} from '../../../src/host/utils/seedMemoryInjector';

async function writeMemory(memDir: string, filename: string, type: string, title: string, body: string): Promise<void> {
  const text = `---\nname: ${title}\ndescription: ${title}\ntype: ${type}\n---\n\n${body}\n`;
  await fs.writeFile(path.join(memDir, filename), text, 'utf8');
}

async function writeManualMemory(
  memDir: string,
  filename: string,
  type: string,
  title: string,
  body: string,
  extra: { status?: string } = {},
): Promise<void> {
  const frontmatter = [
    '---',
    `name: ${title}`,
    `description: ${title}`,
    `type: ${type}`,
    `entry_id: mem_entry_manual_${filename.replace('.md', '')}`,
    ...(extra.status ? [`status: ${extra.status}`] : []),
    'source: manual',
    '---',
  ].join('\n');
  await fs.writeFile(path.join(memDir, filename), `${frontmatter}\n\n${body}\n`, 'utf8');
}

describe('requireQueryMatch（自动注入不带无关 user-memory）', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-require-match-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
    await writeMemory(memDir, 'ts.md', 'user', 'TypeScript 偏好', '用户偏好 TypeScript strict mode，喜欢严格类型');
    await writeMemory(memDir, 'dir.md', 'directive', 'Always reply in Chinese', 'Always reply in Chinese when user writes Chinese');
    await rebuildMemoryMirrorFromLightFiles(undefined as never).catch(() => undefined);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('(a) 无关问题 + 无关 active user-memory → 空包，不是 null（不触发 database-seed 回落）', async () => {
    const result = await buildPackedSeedMemory({ query: '帮我把这三个网页总结成周报' });
    expect(result).not.toBeNull();
    expect(result?.packed.items).toEqual([]);
    expect(result?.block).toBe('');
  });

  it('(b) 相关问题（英文 / 未标点中文句子）仍命中并注入', async () => {
    const english = await buildPackedSeedMemory({ query: 'what is my typescript preference' });
    expect(english?.packed.items.map((item) => item.title)).toContain('TypeScript 偏好');

    const chinese = await buildPackedSeedMemory({ query: '我想知道我的严格类型偏好是什么' });
    expect(chinese?.packed.items.map((item) => item.title)).toContain('TypeScript 偏好');
    expect(chinese?.block).toContain('## Packed Memories');
    // 自动学习路径的背景边界原样保留（只是背景证据，不是当前指令）
    expect(chinese?.block).toContain('不是当前指令');
  });

  it('(c) directives 无 query 照常注入', async () => {
    const directives = await buildPackedUserDirectives({});
    expect(directives?.packed.items.length).toBeGreaterThan(0);
  });

  it('(d) 不带标志的 packMemoryEntries（memoryPack IPC 同款）保持原排序/宽松过滤', async () => {
    const loose = await packMemoryEntries({ query: '帮我把这三个网页总结成周报', statuses: ['active'] });
    expect(loose.items.length).toBeGreaterThan(0);
    const strict = await packMemoryEntries({ query: '帮我把这三个网页总结成周报', statuses: ['active'], requireQueryMatch: true });
    expect(strict.items).toEqual([]);
  });

  it('query 切不出 token 时保持原行为（不过滤，照常打包）', async () => {
    await expect(buildPackedSeedMemory({ query: '?' })).resolves.not.toBeNull();
  });
});

// N-FIX-FIX-MEMORY-SETTINGS-NO-MANUAL-ADD-ENTRY-FU1：设置页手写的 user/feedback 常驻偏好
// 不再被 requireQueryMatch 挡住——每个新会话都注入；自动学习路径与手写 project/reference 不变。
describe('manual preferences（手写常驻偏好，无条件注入）', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-manual-pref-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
    await writeManualMemory(
      memDir, 'manual-user.md', 'user',
      'I prefer Chinese replies, keep answers short',
      'I prefer Chinese replies, keep answers short',
    );
    // 夹具正文避开 query token：匹配是子串 includes（"minimal" 含 "is"、"theme" 含 "the"），
    // 英文 query 的虚词 token 会误命中英文正文，故辅助夹具用中文正文。
    await writeMemory(memDir, 'auto-user.md', 'user', 'Editor choice', '用户平时用 Zed 编辑器，偏好深色主题');
    await writeManualMemory(memDir, 'manual-project.md', 'project', 'Repo layout', '仓库是 pnpm monorepo，源码都在 packages 目录');
    await writeManualMemory(memDir, 'manual-reference.md', 'reference', 'DNS notes', '家用机房跑 Cloudflare 解析');
    await writeManualMemory(
      memDir, 'manual-archived.md', 'user',
      'Old archived preference', '已归档的手写偏好：日历格式',
      { status: 'archived' },
    );
    await rebuildMemoryMirrorFromLightFiles(undefined as never).catch(() => undefined);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('① 手写 user 偏好 + 无关英文问题：auto 包为空，manual packer 返回该条', async () => {
    const query = 'What is the difference between TCP and UDP, and when should I pick each one?';
    const auto = await buildPackedSeedMemory({ query });
    expect(auto).not.toBeNull();
    expect(auto?.packed.items).toEqual([]);
    expect(auto?.block).toBe('');

    const manual = await buildPackedManualPreferences({});
    expect(manual?.packed.items.map((item) => item.title)).toEqual(['I prefer Chinese replies, keep answers short']);
    expect(manual?.block).toContain('## User-Stated Preferences');
    expect(manual?.block).toContain('I prefer Chinese replies, keep answers short');
    // 手写常驻偏好是「用户本人当下的要求」：不得附带「不是当前指令」的共享边界文案（会抵消注入语义）
    expect(manual?.block).not.toContain('不是当前指令');
  });

  it('② 自动学习（非 manual）user 条目：无关问题下两个 packer 都不注入', async () => {
    const query = 'What is the difference between TCP and UDP, and when should I pick each one?';
    const auto = await buildPackedSeedMemory({ query });
    expect(auto?.packed.items.map((item) => item.title)).not.toContain('Editor choice');

    const manual = await buildPackedManualPreferences({});
    expect(manual?.packed.items.map((item) => item.title)).not.toContain('Editor choice');
  });

  it('② 手写 project/reference 不进常驻块（仍走 query 命中）', async () => {
    const manual = await buildPackedManualPreferences({});
    const titles = manual?.packed.items.map((item) => item.title) ?? [];
    expect(titles).not.toContain('Repo layout');
    expect(titles).not.toContain('DNS notes');
  });

  it('② 已归档的手写条目不注入', async () => {
    const manual = await buildPackedManualPreferences({});
    expect(manual?.packed.items.map((item) => item.title)).not.toContain('Old archived preference');
  });

  it('② excludeEntryIds 排除的手写条目不注入', async () => {
    const manual = await buildPackedManualPreferences({
      excludeEntryIds: ['mem_entry_manual_manual-user'],
    });
    expect(manual).toBeNull();
  });
});
