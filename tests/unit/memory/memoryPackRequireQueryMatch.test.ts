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
import { buildPackedSeedMemory, buildPackedUserDirectives } from '../../../src/host/utils/seedMemoryInjector';

async function writeMemory(memDir: string, filename: string, type: string, title: string, body: string): Promise<void> {
  const text = `---\nname: ${title}\ndescription: ${title}\ntype: ${type}\n---\n\n${body}\n`;
  await fs.writeFile(path.join(memDir, filename), text, 'utf8');
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
