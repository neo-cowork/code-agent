// N-FIX-CRON-WORKDIR-HIDDEN-DIRS-IN-USER-FOLDER：带工作文件夹的定时任务运行后，
// 用户选的文件夹里不得多出 .claude / .code-agent。
// 走真 executeCronAgentAction → 真 TaskManager → 真 AgentOrchestrator.setWorkingDirectory →
// 真 SkillWatcher；只把「建会话」和「模型调用（sendMessage）」脚本化。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobAction, CronJobDefinition } from '../../../src/shared/contract/cron';

const h = vi.hoisted(() => ({ workingDirectory: '' }));

vi.mock('../../../src/host/cron/cronAgentSession', () => ({
  createCronAgentSession: async () => ({ id: 'cron-clean-folder-session', workingDirectory: h.workingDirectory }),
}));
// LSP 是独立子系统，这里只关心 skillWatcher 与落盘结果
vi.mock('../../../src/host/lsp', () => ({
  initializeLSPManager: async () => undefined,
  getLSPManager: () => null,
}));
vi.mock('../../../src/host/cron/cronAgentRoleContext', () => ({
  buildCronAgentRunOptions: async () => ({}),
}));

import { executeCronAgentAction } from '../../../src/host/cron/cronAgentAction';
import { getTaskManager } from '../../../src/host/task';
import { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import { getSkillWatcher } from '../../../src/host/services/skills/skillWatcher';

const action: CronJobAction & { type: 'agent' } = { type: 'agent', agentType: 'default', prompt: '读一下笔记，列出今天的待跟进事项' };
const definition: CronJobDefinition = {
  id: 'job-clean-folder',
  name: '每天早上看笔记',
  scheduleType: 'cron',
  schedule: { type: 'cron', expression: '0 9 * * *' } as CronJobDefinition['schedule'],
  action,
  runsOn: 'local',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

function listing(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

describe('scheduled task with a chosen work folder', () => {
  let tempRoot: string;
  let notes: string;
  let priorDataDir: string | undefined;
  const setCalls: string[] = [];

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-clean-folder-'));
    notes = path.join(tempRoot, 'notes');
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, 'today.md'), '- 周五前回复张三\n');
    priorDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempRoot, 'app-data');
    h.workingDirectory = notes;
    // 与应用启动一致：skillWatcher 先以别处的目录初始化，之后切到任务文件夹时才会走 updateProjectDirectory
    const startup = path.join(tempRoot, 'startup');
    fs.mkdirSync(startup);
    await getSkillWatcher().initialize(startup);
    getTaskManager().initialize({
      configService: { getSettings: () => ({}), getApiKey: () => '' } as never,
      onAgentEvent: () => undefined,
    });
  });

  afterEach(async () => {
    getSkillWatcher().stop();
    vi.restoreAllMocks();
    if (priorDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = priorDataDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function runOnce(): Promise<void> {
    const drains: Array<Promise<void>> = [];
    const realSet = AgentOrchestrator.prototype.setWorkingDirectory;
    setCalls.length = 0;
    vi.spyOn(AgentOrchestrator.prototype, 'setWorkingDirectory').mockImplementation(function (this: AgentOrchestrator, ...args) {
      setCalls.push(args[0]);
      realSet.apply(this, args);
      drains.push(this.drainWorkspaceServices());
    });
    vi.spyOn(AgentOrchestrator.prototype, 'sendMessage').mockResolvedValue(undefined as never);
    await executeCronAgentAction(
      { recordSessionId: async () => undefined, updateJob: async () => undefined, deliverCronResult: async () => undefined } as never,
      definition,
      action as never,
    );
    // 运行收尾会清掉 orchestrator；排空发生在 setWorkingDirectory 点火的 workspace services 链上
    await Promise.all(drains);
    expect(getSkillWatcher().isInitialized()).toBe(true);
  }

  it('leaves an empty-config notes folder exactly as it was', async () => {
    const before = listing(notes);
    await runOnce();
    expect(setCalls).toEqual([notes]); // 确实走到了 setWorkingDirectory 分支
    expect(listing(notes)).toEqual(before);
    expect(before).toEqual(['today.md']);
  });

  it('keeps a pre-existing .claude/skills untouched and adds nothing', async () => {
    const skill = path.join(notes, '.claude', 'skills', 'x', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, '---\nname: x\ndescription: d\n---\nbody\n');
    const bytes = fs.readFileSync(skill);
    const before = listing(notes);
    await runOnce();
    expect(setCalls).toEqual([notes]);
    expect(listing(notes)).toEqual(before);
    expect(fs.readFileSync(skill).equals(bytes)).toBe(true);
  });
});
