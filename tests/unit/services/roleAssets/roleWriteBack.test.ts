// ============================================================================
// Role Write-Back Tests — write gate / 判断解析 / 层路由 / 履历
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const mockQuickTask = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../../src/host/model/quickModel', () => ({
  quickTask: mockQuickTask,
}));

import {
  applyWriteGate,
  runRoleWriteBack,
  type WriteBackCandidate,
} from '../../../../src/host/services/roleAssets/roleWriteBack';
import {
  ensureRoleAssetDirs,
  listScopedMemories,
  loadRoleHistory,
  writeScopedMemory,
} from '../../../../src/host/services/roleAssets/roleAssetService';

function candidate(overrides: Partial<WriteBackCandidate> = {}): WriteBackCandidate {
  return {
    layer: 'role',
    filename: 'test-memory.md',
    name: '测试记忆',
    description: '一条测试记忆',
    content: '用户的业务口径：GMV 不含退款，统计周期是自然周。',
    ...overrides,
  };
}

// 首次醒来内部指令的真实形状（无源变体，截取到足以命中共用首行即可）。
// 首行与 shared/constants 的 ROLE_ASSETS.FIRST_WAKE_PROMPT_HEAD 逐字对应：提示词首行一旦
// 改动，本夹具不再命中检测，测试转红，逼着改的人同步审视「内部指令绝不外显」这条约束。
const FIRST_WAKE_TASK_PROMPT = [
  '你刚被用户创建为一位持久化专家，此刻是创建后的第一次巡览。这不是用户发来的消息，用户现在不在场。',
  '',
  '用户创建你时留下的期望：「负责看日历和提醒」',
  '',
  '当前没有任何已连接的数据源，你没有可查看的真实数据，也不要做任何工具探查。',
  '',
  '你的任务：',
  '1. 绝对不要编造任务、数据、文件或来源——你没有数据，编造会误导用户。',
  '2. 最终回复只有 1 句话：根据你的职责，说连上哪类数据源最有帮助、连上之后你就能多做什么、在哪里连接（能力中心 → 连接器）。',
].join('\n');

