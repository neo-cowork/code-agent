// 老用户的内置角色定义升级（N-MEETING-PAGE）：磁盘那份和旧版出厂内容哈希相同才升级，用户改过的一个字节都不动
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import os from 'os';
import * as path from 'path';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BUILTIN_ROLES, installBuiltinRoles } from '../../../../src/host/services/roleAssets/builtinRoles';

const ROLE = '记言';
const agentPath = () => path.join(mockConfigDir.dir, 'agents', `${ROLE}.md`);

/**
 * #2411 首版出厂内容：从 1a023111d 的 BUILTIN_ROLES 原样导出成夹具（CI 浅克隆读不到 git 历史）。
 * 夹具哈希 = 源码里登记的旧版哈希，两边对上才说明测的是真旧版。
 */
const FIXTURE = path.join(__dirname, '../../../fixtures/builtin-role-history/记言.2411.md');
const previousAgentMd = () => readFileSync(FIXTURE, 'utf-8');

beforeEach(async () => {
  mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-agentmd-upgrade-'));
  await fs.mkdir(path.join(mockConfigDir.dir, 'agents'), { recursive: true });
});
afterEach(async () => {
  await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
});

const current = () => BUILTIN_ROLES.find((r) => r.id === ROLE)!.agentMd;

describe('内置角色定义升级', () => {
  it('没改过的旧版（与旧出厂内容哈希相同）升级到新版', async () => {
    const old = previousAgentMd();
    expect(createHash('sha256').update(old, 'utf8').digest('hex')).toBe('36f49a0a62a66baccada4d664b12948a2a76a616051761085eadd42f89bf897e');
    expect(old).not.toBe(current());
    expect(old).toContain('tools: [Read, Write, Glob, ListDirectory, ReadDocument, AskUserQuestion, docx_generate, MemoryRead, MemoryWrite, TaskManager]');
    await fs.writeFile(agentPath(), old, 'utf-8');
    const result = await installBuiltinRoles();
    expect(result.upgradedAgents).toEqual([ROLE]);
    expect(await fs.readFile(agentPath(), 'utf-8')).toBe(current());
  });

  it('用户改过的那份保持不动（哪怕只改了一个字），修改时间早于新版也一样', async () => {
    const edited = previousAgentMd().replace('一句都不编造', '一句都不能编造');
    await fs.writeFile(agentPath(), edited, 'utf-8');
    const old = new Date(2020, 0, 1);
    await fs.utimes(agentPath(), old, old);
    const result = await installBuiltinRoles();
    expect(result.upgradedAgents).toEqual([]);
    expect(await fs.readFile(agentPath(), 'utf-8')).toBe(edited);
  });

  it('已是新版的不重复升级', async () => {
    await fs.writeFile(agentPath(), current(), 'utf-8');
    expect((await installBuiltinRoles()).upgradedAgents).toEqual([]);
  });
});
