// @vitest-environment jsdom
// MeetingsView 空态文案按运行时区分（FB-1472）：Web 不指向「+」菜单里不存在的「记这场会」，
// 改说该功能需要桌面端并保留飞书妙记 / 腾讯会议导入提示；桌面端文案不变。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({
  desktop: false,
  lang: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/services/nativeDesktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/nativeDesktop')>();
  return {
    ...actual,
    listMeetingRecords: vi.fn().mockResolvedValue([]),
    isNativeDesktopAvailable: () => state.desktop,
  };
});

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => (state.lang === 'zh' ? { t: zh, language: 'zh' } : { t: en, language: 'en' }),
}));

import { MeetingsView } from '../../../src/renderer/components/features/meetings/MeetingsView';

afterEach(() => { cleanup(); });

const emptyViewText = async (): Promise<string> => {
  const view = await screen.findByTestId('meetings-view');
  await waitFor(() => expect(view.textContent).not.toBe(''));
  return view.textContent ?? '';
};

describe('Meetings 空态文案按运行时区分', () => {
  it('Web · zh：说明「记这场会」需要桌面端并保留导入提示，不出现「+」指引', async () => {
    state.lang = 'zh';
    state.desktop = false;
    render(<MeetingsView />);
    const text = await emptyViewText();
    expect(text).toContain('还没有会议记录');
    expect(text).toContain('「记这场会」需要在桌面端使用');
    expect(text).toContain('从飞书妙记、腾讯会议导入');
    expect(document.body.textContent).not.toContain('「+」');
    expect(document.body.textContent).not.toContain('+ menu');
  });

  it('Web · en：desktop-app 说明 + 导入提示，不出现 "+ menu" 指引', async () => {
    state.lang = 'en';
    state.desktop = false;
    render(<MeetingsView />);
    const text = await emptyViewText();
    expect(text).toContain('No meetings yet');
    expect(text).toContain('“Record this meeting” is only available in the desktop app');
    expect(text).toContain('import from Feishu Minutes or Tencent Meeting');
    expect(document.body.textContent).not.toContain('+ menu');
    expect(document.body.textContent).not.toContain('「+」');
  });

  it('Desktop · zh：保留「+」菜单「记这场会」指引', async () => {
    state.lang = 'zh';
    state.desktop = true;
    render(<MeetingsView />);
    const text = await emptyViewText();
    expect(text).toContain('在对话输入框的「+」里点「记这场会」开始录');
    expect(text).toContain('从飞书妙记、腾讯会议导入');
  });

  it('Desktop · en：保留 "+ menu" 指引', async () => {
    state.lang = 'en';
    state.desktop = true;
    render(<MeetingsView />);
    const text = await emptyViewText();
    expect(text).toContain('Start one from “Record this meeting” in the + menu of the chat box');
    expect(text).toContain('import from Feishu Minutes or Tencent Meeting');
  });
});
