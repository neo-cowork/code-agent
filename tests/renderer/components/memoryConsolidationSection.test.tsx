// ============================================================================
// MemoryConsolidationSection —— 「最近整理」列表 + 预告句 + 一键恢复 UI
// （N-MEM-CONSOLIDATION-HISTORY-UNDO）
// 走渲染组件 + mock IPC：列表加载、展开明细、恢复确认流、typed 拒绝文案、已恢复徽标。
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MemoryTidyHistoryResult,
  MemoryTidyRestoreResult,
} from '../../../src/shared/contract/memory';

const invokeDomainMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invokeDomain: invokeDomainMock },
}));

vi.mock('../../../src/renderer/stores/appStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/stores/appStore')>();
  return {
    ...actual,
    useAppStore: vi.fn(() => ({ language: 'zh', setLanguage: vi.fn(), cloudUIStrings: {} })),
  };
});

import {
  MemoryConsolidationSection,
  buildTidyPreviewSentence,
  buildTidyRunSummary,
} from '../../../src/renderer/components/features/settings/tabs/MemoryConsolidationSection';
import { zh } from '../../../src/renderer/i18n/zh';

const copy = zh.settings.memoryTidy;
const now = Date.parse('2026-11-19T08:00:00.000Z');

function historyFixture(): MemoryTidyHistoryResult {
  return {
    runs: [
      {
        auditId: 'mem_consolidation_run1',
        at: Date.parse('2026-11-19T07:00:00.000Z'),
        outcome: 'applied',
        reason: 'duplicate descriptions',
        mergeCount: 1,
        conflictCount: 1,
        netPutAway: 2,
        merges: [{
          sources: [
            { filename: 'report-format-a.md', name: '报告格式甲' },
            { filename: 'report-format-b.md', name: '报告格式乙' },
          ],
          result: { filename: 'report-formatting.md', name: '报告格式偏好', summary: '合并后的报告格式偏好' },
        }],
        conflicts: [{
          source: { filename: 'old-rule.md', name: '旧自动化规则' },
          reason: '与「不自动推送代码」冲突。',
          restorable: true,
        }],
        restored: false,
        restoredAt: null,
        restorable: true,
      },
      {
        auditId: 'mem_consolidation_run0',
        at: Date.parse('2026-11-12T07:00:00.000Z'),
        outcome: 'applied',
        reason: 'duplicate names',
        mergeCount: 1,
        conflictCount: 0,
        netPutAway: 2,
        merges: [{
          sources: [
            { filename: 'client-a.md', name: '客户名写法甲' },
            { filename: 'client-b.md', name: '客户名写法乙' },
          ],
          result: { filename: 'client-name.md', name: '客户名写法', summary: '客户名的正确拼写' },
        }],
        conflicts: [],
        restored: true,
        restoredAt: Date.parse('2026-11-13T09:00:00.000Z'),
        restorable: false,
        blockedCode: 'already-restored',
      },
    ],
    preview: {
      at: Date.parse('2026-11-19T06:00:00.000Z'),
      wouldChangeNothing: false,
      reason: 'duplicate descriptions',
      merges: [{
        sources: [
          { filename: 'report-format-a.md', name: '报告格式甲' },
          { filename: 'report-format-b.md', name: '报告格式乙' },
        ],
        result: { filename: 'report-formatting.md', name: '报告格式偏好', summary: '合并后的报告格式偏好' },
      }],
      conflicts: [],
    },
  };
}

function mockBackend(options: {
  history?: MemoryTidyHistoryResult | null;
  restore?: MemoryTidyRestoreResult;
  autoConsolidate?: boolean;
}): void {
  invokeDomainMock.mockImplementation(async (domain: string, action: string) => {
    if (domain === 'domain:settings' && action === 'get') {
      return { memory: { autoConsolidate: options.autoConsolidate ?? false } };
    }
    if (domain === 'domain:memory' && action === 'memoryTidyList') {
      if (options.history === null) throw new Error('list exploded');
      return options.history ?? historyFixture();
    }
    if (domain === 'domain:memory' && action === 'memoryTidyRestore') {
      if (!options.restore) throw new Error('unexpected restore call');
      return options.restore;
    }
    throw new Error(`unexpected invoke ${domain}:${action}`);
  });
}

async function openFirstRunDetail() {
  const expandButtons = await screen.findAllByTestId('memory-tidy-expand');
  fireEvent.click(expandButtons[0]);
  await screen.findByTestId('memory-tidy-merge');
}

describe('buildTidyRunSummary / buildTidyPreviewSentence（纯函数）', () => {
  it('summarizes an applied run with merges and conflicts in plain language', () => {
    const run = historyFixture().runs[0];
    expect(buildTidyRunSummary(run, copy)).toBe(
      '合并 1 组记忆，收起 2 条旧记忆，另有 1 条与说明冲突的记忆被收起',
    );
    // 只降级冲突、没有合并的运行不说「合并 0 组」。
    const conflictOnly = buildTidyRunSummary(
      { ...run, mergeCount: 0, merges: [] },
      copy,
    );
    expect(conflictOnly).toBe('收起了 1 条与说明冲突的记忆');
  });

  it('summarizes no-op / failed runs without internal English reasons', () => {
    expect(buildTidyRunSummary({ ...historyFixture().runs[0], outcome: 'no-op', mergeCount: 0, conflictCount: 0 }, copy))
      .toBe(copy.summaryNoChange);
    const failed = buildTidyRunSummary({ ...historyFixture().runs[0], outcome: 'failed' }, copy);
    expect(failed).toBe(copy.summaryFailed);
    expect(failed).not.toContain('duplicate');
  });

  it('builds the off-state preview sentence, including the nothing-to-change case', () => {
    const sentence = buildTidyPreviewSentence(
      historyFixture().preview,
      copy,
      zh.settings.memory.relativeDate,
      'zh-CN',
      now,
    );
    expect(sentence).toContain(copy.previewIntro.replace('{date}', '今天'));
    expect(sentence).toContain('开启后会把 1 组相似记忆合并，收起 2 条旧记忆。');
    expect(sentence).not.toContain('{');

    const nothing = buildTidyPreviewSentence(
      { ...historyFixture().preview!, wouldChangeNothing: true, merges: [] },
      copy,
      zh.settings.memory.relativeDate,
      'zh-CN',
      now,
    );
    expect(nothing).toContain(copy.previewNothing);
    expect(buildTidyPreviewSentence(null, copy, zh.settings.memory.relativeDate, 'zh-CN', now))
      .toBe(copy.previewMissing);
  });
});

