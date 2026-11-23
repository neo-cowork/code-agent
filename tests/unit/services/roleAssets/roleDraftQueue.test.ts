// ============================================================================
// RoleDraftQueue Tests — 对话式建角色草稿队列（入队去重 / 确认落盘 / 安全闸 / 放弃）
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const cadenceMocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  write: vi.fn(),
  resolve: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getMessages: cadenceMocks.getMessages }),
}));

vi.mock('../../../../src/host/services/roleAssets/roleProactivityWrite', () => ({
  writeRoleProactivityConfig: cadenceMocks.write,
}));

vi.mock('../../../../src/host/services/roleAssets/roleProactivity', () => ({
  resolveRoleProactivityConfig: cadenceMocks.resolve,
}));


vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: cadenceMocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

// 首次醒来：confirm 钩子只入队不等待；这里用 fake enqueue 观察调用（不真跑 run）
const firstWake = vi.hoisted(() => ({ enqueue: vi.fn(async (_roleId: string) => ({ enqueued: true })) }));

vi.mock('../../../../src/host/services/roleAssets/roleFirstWake', () => ({
  enqueueFirstWake: (roleId: string) => firstWake.enqueue(roleId),
}));

import {
  generateRoleAgentMd,
  enqueueRoleDraft,
  listRoleDrafts,
  confirmRoleDraft,
  rejectRoleDraft,
  getRoleDraftsDir,
} from '../../../../src/host/services/roleAssets/roleDraftQueue';

const agentsDir = () => path.join(mockConfigDir.dir, 'agents');
const rolesDir = () => path.join(mockConfigDir.dir, 'roles');

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

