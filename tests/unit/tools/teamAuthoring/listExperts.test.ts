import * as fs from 'fs/promises';
import os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ knownRoles: vi.fn() }));
vi.mock('../../../../src/host/services/team/teamRecipeService', () => ({ getTeamRecipeService: () => service }));

import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkillsData';
import { proposeRoleModule } from '../../../../src/host/tools/modules/roleAuthoring/proposeRole';
import { listExpertsModule } from '../../../../src/host/tools/modules/teamAuthoring/listExperts';
import { listExpertsSchema } from '../../../../src/host/tools/modules/teamAuthoring/listExperts.schema';

const allow = vi.fn(async () => ({ allow: true }));
const context = () => ({ abortSignal: { aborted: false } });

describe('list_experts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.knownRoles.mockResolvedValue([{ roleId: '研究员', displayName: '研究专家', description: '研究行业动态' }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('以只读、plan 可用的 schema 注册', () => {
    expect(listExpertsSchema).toMatchObject({
      name: 'list_experts',
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    });
    expect(listExpertsSchema.inputSchema.properties).toHaveProperty('name');
  });

  const runTool = async (args: Record<string, unknown> = {}) =>
    (await listExpertsModule.createHandler()).execute(args, context() as never, allow as never);

  it('返回人类可读名册和结构化 meta', async () => {
    const result = await runTool();

    expect(result).toMatchObject({
      ok: true,
      output: '研究员（研究专家） — 研究行业动态',
      meta: { roles: [{ roleId: '研究员', displayName: '研究专家', description: '研究行业动态' }] },
    });
  });

  // 2026-07-23：用户实测「模型只念花名（青禾/牧之），不知道是干什么的」。
  // profession 数据一直都有，只是名册没带出来。
  describe('花名后面必须带上职业', () => {
    it('花名与 roleId 一致时只补职业', async () => {
      service.knownRoles.mockResolvedValue([
        { roleId: '青禾', displayName: '青禾', description: '陪你从选题到成稿', profession: '内容主理人' },
      ]);
      expect(await runTool()).toMatchObject({ output: '青禾（内容主理人） — 陪你从选题到成稿' });
    });

    it('花名与 roleId 不同时两者都带，花名在前', async () => {
      service.knownRoles.mockResolvedValue([
        { roleId: 'researcher', displayName: '溯真', description: '把问题查穿', profession: '竞品与市场情报分析师' },
      ]);
      expect(await runTool()).toMatchObject({ output: 'researcher（溯真 · 竞品与市场情报分析师） — 把问题查穿' });
    });

    it('没有职业也没有独立花名时不留空括号', async () => {
      service.knownRoles.mockResolvedValue([
        { roleId: '小助手', displayName: '小助手', description: '打杂' },
      ]);
      expect(await runTool()).toMatchObject({ output: '小助手 — 打杂' });
    });
  });

  it('空名册给出明确引导，不返回空串', async () => {
    service.knownRoles.mockResolvedValue([]);
    const result = await (await listExpertsModule.createHandler()).execute({}, context() as never, allow as never);

    expect(result).toMatchObject({ ok: true, output: '本机还没有可用专家，请先建一个角色。', meta: { roles: [] } });
  });

  describe('name 参数：从当前槽位读取持久化角色定义（N-FIX-EDIT-ROLE-READ-DEF-SLOT-BLOCKED）', () => {
    let tempRoot = '';
    let fakeHome = '';
    let prodSlot = '';
    let devSlot1 = '';
    let devSlot2 = '';

    beforeEach(async () => {
      tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'list-experts-slot-'));
      fakeHome = path.join(tempRoot, 'home');
      prodSlot = path.join(fakeHome, '.code-agent');
      devSlot1 = path.join(fakeHome, '.code-agent-dev3');
      devSlot2 = path.join(fakeHome, '.code-agent-dev4');

      await fs.mkdir(path.join(prodSlot, 'agents'), { recursive: true });
      await fs.mkdir(path.join(prodSlot, 'roles', '研究员'), { recursive: true });
      await fs.writeFile(
        path.join(prodSlot, 'agents', '研究员.md'),
        '---\nname: 研究员\ndescription: 生产槽旧定义（绝不该被 Dev 槽读到）\ntools: [Read]\nmodel: balanced\n---\n\n生产槽提示词 PROD_SENTINEL',
        'utf-8',
      );

      await fs.mkdir(path.join(devSlot1, 'agents'), { recursive: true });
      await fs.mkdir(path.join(devSlot1, 'roles', '研究员'), { recursive: true });
      await fs.writeFile(
        path.join(devSlot1, 'agents', '研究员.md'),
        '---\nname: 研究员\ndescription: Dev3 槽的竞品与文献调研专家\ntools: [Read, WebSearch, WebFetch]\nmodel: balanced\n---\n\n你是 Dev3 槽的研究员，负责检索资料并给出结构化结论。',
        'utf-8',
      );

      await fs.mkdir(path.join(devSlot2, 'agents'), { recursive: true });
      await fs.mkdir(path.join(devSlot2, 'roles', '研究员'), { recursive: true });
      await fs.writeFile(
        path.join(devSlot2, 'agents', '研究员.md'),
        '---\nname: 研究员\ndescription: Dev4 槽的专利检索专家\ntools: [Read, Grep]\nmodel: fast\n---\n\n你是 Dev4 槽的研究员，专注专利与技术文献。',
        'utf-8',
      );

      vi.stubEnv('HOME', fakeHome);
      vi.stubEnv('CODE_AGENT_HOME', fakeHome);
    });

    afterEach(async () => {
      if (tempRoot) {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    it('(a) CODE_AGENT_DATA_DIR 指向 Dev 槽时返回该槽定义，绝不返回 fake home 下 .code-agent 的定义', async () => {
      vi.stubEnv('CODE_AGENT_DATA_DIR', devSlot1);

      const result = await runTool({ name: '研究员' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('description: Dev3 槽的竞品与文献调研专家');
        expect(result.output).toContain('tools: [Read, WebSearch, WebFetch]');
        expect(result.output).toContain('你是 Dev3 槽的研究员，负责检索资料并给出结构化结论。');
        expect(result.output).not.toContain('PROD_SENTINEL');
        expect(result.output).not.toContain('生产槽旧定义');
      }
    });

    it('(b) 切换到第二个数据目录（slot 2）时返回其各自的定义', async () => {
      vi.stubEnv('CODE_AGENT_DATA_DIR', devSlot2);

      const result = await runTool({ name: '研究员' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('description: Dev4 槽的专利检索专家');
        expect(result.output).toContain('tools: [Read, Grep]');
        expect(result.output).toContain('你是 Dev4 槽的研究员，专注专利与技术文献。');
        expect(result.output).not.toContain('Dev3 槽');
        expect(result.output).not.toContain('PROD_SENTINEL');
      }
    });

    it('(c) 未知角色名、含 / 或 .. 的非法名字、以及非持久化 agent 文件均返回未找到且不泄漏路径', async () => {
      vi.stubEnv('CODE_AGENT_DATA_DIR', devSlot1);
      // 准备一个只有 agents/<name>.md 但没有 roles/<name>/ 目录的非持久化 agent
      await fs.writeFile(
        path.join(devSlot1, 'agents', '临时工.md'),
        '---\nname: 临时工\ndescription: 瞬时代理\n---\n\n瞬时内容 TRANSIENT_SECRET',
        'utf-8',
      );

      for (const badName of ['不存在的专家', '../研究员', 'a/b', '..', '临时工']) {
        const result = await runTool({ name: badName });
        expect(result.ok, `name=${badName} should fail`).toBe(false);
        const text = JSON.stringify(result);
        expect(text).toContain('not found');
        expect(text).not.toContain(tempRoot);
        expect(text).not.toContain(devSlot1);
        expect(text).not.toContain('.code-agent');
        expect(text).not.toContain('ENOENT');
        expect(text).not.toContain('TRANSIENT_SECRET');
      }
    });

    it('(d) edit-role skill prompt 不再包含硬编码 ~/.code-agent/ 路径且引导调用 list_experts', () => {
      const editRole = BUILTIN_SKILLS.find((skill) => skill.name === 'edit-role');
      expect(editRole).toBeDefined();
      expect(editRole!.promptContent).not.toContain('~/.code-agent/');
      expect(editRole!.promptContent).toContain('list_experts');
      expect(editRole!.allowedTools).toContain('read_file');
      expect(editRole!.allowedTools).toContain('list_experts');
    });

    it('(f) list_experts 读出的当前槽定义可直接喂给 propose_role 生成带 editingRoleId 的修改草稿', async () => {
      vi.stubEnv('CODE_AGENT_DATA_DIR', devSlot1);

      const loaded = await runTool({ name: '研究员' });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const emit = vi.fn();
      const proposeHandler = await proposeRoleModule.createHandler();
      const draftResult = await proposeHandler.execute(
        {
          roleId: '研究员',
          editingRoleId: '研究员',
          description: 'Dev3 槽的竞品与文献调研专家（新增周报汇总）',
          tools: ['Read', 'WebSearch', 'WebFetch'],
          systemPrompt: `${loaded.output}\n\n补充要求：每周五输出一页纸汇总。`,
        },
        {
          sessionId: 'sess-edit-role-1',
          workingDir: devSlot1,
          abortSignal: { aborted: false } as AbortSignal,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
          emit,
        } as never,
        allow as never,
      );

      expect(draftResult.ok).toBe(true);
      if (draftResult.ok) {
        expect(draftResult.meta).toMatchObject({
          roleId: '研究员',
          editingRoleId: '研究员',
        });
      }
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'role_draft_pending',
          data: expect.objectContaining({
            drafts: [
              expect.objectContaining({
                roleId: '研究员',
                editingRoleId: '研究员',
              }),
            ],
          }),
        }),
      );
    });
  });
});
