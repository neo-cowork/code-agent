import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageMetadata } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// Static rendering reads Zustand's initial snapshot; supply the selected language explicitly.
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { languages } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: languages[useAppStore.getState().language] }) };
});

const receipt: NonNullable<MessageMetadata['roleEditReceipt']> = {
  roleId: '研究员', addedTools: ['calendar', 'read_calendar', 'private_future_tool'], removedTools: ['Write'],
  descriptionChanged: false, promptChanged: false, diffAvailable: true,
};
function renderRow(detail = receipt) {
  const message: Message = { id: 'receipt', role: 'system', content: 'Expert updated.', timestamp: 2, metadata: { roleEditReceipt: detail } };
  const nodes = projectTurns([{ id: 'user', role: 'user', content: 'Add calendar', timestamp: 1 }, message], 'session', false)
    .turns.flatMap((turn) => turn.nodes);
  const node = nodes.find((item) => item.id === message.id);
  expect(node).toBeDefined();
  return renderToStaticMarkup(<TraceNodeRenderer node={node!} />);
}

afterEach(() => useAppStore.setState({ language: 'zh' }));
describe('role edit receipt projection and rendering', () => {
  it.each(['zh', 'en'] as const)('renders plain capability names in %s', (language) => {
    useAppStore.setState({ language });
    const html = renderRow();
    expect(html).toContain(language === 'zh' ? '已更新专家「研究员」。' : 'Updated expert “研究员”.');
    expect(html).toContain(language === 'zh' ? '日历' : 'Calendar');
    expect(html).toContain(language === 'zh' ? '移除能力：写入和编辑文件。' : 'Removed capabilities: Write and edit files.');
    expect(html).toContain(language === 'zh' ? '简介未变。' : 'Description unchanged.');
    expect(html).toContain(language === 'zh' ? '工作规则未变。' : 'Working rules unchanged.');
    expect(html).not.toMatch(/read_calendar|private_future_tool|Expert updated\./);
  });
  it.each(['zh', 'en'] as const)('renders unchanged and unavailable comparisons distinctly in %s', (language) => {
    useAppStore.setState({ language });
    const unchanged = { ...receipt, addedTools: [], removedTools: [] };
    expect(renderRow(unchanged)).toContain(language === 'zh' ? '能力、简介和工作规则均未变化。' : 'capabilities, description and working rules are unchanged.');
    expect(renderRow({ ...unchanged, diffAvailable: false })).toContain(language === 'zh' ? '但无法比较本次变化。' : 'but the changes could not be compared.');
    expect(renderRow({ ...unchanged, descriptionChanged: true, promptChanged: true }))
      .toContain(language === 'zh' ? '工作规则已更新。' : 'Working rules updated.');
  });
});
