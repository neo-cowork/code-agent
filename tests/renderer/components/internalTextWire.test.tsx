// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectInternalTextLeaks } from '../../../src/shared/internalTextLeakDetect';
import { presentReplyBody } from '../../../src/shared/replyBodyPresentation';

const ui = vi.hoisted(() => ({ language: 'en' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ language: ui.language, t: ui.language === 'zh' ? zh : en }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ openPreview: vi.fn() }),
}));
import { HumanizedText } from '../../../src/renderer/components/HumanizedText';
import { ToolHeader } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader';
import { WakeRationaleNote } from '../../../src/renderer/components/features/chat/WakeRationaleNote';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { getDisplaySessionTitle } from '../../../src/renderer/utils/sessionPresentation';

afterEach(cleanup);
function visibleText(container: HTMLElement) {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll('details:not([open])')) {
    details.replaceChildren(details.querySelector('summary')!);
  }
  return copy.textContent ?? '';
}

describe('shared internal text wiring', () => {
  it.each(['zh', 'en'] as const)('tool headers, names and disclosures are clean in %s', (lang) => {
    ui.language = lang;
    const raw = 'read_file call_report123 session_report123 /tmp/weekly/report.md';
    const { container } = render(<ToolHeader toolCall={{ id: 'call_report123', name: 'read_file',
      arguments: { path: '/tmp/weekly/report.md' }, shortDescription: raw }} status="success" />);
    const visible = visibleText(container);
    expect(visible).toContain(lang === 'zh' ? '读取' : 'Read');
    expect(detectInternalTextLeaks(visible)).toEqual([]);
    for (const element of container.querySelectorAll('[title], [aria-label]')) {
      expect(detectInternalTextLeaks(`${element.getAttribute('title')} ${element.getAttribute('aria-label')}`)).toEqual([]);
    }
    expect(detectInternalTextLeaks(getDisplaySessionTitle(raw, lang))).toEqual([]);
    const disclosure = render(<HumanizedText text='{"summary":"call_export123"}' />);
    expect(visibleText(disclosure.container)).not.toContain('call_export123');
    const details = disclosure.container.querySelector('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('call_export123');
  });

  it.each(['zh', 'en'] as const)('tool-step projection used by collapsed traces removes internal tokens in %s', (lang) => {
    const t = lang === 'en' ? en : zh;
    const raw = lang === 'en' ? 'Export call_export123' : '导出 call_export123';
    const result = humanizeToolStep('Write', { file_path: '/tmp/report.md' }, t, raw);
    expect(result).toContain(lang === 'en' ? 'tool operation' : '工具操作');
    expect(detectInternalTextLeaks(result)).toEqual([]);
  });

  it('renders the reply reason once after removing role/schedule control tags', () => {
    const raw = 'Report ready.<decision>report</decision><rationale>Review the report</rationale>'
      + '<cron_event_decision id="om_mail" action="ignore">Review the report</cron_event_decision>';
    const reply = presentReplyBody(raw, 'en');
    const view = render(<><div>{reply.text}</div><WakeRationaleNote fields={{ rationale: reply.rationale, missing: false }} /></>);
    expect(view.container.textContent).not.toContain('<decision>');
    expect(view.container.textContent).not.toContain('Review the report');
    fireEvent.click(view.getByTestId('wake-rationale-why'));
    expect(view.getAllByText('Review the report')).toHaveLength(1);
  });
});
