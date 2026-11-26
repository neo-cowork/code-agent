// ============================================================================
// 轻量记忆：旧版「历史恢复提示」不得进入 recent-conversations.md / 注入块
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => mockConfigDir.dir };
});
vi.mock('../../../src/host/model/quickModel', () => ({
  memoryTask: vi.fn(async () => ({ success: false, error: 'unavailable' })),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { judgeConversation } from '../../../src/host/lightMemory/conversationJudge';
import {
  appendConversationSummary,
  buildRecentConversationsBlock,
} from '../../../src/host/lightMemory/recentConversations';

const LEGACY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';
const TRUNCATED = '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字...';
const LEAK = /历史恢复提示|telemetry|重建|脱敏/;

describe('recovery notice does not leak into light memory', () => {
  let tmpDir: string;
  let summaryPath: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-notice-'));
    mockConfigDir.dir = tmpDir;
    summaryPath = path.join(tmpDir, 'memory', 'recent-conversations.md');
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('judgeConversation heuristic path sees only the real text', async () => {
    const judgment = await judgeConversation({
      userMessages: [`${LEGACY_NOTICE}\n\n真内容`, `${LEGACY_NOTICE}\n\n继续，把 Q3 的数字总结成三条要点`],
    });
    expect(judgment.source).toBe('heuristic');
    expect(judgment.title).toBe('继续，把 Q3 的数字总结成三条要点');
    expect(judgment.worthKnowledge).toContain('真内容');
    expect(JSON.stringify(judgment)).not.toMatch(LEAK);
  });

  it('judgeConversation treats a notice-only message as empty', async () => {
    const judgment = await judgeConversation({ userMessages: [`${LEGACY_NOTICE}\n\n`] });
    expect(judgment.worth).toBe(false);
  });

  it('cleans a truncated dirty highlight on append and in the injected block', async () => {
    await fs.writeFile(
      summaryPath,
      `# Recent Conversations\n\n- **2026-03-19**: "整理 Q3 数字" — ${TRUNCATED}, 真内容\n`,
    );
    const before = await buildRecentConversationsBlock();
    expect(before).not.toMatch(LEAK);
    expect(before).toContain('真内容');

    await appendConversationSummary({ date: '2026-03-20', title: '新话题', highlights: ['要点一'] });
    const persisted = await fs.readFile(summaryPath, 'utf8');
    expect(persisted).not.toMatch(LEAK);
    expect(persisted).toContain('真内容');
    expect(persisted).toContain('要点一');
    expect(await buildRecentConversationsBlock()).not.toMatch(LEAK);
  });

  it('drops a dirty highlight from the incoming summary', async () => {
    await appendConversationSummary({ date: '2026-03-20', title: '干净标题', highlights: [TRUNCATED, '保留'] });
    const persisted = await fs.readFile(summaryPath, 'utf8');
    expect(persisted).not.toMatch(LEAK);
    expect(persisted).toContain('保留');
  });

  it('promotes the first clean highlight when the title is dirty, drops the entry when none', async () => {
    await fs.writeFile(
      summaryPath,
      `# Recent Conversations\n\n- **2026-03-18**: "${TRUNCATED}" — 真话题, 附带\n- **2026-03-19**: "${TRUNCATED}" — ${TRUNCATED}\n`,
    );
    await appendConversationSummary({ date: '2026-03-20', title: TRUNCATED, highlights: ['传入话题'] });
    await appendConversationSummary({ date: '2026-03-20', title: TRUNCATED, highlights: [TRUNCATED] });
    const persisted = await fs.readFile(summaryPath, 'utf8');
    expect(persisted).not.toMatch(LEAK);
    expect(persisted).toContain('"真话题" — 附带');
    expect(persisted).toContain('"传入话题"');
    expect(persisted.match(/^- \*\*/gm)).toHaveLength(2);
    expect(await buildRecentConversationsBlock()).not.toMatch(LEAK);
  });
});
