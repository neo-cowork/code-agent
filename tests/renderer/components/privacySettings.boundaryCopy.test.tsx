// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const openExternalLink = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
  openExternalLink,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

import PrivacySettings from '../../../src/renderer/components/features/settings/tabs/PrivacySettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('PrivacySettings boundary copy', () => {
  it('renders privacy boundary, voice paths and auth inventory without raw secrets', () => {
    const html = renderToStaticMarkup(
      React.createElement(PrivacySettings, { onNavigateSettings: vi.fn() }),
    );

    for (const text of [
      '桌面采集与控制',
      '语音和转写',
      '外部通道',
      'MCP 和插件',
      '模型服务和密钥',
      'Memory',
      '遥测和诊断包',
      '聊天语音输入',
      'Voice Paste',
      'MCP OAuth 授权',
      '浏览器 Relay Token',
      '第三方界面插件',
      '允许第三方插件显示界面',
      '权限和 Neo 本身一样大',
      '查看数据流与能力边界说明',
    ]) {
      expect(html).toContain(text);
    }

    expect(html).not.toContain('sk-proj-');
    expect(html).not.toContain('bot-token');
    expect(html).not.toContain('appSecret=');
  });

  it('English UI: voice transcription and credential cards carry no Chinese text or punctuation', () => {
    // renderToStaticMarkup 读的是 store 的初始快照（中文），切语言要走客户端渲染
    HTMLElement.prototype.scrollIntoView = vi.fn();
    useAppStore.setState({ language: 'en' });
    const view = render(React.createElement(PrivacySettings, { onNavigateSettings: vi.fn() }));
    try {
      const html = view.container.innerHTML;
      for (const text of [
        'Chat voice input',
        'Desktop or meeting audio',
        'Channel voice messages',
        'Local whisper-cpp, Groq Whisper, Zhipu/Kimi post-processing',
        'Model provider API keys',
        'OpenAI, Anthropic, Groq, Moonshot, Zhipu',
        'Browser relay token',
      ]) {
        expect(html).toContain(text);
      }
      const visible = html.replace(/<[^>]+>/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
      const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;
      expect(visible.filter((line) => cjk.test(line))).toEqual([]);
    } finally {
      view.unmount();
      useAppStore.setState({ language: 'zh' });
    }
  });

  it('中文界面：语音转写和凭证卡片的原文与顿号不变', () => {
    const html = renderToStaticMarkup(
      React.createElement(PrivacySettings, { onNavigateSettings: vi.fn() }),
    );
    for (const text of [
      '按住或点击聊天输入框里的语音按钮。',
      '本地 whisper-cpp、Groq Whisper、智谱/Kimi 后处理',
      '日志只记录 size、mimeType、duration、错误码，不记录转写正文。',
      'OpenAI、Anthropic、Groq、Moonshot、Zhipu',
      '诊断包和日志必须脱敏 provider key。',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('opens the public NOTICE page through the platform helper', () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    render(React.createElement(PrivacySettings, { onNavigateSettings: vi.fn() }));
    const link = screen.getByRole('link', { name: '查看数据流与能力边界说明' });
    fireEvent.click(link);
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://github.com/neo-cowork/code-agent/blob/main/docs/NOTICE.md',
    );
  });
});