describe('applyWriteGate (设计 §5.1)', () => {
  it('passes valid candidates', () => {
    const { accepted, rejected } = applyWriteGate([candidate()], new Set());
    expect(accepted.length).toBe(1);
    expect(rejected.length).toBe(0);
  });

  it('enforces quota of 3 entries (配额闸)', () => {
    const candidates = [1, 2, 3, 4, 5].map((i) =>
      candidate({ filename: `mem-${i}.md`, content: `有效的知识内容第 ${i} 条，足够长不被质量闸拦截。` }),
    );
    const { accepted, rejected } = applyWriteGate(candidates, new Set());
    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(2);
  });

  it('rejects log-like content (质量闸：拒流水账)', () => {
    const { accepted, rejected } = applyWriteGate(
      [candidate({ content: '完成了用户的调研任务' })],
      new Set(),
    );
    expect(accepted.length).toBe(0);
    expect(rejected.length).toBe(1);
  });

  it('rejects too-short content', () => {
    const { accepted } = applyWriteGate([candidate({ content: '短' })], new Set());
    expect(accepted.length).toBe(0);
  });

  it('truncates over-long content instead of rejecting', () => {
    const { accepted } = applyWriteGate(
      [candidate({ content: 'x'.repeat(10_000) })],
      new Set(),
    );
    expect(accepted.length).toBe(1);
    expect(accepted[0].content.length).toBeLessThan(5_000);
    expect(accepted[0].content).toContain('truncated by write gate');
  });

  it('dedupes within batch by filename (批内去重闸)', () => {
    const { accepted, rejected } = applyWriteGate(
      [
        candidate({ filename: 'same.md', content: '第一条有效知识内容，足够长。' }),
        candidate({ filename: 'same.md', content: '第二条有效知识内容，足够长。' }),
      ],
      new Set(),
    );
    expect(accepted.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it('allows updating existing memories (同名 = 更新而非新建)', () => {
    const { accepted } = applyWriteGate(
      [candidate({ filename: 'existing.md' })],
      new Set(['existing.md']),
    );
    expect(accepted.length).toBe(1);
  });
});

describe('runRoleWriteBack', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-wb-'));
    mockQuickTask.mockReset();
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  it('skips non-persistent roles without calling the model (零成本)', async () => {
    const result = await runRoleWriteBack({
      roleId: '普通agent',
      taskPrompt: 'task',
      finalOutput: 'output',
    });
    expect(result.executed).toBe(false);
    expect(mockQuickTask).not.toHaveBeenCalled();
  });

  it('writes role-layer memories from judgment and appends history', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        memories: [
          {
            layer: 'role',
            filename: 'user-business-glossary.md',
            name: '业务术语',
            description: '用户的 GMV 口径',
            content: '用户业务中 GMV 指标不含退款，统计周期为自然周。',
          },
        ],
        historySummary: '完成 Q2 增长数据调研',
      }),
    });

    const result = await runRoleWriteBack({
      roleId: '研究员',
      workspacePath: '/tmp/ws-1',
      taskPrompt: '调研 Q2 增长数据',
      finalOutput: '调研完成，GMV 增长 20%...',
      artifacts: [{ label: 'Q2 调研报告', ref: 'artifact://doc/q2-report' }],
    });

    expect(result.executed).toBe(true);
    expect(result.written).toBe(1);
    expect(result.historyAppended).toBe(true);

    const memories = await listScopedMemories({ scope: 'role', roleId: '研究员' });
    expect(memories.length).toBe(1);
    expect(memories[0].filename).toBe('user-business-glossary.md');
    expect(memories[0].content).toContain('不含退款');

    const history = await loadRoleHistory('研究员');
    expect(history.length).toBe(1);
    expect(history[0]).toContain('Q2 调研报告');
    expect(history[0]).toContain('artifact://doc/q2-report');
  });

  it('routes project-layer memories to workspace dir (层路由)', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        memories: [
          {
            layer: 'project',
            filename: 'project-template.md',
            name: '项目模板',
            description: '这个项目的周报模板位置',
            content: '该项目的周报模板在 docs/templates/weekly.md，按部门分三个 sheet。',
          },
        ],
        historySummary: '产出周报',
      }),
    });

    await runRoleWriteBack({
      roleId: '研究员',
      workspacePath: '/tmp/ws-project-route',
      taskPrompt: '写周报',
      finalOutput: 'done',
    });

    const projectMemories = await listScopedMemories({
      scope: 'project',
      workspacePath: '/tmp/ws-project-route',
    });
    expect(projectMemories.length).toBe(1);
    expect(projectMemories[0].filename).toBe('project-template.md');

    // 角色层不应有这条
    const roleMemories = await listScopedMemories({ scope: 'role', roleId: '研究员' });
    expect(roleMemories.length).toBe(0);
  });

  it('routes global-layer memories to light memory dir', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        memories: [
          {
            layer: 'global',
            filename: 'user-preference.md',
            name: '用户偏好',
            description: '用户讨厌套话，回复直接给结论',
            content: '用户是资深 PM，讨厌套话和模板化回复，永远先给结论再给依据。',
          },
        ],
        historySummary: 'x',
      }),
    });

    await runRoleWriteBack({
      roleId: '研究员',
      taskPrompt: 'x',
      finalOutput: 'y',
    });

    const globalMemPath = path.join(mockConfigDir.dir, 'memory', 'user-preference.md');
    const content = await fs.readFile(globalMemPath, 'utf-8');
    expect(content).toContain('讨厌套话');

    const indexContent = await fs.readFile(path.join(mockConfigDir.dir, 'memory', 'INDEX.md'), 'utf-8');
    expect(indexContent).toContain('[user-preference.md]');
  });

  it('masks secrets in global write-back files and INDEX; role and project layers still route', async () => {
    await ensureRoleAssetDirs('研究员');
    // sk-(?:proj-)? plus 40 alphanumerics. A short literal such as sk-test-xxxx is not masked.
    const secretBody = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const secret = `sk-proj-${secretBody}`;
    const card = '4111 1111 1111 1111';
    const maskedSecret = `sk-p...${secretBody.slice(-4)}`;
    const workspacePath = path.join(mockConfigDir.dir, 'ws-global-guard');

    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        memories: [
          {
            layer: 'global',
            filename: 'global-secret-note.md',
            name: '全局备忘',
            description: `描述里有密钥 ${secret} 和卡号 ${card}`,
            content: `正文里有密钥 ${secret} 和卡号 ${card}，这条足够长。`,
          },
          {
            layer: 'role',
            filename: 'role-glossary.md',
            name: '业务术语',
            description: '用户的 GMV 口径',
            content: '用户业务中 GMV 指标不含退款，统计周期为自然周。',
          },
          {
            layer: 'project',
            filename: 'project-template.md',
            name: '项目模板',
            description: '这个项目的周报模板位置',
            content: '该项目的周报模板在 docs/templates/weekly.md，按部门分三个 sheet。',
          },
        ],
        historySummary: '写回三层',
      }),
    });

    const result = await runRoleWriteBack({
      roleId: '研究员',
      workspacePath,
      taskPrompt: '整理记忆',
      finalOutput: 'done',
    });

    expect(result.written).toBe(3);

    const globalFile = await fs.readFile(path.join(mockConfigDir.dir, 'memory', 'global-secret-note.md'), 'utf-8');
    const indexContent = await fs.readFile(path.join(mockConfigDir.dir, 'memory', 'INDEX.md'), 'utf-8');
    for (const text of [globalFile, indexContent]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secretBody);
      expect(text).not.toContain(card);
      expect(text).toContain(maskedSecret);
      expect(text).toContain('[credit card hidden]');
    }
    expect(globalFile).toContain('全局备忘');
    expect(indexContent).toContain('[global-secret-note.md]');

    const roleMemories = await listScopedMemories({ scope: 'role', roleId: '研究员' });
    expect(roleMemories.map((m) => m.filename)).toEqual(['role-glossary.md']);
    expect(roleMemories[0].content).toContain('不含退款');
    expect(roleMemories[0].content).not.toContain(secret);

    const projectMemories = await listScopedMemories({ scope: 'project', workspacePath });
    expect(projectMemories.map((m) => m.filename)).toEqual(['project-template.md']);
    expect(projectMemories[0].content).toContain('docs/templates/weekly.md');
    expect(projectMemories[0].content).not.toContain(secret);
  });

  it('no-artifact write-back stores the real summary in the unchanged history format', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({ success: true, content: JSON.stringify({ memories: [], historySummary: '检查本周日程，未发现冲突' }) });
    const result = await runRoleWriteBack({ roleId: '研究员', taskPrompt: '检查本周日程', finalOutput: '未发现冲突' });
    expect(result.historyAppended).toBe(true);
    const history = await loadRoleHistory('研究员');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatch(/^- \d{4}-\d{2}-\d{2} \| 检查本周日程，未发现冲突 \| 检查本周日程，未发现冲突$/);
    expect(history[0]).not.toContain('（无产物落盘）');
  });

  it.each(['定时', '任务结束事件'])('uses a plain history fallback for a %s wake scaffold without a model summary', async (trigger) => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({ success: true, content: JSON.stringify({ memories: [] }) });
    const result = await runRoleWriteBack({
      roleId: '研究员',
      taskPrompt: `你被${trigger}唤醒。这不是用户发来的消息，用户现在不在。\n\n你的任务：\n1. 读你的工作履历（上面角色资产注入块里），找出你经手过的产物`,
      finalOutput: '已核对本周统计口径。',
    });
    expect(result.historyAppended).toBe(true);
    const history = await loadRoleHistory('研究员');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatch(/^- \d{4}-\d{2}-\d{2} \| 例行巡检记录 \| 例行巡检记录$/);
    expect(history[0]).not.toContain('你被');
    expect(history[0]).not.toContain('你的任务');
  });

  it.each(['cadence', 'event'])('keeps the persisted %s wake label unchanged', async (trigger) => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({ success: true, content: JSON.stringify({ memories: [] }) });
    const taskPrompt = `主动巡检（${trigger} 触发）`;
    await runRoleWriteBack({ roleId: '研究员', taskPrompt, finalOutput: '已核对口径。' });
    expect((await loadRoleHistory('研究员'))[0]).toMatch(new RegExp(`\\| ${taskPrompt} \\| ${taskPrompt}$`));
  });

  it('首次醒来的内部指令绝不外显为履历摘要：quick model 失败回落固定短句', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({ success: false, error: 'model unavailable' });

    const result = await runRoleWriteBack({
      roleId: '研究员',
      taskPrompt: FIRST_WAKE_TASK_PROMPT,
      finalOutput: '连上日历后我能帮你看日程和提醒。',
    });

    expect(result.historyAppended).toBe(true);
    const history = await loadRoleHistory('研究员');
    expect(history).toHaveLength(1);
    expect(history[0]).toContain('刚创建，还没开始工作');
    expect(history[0]).not.toContain('你刚被用户创建为');
    expect(history[0]).not.toContain('第一次巡览');
    expect(history[0]).not.toContain('（无产物落盘）');
  });

  it('首次醒来有人工摘要时照常存摘要，不替换成固定短句', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({ memories: [], historySummary: '刚创建，说明了连接日历后的用法' }),
    });

    await runRoleWriteBack({
      roleId: '研究员',
      taskPrompt: FIRST_WAKE_TASK_PROMPT,
      finalOutput: '连上日历后我能帮你看日程和提醒。',
    });

    const history = await loadRoleHistory('研究员');
    expect(history).toHaveLength(1);
    expect(history[0]).toContain('刚创建，说明了连接日历后的用法');
    expect(history[0]).not.toContain('你刚被用户创建为');
    expect(history[0]).not.toContain('还没开始工作');
  });

  it('degrades gracefully when quick model fails (只记履历不写记忆)', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({ success: false, error: 'model unavailable' });

    const result = await runRoleWriteBack({
      roleId: '研究员',
      taskPrompt: '调研任务',
      finalOutput: 'output',
    });

    expect(result.executed).toBe(true);
    expect(result.written).toBe(0);
    expect(result.historyAppended).toBe(true);

    const history = await loadRoleHistory('研究员');
    expect(history.length).toBe(1);
    expect(history[0]).toContain('调研任务');
    expect(history[0]).not.toContain('（无产物落盘）');
  });

  it('handles unparsable judgment output', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({ success: true, content: 'not json at all' });

    const result = await runRoleWriteBack({
      roleId: '研究员',
      taskPrompt: 'x',
      finalOutput: 'y',
    });
    expect(result.executed).toBe(true);
    expect(result.written).toBe(0);
  });

  it('aborts the queued/in-flight quick model request when write-back times out', async () => {
    vi.useFakeTimers();
    await ensureRoleAssetDirs('研究员');
    let receivedSignal: AbortSignal | undefined;
    mockQuickTask.mockImplementation((
      _prompt: string,
      _maxTokens: number,
      signal?: AbortSignal,
    ) => new Promise((resolve) => {
      receivedSignal = signal;
      signal?.addEventListener('abort', () => {
        resolve({ success: false, error: 'aborted' });
      }, { once: true });
    }));

    try {
      const pending = runRoleWriteBack({
        roleId: '研究员',
        taskPrompt: '会触发超时的任务',
        finalOutput: 'output',
      });
      await vi.waitFor(() => expect(mockQuickTask).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(true);
      expect(result).toMatchObject({ executed: true, written: 0, historyAppended: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('feeds existing memories to judge for dedup (去重闸输入)', async () => {
    await ensureRoleAssetDirs('研究员');
    await writeScopedMemory(
      { scope: 'role', roleId: '研究员' },
      { filename: 'existing-knowledge.md', name: 'E', description: '已有的知识', content: '...' },
    );
    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({ memories: [], historySummary: 'x' }),
    });

    await runRoleWriteBack({ roleId: '研究员', taskPrompt: 'x', finalOutput: 'y' });

    const judgePrompt = mockQuickTask.mock.calls[0][0] as string;
    expect(judgePrompt).toContain('existing-knowledge.md');
    expect(judgePrompt).toContain('已有的知识');
  });

  it('serializes concurrent write-backs for the same role (串行队列)', async () => {
    await ensureRoleAssetDirs('研究员');
    let concurrent = 0;
    let maxConcurrent = 0;
    mockQuickTask.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return {
        success: true,
        content: JSON.stringify({ memories: [], historySummary: 'x' }),
      };
    });

    await Promise.all([
      runRoleWriteBack({ roleId: '研究员', taskPrompt: 'a', finalOutput: '1' }),
      runRoleWriteBack({ roleId: '研究员', taskPrompt: 'b', finalOutput: '2' }),
      runRoleWriteBack({ roleId: '研究员', taskPrompt: 'c', finalOutput: '3' }),
    ]);

    expect(maxConcurrent).toBe(1);
    const history = await loadRoleHistory('研究员');
    expect(history.length).toBe(3);
  });
});
