import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import { SessionCommandCenter } from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../../src/host/task/backgroundTaskLedger';
import type { TaskManager } from '../../../../src/host/task/TaskManager';
import {
  describeDelegateTaskResult,
  normalizeSessionTaskShortName,
} from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import { delegateTaskSchema } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema';

describe('session command center short_name normalization', () => {
  it.each([
    ['周报', '周报'],
    ['QuarterlyReport', 'QR'],
    ['ReactResearch', 'RR'],
    ['research', 'rese'],
    ['竞品研究任务', '竞品研究'],
    ['R', 'R研究任'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeSessionTaskShortName(input, '研究任务')).toBe(expected);
  });

  it.each([
    ['PDF合同', '合同'],
    ['Excel报表', '报表'],
    ['PPT汇报', '汇报'],
    ['Q3季度销售报告', '季度销售'],
    ['Excel表', '表研究任'],
    ['PDF かなカナ', 'かなカナ'],
  ])('keeps CJK in %s → %s', (input, expected) => {
    expect(normalizeSessionTaskShortName(input, '研究任务')).toBe(expected);
  });

  it.each([
    ['サーバー設定', 'サーバー'],
    ['メール送信', 'メール送'],
    ['コードレビュー', 'コードレ'],
    ['ﾊﾟｿｺﾝ設定', 'ﾊﾟｿｺ'],
    ['ﾒｰﾙ送信', 'ﾒｰﾙ送'],
    ['PDFサーバー設定', 'サーバー'],
    ['は\u309Aそこん設定', 'は\u309Aそこ'],
  ])('keeps Japanese sound marks in %s → %s', (input, expected) => {
    expect(normalizeSessionTaskShortName(input, '研究任务')).toBe(expected);
  });

  it.each([
    ['PDF계약', '계약'],
    ['B超', 'B超'],
    ['QuarterlyReport。', 'QR'],
    ['QuarterlyReport\u0323', 'QR'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeSessionTaskShortName(input, '研究任务')).toBe(expected);
  });

  it('documents the same 2-4 character contract accepted by normalization', () => {
    const description = delegateTaskSchema.inputSchema.properties?.short_name?.description;
    expect(description).toContain('2-4 个字符');
    expect(description).toContain('中文或英文');
    expect(description).toContain('归一化');
  });
});

describe('session command center mixed-script task names', () => {
  const sessionId = 'contract-session';
  const workspaceScope = createWorkspaceScope('contract-project', [{
    sourceId: 'contract-source',
    path: '/tmp/contract-project',
    role: 'primary',
    access: 'read_write',
  }]);
  let center: SessionCommandCenter;

  beforeEach(() => {
    const manager = Object.assign(new EventEmitter(), {
      startBackgroundTask: vi.fn().mockResolvedValue(undefined),
    });
    center = new SessionCommandCenter(manager as unknown as TaskManager);
  });

  afterEach(() => {
    center.dispose();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  function spawnTask(rawShortName: string, title: string) {
    return center.spawn({
      sessionId,
      title,
      shortName: normalizeSessionTaskShortName(rawShortName, title),
      laneKey: title,
      submissionKey: title,
      prompt: title,
      workspaceScope,
    });
  }

  it('uses the CJK short name in the started receipt', async () => {
    const result = await spawnTask('PDF合同', 'PDF clauses');
    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') throw new Error('Expected a started task');
    expect(describeDelegateTaskResult(result)).toContain('后台任务「合同」已开始');
  });

  it('requires a choice between tasks that share the same normalized name', async () => {
    await spawnTask('PDF合同', 'PDF clauses');
    await spawnTask('Word合同', 'Word clauses');

    expect(center.resolve(sessionId, '合同')).toMatchObject({
      outcome: 'ambiguous',
      candidates: [
        { title: 'PDF clauses', shortName: '合同' },
        { title: 'Word clauses', shortName: '合同' },
      ],
    });
    expect(center.resolve(sessionId, '2')).toMatchObject({
      outcome: 'resolved',
      task: { title: 'Word clauses', shortName: '合同' },
    });
  });

  it('resolves a Japanese task by its short name with sound marks', async () => {
    await spawnTask('サーバー設定', 'Update configuration');

    expect(center.resolve(sessionId, 'サーバー')).toMatchObject({
      outcome: 'resolved',
      task: { title: 'Update configuration', shortName: 'サーバー' },
    });
  });
});