describe('MemoryConsolidationSection 最近整理', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-11-19T08:00:00.000Z'));
  });

  afterEach(() => {
    cleanup();
    invokeDomainMock.mockReset();
  });

  it('lists recent runs with dates and summaries, marks restored rows, shows the off-state preview', async () => {
    mockBackend({});

    render(<MemoryConsolidationSection />);

    await waitFor(() => {
      expect(screen.getByTestId('memory-tidy-history')).toBeTruthy();
    });
    // 开关关着 → 预告句可见。
    expect(screen.getByTestId('memory-tidy-preview').textContent).toContain('开启后会把 1 组相似记忆合并');
    // 两行记录：日期 + 人话摘要；已恢复的那行带徽标、没有恢复按钮。
    const runs = screen.getAllByTestId('memory-tidy-run');
    expect(runs).toHaveLength(2);
    expect(runs[0].textContent).toContain('合并 1 组记忆，收起 2 条旧记忆');
    expect(runs[1].textContent).toContain('11月11日');
    expect(screen.getByTestId('memory-tidy-restored').textContent).toBe('已恢复');
  });

  it('expands a run into merge detail and put-away names', async () => {
    mockBackend({});

    render(<MemoryConsolidationSection />);
    await openFirstRunDetail();

    expect(screen.getByTestId('memory-tidy-merge').textContent)
      .toContain('报告格式甲 + 报告格式乙 → 报告格式偏好');
    expect(screen.getByTestId('memory-tidy-merge').textContent).toContain('（合并后的报告格式偏好）');
    expect(screen.getByTestId('memory-tidy-putaway').textContent)
      .toContain('收起的记忆：报告格式甲、报告格式乙');
    expect(screen.getAllByTestId('memory-tidy-conflict')[0].textContent)
      .toContain('旧自动化规则：与「不自动推送代码」冲突。');
  });

  it('asks one plain confirmation before restoring, then refreshes the row to restored', async () => {
    mockBackend({ restore: { ok: true, restoredAt: now } });

    render(<MemoryConsolidationSection />);
    await openFirstRunDetail();

    fireEvent.click(screen.getByTestId('memory-tidy-restore'));
    const confirm = await screen.findByTestId('memory-tidy-confirm');
    expect(confirm.textContent).toContain(copy.restoreConfirmTitle);
    expect(confirm.textContent).toContain(copy.restoreConfirmBody);

    invokeDomainMock.mockImplementation(async (domain: string, action: string) => {
      if (domain === 'domain:memory' && action === 'memoryTidyList') {
        const history = historyFixture();
        history.runs[0] = { ...history.runs[0], restored: true, restoredAt: now, restorable: false };
        return history;
      }
      if (domain === 'domain:memory' && action === 'memoryTidyRestore') {
        return { ok: true, restoredAt: now };
      }
      throw new Error(`unexpected invoke ${domain}:${action}`);
    });

    fireEvent.click(screen.getByTestId('memory-tidy-confirm-ok'));
    await screen.findByTestId('memory-tidy-restored');
    expect(invokeDomainMock).toHaveBeenCalledWith('domain:memory', 'memoryTidyRestore', {
      auditId: 'mem_consolidation_run1',
    });
  });

  it('renders a plain refusal sentence for typed restore errors', async () => {
    mockBackend({ restore: { ok: false, code: 'already-restored', message: 'boom' } });

    render(<MemoryConsolidationSection />);
    await openFirstRunDetail();
    fireEvent.click(screen.getByTestId('memory-tidy-restore'));
    fireEvent.click(await screen.findByTestId('memory-tidy-confirm-ok'));

    const error = await screen.findByTestId('memory-tidy-error');
    expect(error.textContent).toBe(copy.restoreErrors['already-restored']);
    expect(error.textContent).not.toContain('boom');
  });

  it('shows the empty state and the load-failure state', async () => {
    mockBackend({ history: { runs: [], preview: null } });
    const { unmount } = render(<MemoryConsolidationSection />);
    await waitFor(() => {
      expect(screen.getByTestId('memory-tidy-history').textContent).toContain(copy.empty);
    });
    unmount();

    mockBackend({ history: null });
    render(<MemoryConsolidationSection />);
    await waitFor(() => {
      expect(screen.getByTestId('memory-tidy-history').textContent).toContain(copy.loadFailed);
    });
  });

  it('hides the preview sentence once the toggle is on', async () => {
    mockBackend({ autoConsolidate: true });
    render(<MemoryConsolidationSection />);
    await waitFor(() => {
      expect(screen.getByTestId('memory-consolidation-hint').textContent).toContain('已开启');
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('memory-tidy-run')).toHaveLength(2);
    });
    expect(screen.queryByTestId('memory-tidy-preview')).toBeNull();
  });
});
