// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolCreateConfirmModal, type ToolCreateRequest } from '../../../src/renderer/components/ConfirmModal';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { languages } from '../../../src/renderer/i18n';

afterEach(cleanup);

const bash: ToolCreateRequest = {
  id: 't1', name: 'weekly_report_formatter', description: 'Turns raw meeting notes into a weekly report',
  type: 'bash_script', script: 'echo hello',
};
const js: ToolCreateRequest = { ...bash, id: 't2', type: 'javascript', script: undefined, code: 'return 1;' };

const legacyZh = {
  title: '创建动态工具', subtitle: 'AI 请求创建以下工具', deny: '拒绝', allow: '允许创建',
  warning: '此工具类型为 bash_script，可以执行系统命令。请仔细确认后再允许。',
  labels: ['名称:', '类型:', '描述:', '代码预览:'],
};

describe('ToolCreateConfirmModal language', () => {
  it.each(['en', 'zh'] as const)('renders pack strings for bash_script and other types: %s', (language) => {
    useAppStore.setState({ language });
    const text = languages[language].toolCreateConfirm;
    for (const request of [bash, js]) {
      const onAllow = vi.fn();
      const onDeny = vi.fn();
      render(<ToolCreateConfirmModal request={request} onAllow={onAllow} onDeny={onDeny} />);
      const dialog = screen.getByRole('dialog');
      const content = dialog.textContent ?? '';
      for (const s of [text.title, text.subtitle, text.deny, text.allow, text.nameLabel, text.typeLabel,
        text.descriptionLabel, text.codePreviewLabel]) expect(content).toContain(s);
      if (request.type === 'bash_script') {
        expect(content).toContain(`${text.warningPrefix}bash_script${text.warningSuffix}`);
      } else {
        expect(content).not.toContain(text.warningPrefix);
      }
      if (language === 'en') expect(content).not.toMatch(/\p{Script=Han}/u);
      fireEvent.click(screen.getByRole('button', { name: text.allow }));
      fireEvent.click(screen.getByRole('button', { name: text.deny }));
      expect(onAllow).toHaveBeenCalledTimes(1);
      expect(onDeny).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it('keeps the legacy Chinese text unchanged', () => {
    useAppStore.setState({ language: 'zh' });
    render(<ToolCreateConfirmModal request={bash} onAllow={vi.fn()} onDeny={vi.fn()} />);
    const content = screen.getByRole('dialog').textContent ?? '';
    for (const s of [legacyZh.title, legacyZh.subtitle, legacyZh.deny, legacyZh.allow, legacyZh.warning, ...legacyZh.labels]) {
      expect(content).toContain(s);
    }
  });
});
