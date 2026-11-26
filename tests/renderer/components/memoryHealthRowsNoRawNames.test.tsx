// @vitest-environment jsdom
// N-FIX-MEMORY-HEALTH-ROW-RAW-FILENAME：健康预览行只给数量，不露文件名 / 路径 / 英文原因。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildLightMemoryIssuePreview } from '../../../src/renderer/components/features/settings/tabs/memoryAuditClient';
import { LightMemoryHealthPanel } from '../../../src/renderer/components/features/settings/tabs/MemoryDiagnosticsSections';
import { en, zh } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('Light Memory 健康预览不外露文件名与英文原因', () => {
  const rawReason = "EACCES: permission denied, open '/Users/someone/.code-agent/memory/memory-1763700000000.md'";
  const health = {
    totalFiles: 6,
    indexExists: true,
    indexLineCount: 12,
    indexTooLong: false,
    missingInIndex: ['memory-1763700000000.md', 'memory-1763700000001.md'],
    orphanInIndex: ['memory-1763700000002.md'],
    invalidFrontmatter: [
      { filename: 'memory-1763700000003.md', reason: 'missing frontmatter' },
      { filename: 'memory-1763700000004.md', reason: 'missing description' },
    ],
    unreadableFiles: [{ filename: 'memory-1763700000005.md', reason: rawReason }],
    duplicateNames: [],
    duplicateDescriptions: [],
  };
  const leaks = (text: string) => {
    expect(text).not.toContain('.md');
    expect(text).not.toContain('memory-');
    expect(text).not.toMatch(/\/[A-Za-z.]/);
    expect(text).not.toContain('frontmatter');
    expect(text).not.toContain('EACCES');
  };

  it('buildLightMemoryIssuePreview：四类各一行，只有数量（zh）', () => {
    const rows = buildLightMemoryIssuePreview(health, zh);
    expect(rows).toEqual([
      '2 条记忆还没进目录',
      '目录里有 1 条记忆已找不到',
      '2 条记忆缺少描述',
      '1 条记忆无法读取',
    ]);
    leaks(rows.join('\n'));
  });

  it('buildLightMemoryIssuePreview：四类各一行，只有数量（en）', () => {
    const rows = buildLightMemoryIssuePreview(health, en);
    expect(rows).toEqual([
      '2 memories are not in the catalog yet',
      '1 catalog entry points to a memory that is gone',
      '2 memories are missing a description',
      '1 memory could not be read',
    ]);
    leaks(rows.join('\n'));
  });

  it.each(['zh', 'en'] as const)('LightMemoryHealthPanel（%s）渲染不含文件名/路径/原因', (language) => {
    useAppStore.setState({ language });
    render(
      React.createElement(LightMemoryHealthPanel, {
        health,
        rebuildResult: null,
        isLoading: false,
        isRebuilding: false,
        onRebuild: () => {},
      }),
    );
    const text = screen.getByTestId('light-memory-health-panel').textContent ?? '';
    leaks(text);
    expect(text).toContain(language === 'zh' ? '1 条记忆无法读取' : '1 memory could not be read');
    cleanup();
    useAppStore.setState({ language: 'zh' });
  });
});
