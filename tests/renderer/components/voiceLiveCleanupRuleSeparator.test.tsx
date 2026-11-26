// @vitest-environment jsdom
// ============================================================================
// VoiceLiveSettingsSection 录音台账「最近清理」行：几个触发原因之间的分隔符跟随界面语言。
// 英文界面用英文逗号，中文界面用顿号；分隔符取自共享标点包，组件里不写死「、」。
// 和 voiceLiveLastCleanupTimeFormat.test.tsx 走同一个公开入口（组件 + 打桩的 IPC）。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomainMock = vi.fn();
const availability = {
  enabled: true,
  configured: true,
  usage: { monthSeconds: 0, monthCalls: 0, monthFailedAttempts: 0 } as import('../../../src/shared/contract/voice').VoiceStatusResponse['usage'],
};

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
    on: () => () => {},
    off: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/components/features/voice/useVoiceLiveAvailability', () => ({
  useVoiceLiveAvailability: () => availability,
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { VoiceLiveSettingsSection } from '../../../src/renderer/components/features/settings/tabs/VoiceLiveSettingsSection';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { voiceEn, voiceZh } from '../../../src/renderer/i18n/voice';

// 三条清理规则都触发过，所以这一行里会出现两个分隔符。
const OVERVIEW = {
  dir: '/tmp/voice-recordings',
  count: 6,
  totalBytes: 6 * 1024 * 1024,
  lastCleanup: {
    at: new Date(2026, 10, 9, 16, 5, 0).getTime(), // 2026-11-09 16:05
    deleted: 6,
    freedBytes: 1024 * 1024,
    byRule: { age: 2, count: 3, bytes: 1 },
  },
  limits: { retentionDays: 30, maxBytes: 0, maxCalls: 0 },
};

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

beforeEach(() => {
  invokeDomainMock.mockReset();
  invokeDomainMock.mockImplementation((_domain: string, action: string) =>
    action === 'recordingOverview' ? Promise.resolve(OVERVIEW) : Promise.resolve(undefined));
  useAppStore.setState({ language: 'zh' });
  (navigator as unknown as { mediaDevices?: unknown }).mediaDevices = {
    enumerateDevices: vi.fn(() => Promise.resolve([])),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
});

describe('VoiceLiveSettingsSection 录音「最近清理」行的原因分隔符跟随界面语言', () => {
  it('英文界面：几个原因用英文逗号分隔，整行不含中文和中文标点', async () => {
    useAppStore.setState({ language: 'en' });
    render(<VoiceLiveSettingsSection />);
    const line = await screen.findByTestId('call-recording-cleanup');
    await waitFor(() => expect(line.textContent).toContain('(triggered by: '));
    expect(line.textContent).toContain(
      [voiceEn.voice.settings.recordCallsRuleAge, voiceEn.voice.settings.recordCallsRuleCount, voiceEn.voice.settings.recordCallsRuleBytes].join(', '),
    );
    expect(line.textContent).not.toMatch(CJK);
  });

  it('中文界面：几个原因用顿号分隔', async () => {
    render(<VoiceLiveSettingsSection />);
    const line = await screen.findByTestId('call-recording-cleanup');
    await waitFor(() => expect(line.textContent).toContain('（触发：'));
    expect(line.textContent).toContain(
      [voiceZh.voice.settings.recordCallsRuleAge, voiceZh.voice.settings.recordCallsRuleCount, voiceZh.voice.settings.recordCallsRuleBytes].join('、'),
    );
  });
});