describe('roleDraftQueue', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-draft-'));
    vi.clearAllMocks();
    cadenceMocks.getMessages.mockReset().mockResolvedValue([]);
    cadenceMocks.resolve.mockReset().mockResolvedValue({ level: 'silent' });
    cadenceMocks.write.mockReset().mockResolvedValue({ proactivity: { level: 'daily' } });
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  describe('generateRoleAgentMd', () => {
    it('生成对齐 builtinRoles 的 frontmatter + 正文', () => {
      const md = generateRoleAgentMd({
        roleId: '产品经理',
        description: '需求分析、PRD、路线图专家',
        tools: ['Read', 'Write', 'WebSearch'],
        systemPrompt: '你是一名产品经理。',
      });
      expect(md).toContain('name: 产品经理');
      expect(md).toContain('description: 需求分析、PRD、路线图专家');
      expect(md).toContain('tools: [Read, Write, WebSearch]');
      expect(md).toContain('model: balanced');
      expect(md).toContain('max-iterations: 20');
      expect(md).toContain('你是一名产品经理。');
    });

    it('空 tools 时省略 tools 行', () => {
      const md = generateRoleAgentMd({ roleId: 'x', description: 'd', tools: [], systemPrompt: 'p' });
      expect(md).not.toContain('tools:');
    });

    it('单行化 description / name，防破坏 YAML', () => {
      const md = generateRoleAgentMd({
        roleId: 'a',
        description: '多行\n描述"带引号"',
        tools: [],
        systemPrompt: 'p',
      });
      expect(md).toContain("description: 多行 描述'带引号'");
    });
  });

  describe('enqueueRoleDraft', () => {
    it('正常入队：落 draft.json + agent.md，返回 meta', async () => {
      const { draft } = await enqueueRoleDraft({
        roleId: '产品经理',
        description: 'PRD 专家',
        tools: ['Read', 'Write'],
        systemPrompt: '你是产品经理',
        sessionId: 's1',
        timestamp: 1000,
      });
      expect(draft).not.toBeNull();
      expect(draft!.roleId).toBe('产品经理');
      const draftDir = path.join(getRoleDraftsDir(), draft!.id);
      expect(await exists(path.join(draftDir, 'draft.json'))).toBe(true);
      expect(await exists(path.join(draftDir, 'agent.md'))).toBe(true);
    });

    it('same-session replace writes the revision and removes the old draft', async () => {
      const input = { roleId: '日程管家', description: '看日历', systemPrompt: '只读日历', sessionId: 'same' };
      const first = await enqueueRoleDraft({ ...input, timestamp: 1 });
      const second = await enqueueRoleDraft({ ...input, description: '看日历，每天早上八点前提醒', systemPrompt: '只读日历并提醒', timestamp: 2 });
      expect(second.draft).toMatchObject({ description: '看日历，每天早上八点前提醒', sessionId: 'same' });
      expect(await listRoleDrafts()).toEqual([second.draft]);
      expect(await exists(path.join(getRoleDraftsDir(), first.draft!.id))).toBe(false);
      expect(await fs.readdir(getRoleDraftsDir())).toEqual([second.draft!.id]);
      expect(await fs.readFile(path.join(getRoleDraftsDir(), second.draft!.id, 'agent.md'), 'utf8')).toContain('只读日历并提醒');
    });

    it('invalid same-session revision preserves the pending draft', async () => {
      const input = { roleId: '日程管家', description: '看日历', systemPrompt: '只读日历', sessionId: 'same' };
      const first = await enqueueRoleDraft(input);
      expect((await enqueueRoleDraft({ ...input, systemPrompt: ' ' })).draft).toBeNull();
      expect(await listRoleDrafts()).toEqual([first.draft]);
    });

    it('非法 roleId 拒绝入队', async () => {
      const r1 = await enqueueRoleDraft({ roleId: '../etc', description: '', systemPrompt: 'p', sessionId: 's' });
      expect(r1.draft).toBeNull();
      expect(r1.reason).toMatch(/非法/);
      const r2 = await enqueueRoleDraft({ roleId: 'a/b', description: '', systemPrompt: 'p', sessionId: 's' });
      expect(r2.draft).toBeNull();
    });

    it('缺 systemPrompt 拒绝入队', async () => {
      const r = await enqueueRoleDraft({ roleId: 'x', description: 'd', systemPrompt: '  ', sessionId: 's' });
      expect(r.draft).toBeNull();
      expect(r.reason).toMatch(/系统提示词/);
    });

    it('已存在同名持久化角色 → 拒绝', async () => {
      // 预置一个持久化角色目录（isPersistentRole 看 roles/<id>/ 存在）
      await fs.mkdir(path.join(rolesDir(), '研究员'), { recursive: true });
      const r = await enqueueRoleDraft({ roleId: '研究员', description: 'd', systemPrompt: 'p', sessionId: 's' });
      expect(r.draft).toBeNull();
      expect(r.reason).toMatch(/已存在同名角色/);
    });

    it('队列里另一会话已有同名待确认草稿 → 拒绝', async () => {
      await enqueueRoleDraft({ roleId: '设计师', description: 'd', systemPrompt: 'p', sessionId: 's', timestamp: 1 });
      const r = await enqueueRoleDraft({ roleId: '设计师', description: 'd2', systemPrompt: 'p2', sessionId: 'other', timestamp: 2 });
      expect(r.draft).toBeNull();
      expect(r.reason).toMatch(/待确认/);
    });
  });

  describe('listRoleDrafts', () => {
    it('空目录返回空数组', async () => {
      expect(await listRoleDrafts()).toEqual([]);
    });

    it('按 createdAt 倒序', async () => {
      await enqueueRoleDraft({ roleId: 'a', description: '', systemPrompt: 'p', sessionId: 's', timestamp: 100 });
      await enqueueRoleDraft({ roleId: 'b', description: '', systemPrompt: 'p', sessionId: 's', timestamp: 200 });
      const drafts = await listRoleDrafts();
      expect(drafts.map((d) => d.roleId)).toEqual(['b', 'a']);
    });
  });

  describe('confirmRoleDraft', () => {
    const morningRole = {
      roleId: '晨间巡检',
      description: '巡检日历和邮箱',
      systemPrompt: '查看日历和邮箱',
      sessionId: 'authoring-session',
    };

    it('schedules 每天早上 9 点 at the default daily cadence using the latest real match', async () => {
      cadenceMocks.getMessages.mockResolvedValue([
        { role: 'user', content: '每天晚上 8 点替我看日历' },
        { role: 'user', content: '每天早上 9 点替我看一遍日历和邮箱' },
        { role: 'user', content: '简报越短越好' },
        { role: 'assistant', content: '每天早上 7 点' },
        { role: 'user', content: '每天早上 6 点', isMeta: true },
        { role: 'user', content: '每天早上 5 点', visibility: 'rewound' },
      ]);
      const { draft } = await enqueueRoleDraft(morningRole);
      expect(cadenceMocks.write).not.toHaveBeenCalled();

      expect((await confirmRoleDraft(draft!.id)).success).toBe(true);
      expect(cadenceMocks.getMessages).toHaveBeenCalledWith('authoring-session');
      expect(cadenceMocks.write).toHaveBeenCalledExactlyOnceWith('晨间巡检', { level: 'daily' });
    });

    it.each([
      ['no time', '帮我看一遍日历和邮箱', '查看日历和邮箱'],
      ['model-only 默认每天 9 点', '帮我看一遍日历和邮箱', '默认每天 9 点查看日历和邮箱'],
      ['bare clock', '整理下午3点的会议', '查看日历'],
      ['weekly', '每周一 9 点查看日历', '查看日历'],
      ['weekdays', '工作日 9 点查看日历', '查看日历'],
      ['weekdays mixed with a daily marker', '工作日每天早上 9 点查看日历', '查看日历'],
    ])('keeps the silent default for %s', async (_case, content, systemPrompt) => {
      cadenceMocks.getMessages.mockResolvedValue([{ role: 'user', content }]);
      const { draft } = await enqueueRoleDraft({ ...morningRole, systemPrompt });

      expect((await confirmRoleDraft(draft!.id)).success).toBe(true);
      expect(cadenceMocks.write).not.toHaveBeenCalled();
    });

    it('keeps the silent default when a previous authoring request supplied the only time', async () => {
      cadenceMocks.getMessages.mockResolvedValue([
        { role: 'user', content: '/create-role 每天早上 9 点检查项目进度' },
        { role: 'user', content: '/create-role 帮我建一位查看日历的专家' },
        { role: 'user', content: '只列出需要准备的会议' },
      ]);
      const { draft } = await enqueueRoleDraft(morningRole);

      expect((await confirmRoleDraft(draft!.id)).success).toBe(true);
      expect(cadenceMocks.write).not.toHaveBeenCalled();
    });

    it.each([
      ['new expert in a reused chat', '/create-role 每天早上 9 点检查项目进度', '再帮我建一个只看会议的专家'],
      ['English new expert in a reused chat', '/create-role every morning at 9 check project progress', 'Create another expert that only checks meetings'],
      ['new expert after a request prefix', '/create-role 每天早上 9 点检查项目进度', '帮我再创建一个只看会议的专家'],
      ['clock-only revision', '每天早上 9 点检查邮箱', '改成 10 点'],
      ['cancelled wake', '每天早上 9 点检查邮箱', '取消每天早上 9 点'],
      ['weekday revision', '每天早上 8 点看邮件', '改成工作日每天早上 9 点'],
      ['weekly revision', '每天早上 8 点看邮件', '改成每周一 9 点'],
      ['weekend revision', '每天早上 8 点看邮件', '改成周末早上 9 点'],
    ])('I1 does not carry an earlier schedule into %s', async (_case, earlier, latest) => {
      cadenceMocks.getMessages.mockResolvedValue([
        { role: 'user', content: earlier },
        { role: 'user', content: latest },
        { role: 'user', content: '简报越短越好' },
      ]);
      const { draft } = await enqueueRoleDraft(morningRole);

      expect((await confirmRoleDraft(draft!.id)).success).toBe(true);
      expect(cadenceMocks.write).not.toHaveBeenCalled();
    });

    it.each([
      ['每晚 7', '0 0 19 * * *'],
      ['every evening at 7', '0 0 19 * * *'],
      ['每早8', '0 0 8 * * *'],
      ['创建「每日晨检」。每天晚上 8 点查看日历', '0 0 20 * * *'],
      ['每日晚上 8 点半', '0 30 20 * * *'],
      ['daily at 7:15 pm', '0 15 19 * * *'],
      ['每天早上9点15', '0 15 9 * * *'],
      ['每天早上八点三十', '0 30 8 * * *'],
      ['每天晚上12点', '0 0 0 * * *'],
    ])('I2 saves the explicit clock in %s', async (content, cadence) => {
      cadenceMocks.getMessages.mockResolvedValue([{ role: 'user', content }]);
      const { draft } = await enqueueRoleDraft(morningRole);

      expect((await confirmRoleDraft(draft!.id)).success).toBe(true);
      expect(cadenceMocks.write).toHaveBeenCalledExactlyOnceWith('晨间巡检', { level: 'daily', cadence });
    });

    it.each([
      '每天把第3点做完',
      '每天早上把第3点做完',
      'every evening at 7:5',
      '每早 25',
      '每早8件事',
      '每天早上 3 封邮件',
      '每晚 2 封',
      'every evening at 7th Street',
      '不要每天早上 9 点了',
      '取消每天早上 9 点',
      "Don't wake every morning at 9",
    ])(
      'I2 does not install a guessed clock for %s',
      async (content) => {
        cadenceMocks.getMessages.mockResolvedValue([{ role: 'user', content }]);
        const { draft } = await enqueueRoleDraft(morningRole);

        expect((await confirmRoleDraft(draft!.id)).success).toBe(true);
        expect(cadenceMocks.write).not.toHaveBeenCalled();
      },
    );

    it('sets 09:00 explicitly when a reused role ID retains a custom cadence', async () => {
      cadenceMocks.resolve.mockResolvedValue({ level: 'silent', cadence: '0 0 20 * * *' });
      cadenceMocks.getMessages.mockResolvedValue([
        { role: 'user', content: '/create-role 每天早上 9 点查看日历' },
      ]);
      const { draft } = await enqueueRoleDraft(morningRole);

      expect((await confirmRoleDraft(draft!.id)).success).toBe(true);
      expect(cadenceMocks.write).toHaveBeenCalledExactlyOnceWith('晨间巡检', {
        level: 'daily',
        cadence: '0 0 9 * * *',
      });
    });

    it('confirms even if reading the cadence source fails', async () => {
      cadenceMocks.getMessages.mockRejectedValue(new Error('read failed'));
      const { draft } = await enqueueRoleDraft(morningRole);

      expect((await confirmRoleDraft(draft!.id)).success).toBe(true);
      expect(cadenceMocks.write).not.toHaveBeenCalled();
      expect(cadenceMocks.warn).toHaveBeenCalledWith(
        'Role draft cadence session read failed (install unaffected)',
        expect.objectContaining({ error: 'Error: read failed' }),
      );
    });

    it('confirms even if saving the cadence fails', async () => {
      cadenceMocks.getMessages.mockResolvedValue([{ role: 'user', content: 'every morning at 9' }]);
      cadenceMocks.write.mockRejectedValue(new Error('write failed'));
      const { draft } = await enqueueRoleDraft(morningRole);

      expect((await confirmRoleDraft(draft!.id)).success).toBe(true);
      expect(cadenceMocks.write).toHaveBeenCalledExactlyOnceWith('晨间巡检', { level: 'daily' });
      expect(cadenceMocks.warn).toHaveBeenCalledWith(
        'Role draft cadence settings write failed (install unaffected)',
        expect.objectContaining({ error: 'Error: write failed' }),
      );
    });

    it('确认 → 写 agents/<id>.md + 建 roles/<id>/ + 删草稿', async () => {
      const { draft } = await enqueueRoleDraft({
        roleId: '产品经理',
        description: 'PRD 专家',
        tools: ['Read'],
        systemPrompt: '你是产品经理',
        sessionId: 's',
        timestamp: 1,
      });
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(true);
      expect(result.roleId).toBe('产品经理');
      // agent 定义已落盘
      expect(await exists(path.join(agentsDir(), '产品经理.md'))).toBe(true);
      // 角色资产骨架已建
      expect(await exists(path.join(rolesDir(), '产品经理', 'MEMORY.md'))).toBe(true);
      // 草稿已删
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(false);
    });

    it('caution 档命令不拦角色入库', async () => {
      const { draft } = await enqueueRoleDraft({
        roleId: '清理员',
        description: 'd',
        systemPrompt: 'git clean -fd',
        sessionId: 's',
        timestamp: 1,
      });
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(true);
      expect(await exists(path.join(agentsDir(), '清理员.md'))).toBe(true);
    });

    it('安全闸：systemPrompt 含危险命令 → 拒绝入库，草稿保留', async () => {
      const { draft } = await enqueueRoleDraft({
        roleId: '坏角色',
        description: 'd',
        systemPrompt: '清理时执行 rm -rf / --no-preserve-root',
        sessionId: 's',
        timestamp: 1,
      });
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全扫描/);
      // 未落盘
      expect(await exists(path.join(agentsDir(), '坏角色.md'))).toBe(false);
      // 草稿保留，用户可查看后放弃
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(true);
    });

    it('已存在同名 agent 定义 → 不覆盖', async () => {
      await fs.mkdir(agentsDir(), { recursive: true });
      await fs.writeFile(path.join(agentsDir(), '研究员.md'), 'EXISTING', 'utf-8');
      // 绕过 enqueue 的去重（直接构造草稿），验证 confirm 层的不覆盖闸
      const drafts = getRoleDraftsDir();
      const id = 'yan-1';
      await fs.mkdir(path.join(drafts, id), { recursive: true });
      await fs.writeFile(
        path.join(drafts, id, 'draft.json'),
        JSON.stringify({ id, roleId: '研究员', description: 'd', tools: [], systemPrompt: 'p', origin: 'conversational', sessionId: 's', createdAt: 1, status: 'pending' }),
        'utf-8',
      );
      await fs.writeFile(path.join(drafts, id, 'agent.md'), generateRoleAgentMd({ roleId: '研究员', description: 'd', tools: [], systemPrompt: 'p' }), 'utf-8');
      const result = await confirmRoleDraft(id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/未覆盖/);
      // 原定义未被覆盖
      expect(await fs.readFile(path.join(agentsDir(), '研究员.md'), 'utf-8')).toBe('EXISTING');
    });

    it('草稿不存在 → 报错', async () => {
      const result = await confirmRoleDraft('nope-1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/草稿不存在/);
    });
  });

  describe('对话式改已有角色 (editingRoleId)', () => {
    it('editingRoleId 指向真实存在的角色 → 不拒同名（改已有就是同名）', async () => {
      await fs.mkdir(path.join(rolesDir(), '研究员'), { recursive: true });
      const { draft, reason } = await enqueueRoleDraft({
        roleId: '研究员',
        editingRoleId: '研究员',
        description: '升级版研究员',
        tools: ['Read', 'WebSearch'],
        systemPrompt: '你是升级版研究员',
        sessionId: 's',
        timestamp: 1,
      });
      expect(reason).toBeUndefined();
      expect(draft).not.toBeNull();
      expect(draft!.editingRoleId).toBe('研究员');
    });

    it('editingRoleId 指向不存在的角色 → 拒绝', async () => {
      const { draft, reason } = await enqueueRoleDraft({
        roleId: '幽灵',
        editingRoleId: '幽灵',
        description: 'd',
        systemPrompt: 'p',
        sessionId: 's',
      });
      expect(draft).toBeNull();
      expect(reason).toMatch(/不存在/);
    });

    it('改名（editingRoleId !== roleId）→ 拒绝（本期不支持改名）', async () => {
      await fs.mkdir(path.join(rolesDir(), '研究员'), { recursive: true });
      const { draft, reason } = await enqueueRoleDraft({
        roleId: '高级研究员',
        editingRoleId: '研究员',
        description: 'd',
        systemPrompt: 'p',
        sessionId: 's',
      });
      expect(draft).toBeNull();
      expect(reason).toMatch(/改名/);
    });

    it('confirm 覆盖 agents/<id>.md 定义，但绝不动 roles/<id>/ 记忆与履历', async () => {
      cadenceMocks.getMessages.mockResolvedValue([{ role: 'user', content: '改成每天早上 9 点' }]);
      // 预置一个真实存在的持久化角色：旧定义 + 用户积累的记忆 + 履历
      await fs.mkdir(agentsDir(), { recursive: true });
      await fs.writeFile(path.join(agentsDir(), '研究员.md'), 'OLD DEFINITION', 'utf-8');
      const memoriesDir = path.join(rolesDir(), '研究员', 'memories');
      await fs.mkdir(memoriesDir, { recursive: true });
      const memPath = path.join(memoriesDir, 'note.md');
      const historyPath = path.join(rolesDir(), '研究员', 'history.md');
      await fs.writeFile(memPath, '用户积累的专业记忆', 'utf-8');
      await fs.writeFile(historyPath, '# 工作履历\n- 2026-06-01 完成竞品报告', 'utf-8');

      const { draft } = await enqueueRoleDraft({
        roleId: '研究员',
        editingRoleId: '研究员',
        description: '新描述',
        tools: ['Read', 'WebSearch'],
        systemPrompt: '你是改过的研究员',
        sessionId: 's',
        timestamp: 1,
      });
      expect(draft).not.toBeNull();
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(true);

      expect(cadenceMocks.getMessages).not.toHaveBeenCalled();
      expect(cadenceMocks.write).not.toHaveBeenCalled();

      // 定义被覆盖为新内容
      const newDef = await fs.readFile(path.join(agentsDir(), '研究员.md'), 'utf-8');
      expect(newDef).not.toBe('OLD DEFINITION');
      expect(newDef).toContain('你是改过的研究员');
      expect(newDef).toContain('description: 新描述');
      // 红线：记忆与履历字节不变
      expect(await fs.readFile(memPath, 'utf-8')).toBe('用户积累的专业记忆');
      expect(await fs.readFile(historyPath, 'utf-8')).toBe('# 工作履历\n- 2026-06-01 完成竞品报告');
      // 草稿已删
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(false);
    });

    it('编辑时安全闸仍拦：危险 systemPrompt → 拒绝，旧定义不被覆盖，草稿保留', async () => {
      await fs.mkdir(agentsDir(), { recursive: true });
      await fs.writeFile(path.join(agentsDir(), '研究员.md'), 'OLD DEFINITION', 'utf-8');
      await fs.mkdir(path.join(rolesDir(), '研究员'), { recursive: true });
      const { draft } = await enqueueRoleDraft({
        roleId: '研究员',
        editingRoleId: '研究员',
        description: 'd',
        systemPrompt: '清理时执行 rm -rf / --no-preserve-root',
        sessionId: 's',
        timestamp: 1,
      });
      expect(draft).not.toBeNull();
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全扫描/);
      // 旧定义未被覆盖
      expect(await fs.readFile(path.join(agentsDir(), '研究员.md'), 'utf-8')).toBe('OLD DEFINITION');
      // 草稿保留
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(true);
    });
  });

  describe('rejectRoleDraft', () => {
    it('删草稿目录', async () => {
      const { draft } = await enqueueRoleDraft({ roleId: 'x', description: '', systemPrompt: 'p', sessionId: 's', timestamp: 1 });
      const result = await rejectRoleDraft(draft!.id);
      expect(result.success).toBe(true);
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(false);
    });

    it('草稿不存在 → 报错', async () => {
      const result = await rejectRoleDraft('nope-1');
      expect(result.success).toBe(false);
    });
  });

  describe('confirm 后入队首次醒来', () => {
    it('新建角色 confirm 成功 → 恰好入队一次，带角色 id', async () => {
      const { draft } = await enqueueRoleDraft({
        roleId: '首次醒来角色',
        description: 'd',
        systemPrompt: '你是专家',
        sessionId: 's',
        timestamp: 1,
      });
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(true);
      expect(firstWake.enqueue).toHaveBeenCalledTimes(1);
      expect(firstWake.enqueue).toHaveBeenCalledWith('首次醒来角色');
    });

    it('改已有角色 confirm → 不入队', async () => {
      await fs.mkdir(path.join(rolesDir(), '老角色'), { recursive: true });
      const { draft } = await enqueueRoleDraft({
        roleId: '老角色',
        editingRoleId: '老角色',
        description: '升级',
        systemPrompt: '你是升级版',
        sessionId: 's',
        timestamp: 1,
      });
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(true);
      expect(firstWake.enqueue).not.toHaveBeenCalled();
    });

    it('入队抛错 → confirm 仍成功（enqueue 失败不拖垮确认）', async () => {
      firstWake.enqueue.mockRejectedValueOnce(new Error('boom'));
      const { draft } = await enqueueRoleDraft({
        roleId: '入队失败角色',
        description: 'd',
        systemPrompt: 'p',
        sessionId: 's',
        timestamp: 1,
      });
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(true);
      expect(result.roleId).toBe('入队失败角色');
      // 角色定义照常落盘
      expect(await exists(path.join(agentsDir(), '入队失败角色.md'))).toBe(true);
    });
  });
});
