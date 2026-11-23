// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryEntry, MemoryEntryCreateResult, MemoryEntryListResult } from '../../../src/shared/contract/memory';

const invokeDomainMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invokeDomain: invokeDomainMock },
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(vi.fn(), { getState: () => ({ switchSession: vi.fn() }) }),
}));
vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: Object.assign(vi.fn(), { getState: () => ({ setPendingSearchJump: vi.fn() }) }),
}));
const lang = vi.hoisted(() => ({ current: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/stores/appStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/stores/appStore')>();
  return {
    ...actual,
    useAppStore: Object.assign(
      vi.fn(() => ({ language: lang.current, setLanguage: vi.fn(), cloudUIStrings: {} })),
      { getState: () => ({ setShowSettings: vi.fn(), workingDirectory: null }) },
    ),
  };
});

import { MemoryEntriesManager } from '../../../src/renderer/components/features/settings/tabs/MemoryEntriesManager';

const now = Date.now();
function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem_entry_old', schemaVersion: 2, status: 'active', kind: 'user', scope: 'global',
    title: 'Old memory', summary: 'Old memory', content: 'Old memory',
    source: { kind: 'light_file', sourceOfTruth: 'light_file', filePath: 'old.md' },
    evidence: [], sessionId: null, confidence: 1, createdAt: now - 1000, updatedAt: now - 1000,
    ...overrides,
  };
}

describe('MemoryEntriesManager add memory entry', () => {
  let store: MemoryEntry[];
  let createCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    store = [entry()];
    createCalls = [];
    invokeDomainMock.mockImplementation(async (_domain: string, action: string, request: Record<string, unknown>) => {
      if (action === 'memoryEntries') {
        const result: MemoryEntryListResult = { entries: [...store], sourceCounts: { light_file: store.length, db_memory: 0 } };
        return result;
      }
      if (action === 'memoryEntryCreate') {
        createCalls.push(request);
        const dup = store.find((item) => item.content === request.content);
        if (dup) return { created: false, duplicate: true, entry: dup } satisfies MemoryEntryCreateResult;
        const created = entry({
          id: 'mem_entry_new', title: String(request.content), content: String(request.content),
          kind: request.kind as MemoryEntry['kind'], updatedAt: now,
          source: { kind: 'manual', sourceOfTruth: 'light_file', filePath: 'new.md' },
        });
        store = [created, ...store];
        return { created: true, duplicate: false, entry: created } satisfies MemoryEntryCreateResult;
      }
      if (action === 'memoryEntryJournal') return { rows: [] };
      return {};
    });
  });
  afterEach(() => { cleanup(); invokeDomainMock.mockReset(); });

  it.each([
    ['zh', '添加记忆', '想让 Neo 记住什么？', '手动添加', '这条记忆已经存在'],
    ['en', 'Add memory', 'What should Neo remember?', 'Added manually', 'This memory already exists'],
  ] as const)('%s: empty cannot save, save shows the entry on top with a badge, duplicate is not re-added', async (language, button, title, badge, dupText) => {
    lang.current = language;
    render(<MemoryEntriesManager />);
    await waitFor(() => expect(screen.getAllByTestId('memory-entry-row')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(screen.getByText(title)).toBeTruthy();
    const save = screen.getByTestId('memory-entry-add-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('memory-entry-add-content'), { target: { value: '   ' } });
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('memory-entry-add-content'), { target: { value: 'I prefer replies in Chinese' } });
    fireEvent.change(screen.getByTestId('memory-entry-add-kind'), { target: { value: 'feedback' } });
    fireEvent.click(save);

    await waitFor(() => expect(screen.getAllByTestId('memory-entry-row')[0].textContent).toContain('I prefer replies in Chinese'));
    expect(createCalls).toEqual([expect.objectContaining({ action: 'memoryEntryCreate', content: 'I prefer replies in Chinese', kind: 'feedback' })]);
    expect(screen.getByTestId('memory-entry-manual-badge').textContent).toBe(badge);
    expect(screen.queryByTestId('memory-entry-add-form')).toBeNull();

    // 重复内容：不新增，提示已存在
    fireEvent.click(screen.getByRole('button', { name: button }));
    fireEvent.change(screen.getByTestId('memory-entry-add-content'), { target: { value: 'I prefer replies in Chinese' } });
    fireEvent.click(screen.getByTestId('memory-entry-add-save'));
    await waitFor(() => expect(screen.getByText(new RegExp(dupText))).toBeTruthy());
    expect(screen.getAllByTestId('memory-entry-row')).toHaveLength(2);
  });
  it.each(['zh', 'en'] as const)('%s: panel shows no internal names for a manually added entry', async (language) => {
    lang.current = language;
    store = [entry({
      id: 'mem_entry_62628bae', title: 'Reply briefly', summary: 'Reply briefly', content: 'Reply briefly',
      source: { kind: 'manual', sourceOfTruth: 'light_file', filePath: 'memory-62628bae.md' },
      evidence: [{ filePath: 'memory-62628bae.md' }] as MemoryEntry['evidence'],
    })];
    const { container } = render(<MemoryEntriesManager />);
    await waitFor(() => expect(screen.getAllByTestId('memory-entry-row')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('memory-entry-row'));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Light|\bDB\b|source of truth|mem_entry_|memory-62628bae|\.md\b/);
  });
});
