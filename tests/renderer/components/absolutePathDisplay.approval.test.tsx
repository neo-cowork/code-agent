// @vitest-environment jsdom
// 审批卡（PermissionCard 入口）：
// - 工作区内 ./相对（且只相对该请求所属会话自己的工作目录，不借用其他会话目录）
// - 宿主真实家目录下 ~/…（他人账户或真实家目录未知时绝不折 ~）
// - 其余系统/外置卷/共享目录路径在可见文字、title、后果句三处保持完整绝对路径，永不缩成 parent/file
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
const appState = vi.hoisted(() => ({
  workingDirectory: '/Users/alice/projects/report' as string | null,
  hostHomeDir: '/Users/alice' as string | null,
}));
const sessionState = vi.hoisted(() => ({
  currentSessionId: 'session-current' as string | null,
  sessions: [
    { id: 'session-current', workingDirectory: '/Users/alice/projects/report' as string | null },
  ] as Array<{ id: string; workingDirectory?: string | null }>,
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: i18nState.language === 'en' ? en : zh, language: i18nState.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    developerMode: false,
    workingDirectory: appState.workingDirectory,
    hostHomeDir: appState.hostHomeDir,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const usedIds: string[] = [];

function makeRequest(
  overrides: Partial<PermissionRequest> & { id: string; details: PermissionRequest['details'] },
): PermissionRequest {
  usedIds.push(overrides.id);
  return {
    sessionId: 'session-current',
    tool: 'Read',
    type: 'file_read',
    timestamp: 1,
    ...overrides,
  };
}

function openCard(request: PermissionRequest, sessionIdOverride: string | null = 'session-current') {
  render(<PermissionCard requestOverride={request} sessionIdOverride={sessionIdOverride} />);
  const detailsBtn = screen.queryByRole('button', { name: /详情|details/i });
  if (detailsBtn) fireEvent.click(detailsBtn);
  return screen.getByTestId('permission-card');
}

beforeEach(() => {
  appState.workingDirectory = '/Users/alice/projects/report';
  appState.hostHomeDir = '/Users/alice';
  sessionState.currentSessionId = 'session-current';
  sessionState.sessions = [
    { id: 'session-current', workingDirectory: '/Users/alice/projects/report' },
  ];
});

afterEach(() => {
  cleanup();
  while (usedIds.length > 0) releaseApprovalResponse(usedIds.pop()!);
});

const REVIEW_TABLE_CASES: Array<[string, string]> = [
  ['/etc/ssh/sshd_config', '/etc/ssh/sshd_config'],
  ['/etc/sudoers.d/neo', '/etc/sudoers.d/neo'],
  ['/Library/LaunchDaemons/com.x.plist', '/Library/LaunchDaemons/com.x.plist'],
  ['/Users/Shared/drop/.ssh/authorized_keys', '/Users/Shared/drop/.ssh/authorized_keys'],
  ['/Volumes/Backup/Documents/report.docx', '/Volumes/Backup/Documents/report.docx'],
  ['/tmp/evil/Documents/report.docx', '/tmp/evil/Documents/report.docx'],
  ['/Users/bob/.ssh/authorized_keys', '/Users/bob/.ssh/authorized_keys'],
  ['.ssh/authorized_keys', '.ssh/authorized_keys'],
];

const LONG_SYSTEM_PATH = '/Library/Application Support/com.example.vendor/LaunchDaemons/helpers/tools/com.example.helper.plist';

describe.each(['zh', 'en'] as const)('审批卡路径口径 (%s)', (language) => {
  it.each(REVIEW_TABLE_CASES)('工作区与真实家目录外保留完整位置：%s -> %s', (inputPath, expected) => {
    i18nState.language = language;
    const card = openCard(makeRequest({ id: `table-${language}-${inputPath}`, details: { path: inputPath } }));
    const row = card.querySelector(`[title="${expected}"]`);
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe(expected);
    const titles = Array.from(card.querySelectorAll('[title]')).map((el) => el.getAttribute('title'));
    expect(titles).toEqual([expected]);
    expect(row!.textContent).not.toMatch(/^~\//);
  });

  it('宿主真实家目录下路径折成 ~/…，且卡上不含 /Users/alice', () => {
    i18nState.language = language;
    const card = openCard(makeRequest({ id: `home-${language}`, details: { path: '/Users/alice/Documents/a.txt' } }));
    expect(card.innerHTML).not.toContain('/Users/');
    const row = card.querySelector('[title="~/Documents/a.txt"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe('~/Documents/a.txt');
  });

  it('真实家目录未知时绝不折 ~', () => {
    i18nState.language = language;
    appState.hostHomeDir = null;
    const card = openCard(makeRequest({ id: `home-unknown-${language}`, details: { path: '/Users/alice/Documents/a.txt' } }));
    const row = card.querySelector('[title="/Users/alice/Documents/a.txt"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe('/Users/alice/Documents/a.txt');
    expect(row!.textContent).not.toContain('~/');
  });

  it('当前请求工作区内路径显示为 ./相对，文件行与后果句一致', () => {
    i18nState.language = language;
    const card = openCard(makeRequest({
      id: `ws-write-${language}`,
      tool: 'Write',
      type: 'file_write',
      boundary: { id: 'file.project_write' },
      details: { path: '/Users/alice/projects/report/src/app.ts' },
    }));
    const row = card.querySelector('[title="./src/app.ts"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe('./src/app.ts');
    expect(screen.getByTestId('permission-consequence').textContent).toContain('./src/app.ts');
  });

  it('Write /etc/ssh/sshd_config：同卡后果句、文件行文字与 title 三处一致保留完整路径', () => {
    i18nState.language = language;
    const card = openCard(makeRequest({
      id: `write-etc-${language}`,
      tool: 'Write',
      type: 'file_write',
      boundary: { id: 'file.external_write' },
      details: { path: '/etc/ssh/sshd_config' },
    }));
    const consequence = screen.getByTestId('permission-consequence').textContent ?? '';
    expect(consequence).toContain('/etc/ssh/sshd_config');
    const row = card.querySelector('[title="/etc/ssh/sshd_config"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe('/etc/ssh/sshd_config');
  });

  it('Write 他人账户 /Users/bob/.ssh/authorized_keys：后果句、文件行与 title 都不折成 ~', () => {
    i18nState.language = language;
    const card = openCard(makeRequest({
      id: `write-bob-${language}`,
      tool: 'Write',
      type: 'file_write',
      boundary: { id: 'file.external_write' },
      details: { path: '/Users/bob/.ssh/authorized_keys' },
    }));
    const consequence = screen.getByTestId('permission-consequence').textContent ?? '';
    expect(consequence).toContain('/Users/bob/.ssh/authorized_keys');
    expect(consequence).not.toContain('~/.ssh/authorized_keys');
    const row = card.querySelector('[title="/Users/bob/.ssh/authorized_keys"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe('/Users/bob/.ssh/authorized_keys');
  });

  it('超过 60 字符的系统路径：文件行可见文字与 title 均保留完整绝对路径，不截断也不退化', () => {
    i18nState.language = language;
    expect(LONG_SYSTEM_PATH.length).toBeGreaterThan(60);
    const card = openCard(makeRequest({ id: `long-sys-${language}`, details: { path: LONG_SYSTEM_PATH } }));
    const row = card.querySelector(`[title="${LONG_SYSTEM_PATH}"]`);
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe(LONG_SYSTEM_PATH);
  });

  it('工作区内写、工作目录未知、四段超长路径（Linux 临时目录形状）：后果句省掉中段，文件行仍给完整路径', () => {
    i18nState.language = language;
    appState.workingDirectory = null;
    sessionState.sessions = [];
    const dir = '/tmp/code-agent-vitest-run-N0Avis/quiet-new-file-CeZgRb';
    const target = `${dir}/contract-notes.md`;
    const card = openCard(makeRequest({
      id: `ws-write-short-root-${language}`,
      tool: 'Write',
      type: 'file_write',
      boundary: { id: 'file.project_write' },
      details: { path: target },
    }));
    const consequence = screen.getByTestId('permission-consequence').textContent ?? '';
    expect(consequence).toContain('/tmp/…/quiet-new-file-CeZgRb/contract-notes.md');
    expect(consequence).not.toContain(dir);
    const row = card.querySelector(`[title="${target}"]`);
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe(target);
  });
});

describe('Gap C：审批卡相对路径只认请求所属会话的工作目录，不借用 UI 当前会话目录', () => {
  it('会话 B 的请求在 UI 停留在会话 A（工作目录为 A）时渲染：A 目录下的文件绝不显示为 ./…', () => {
    i18nState.language = 'zh';
    sessionState.currentSessionId = 'session-A';
    appState.workingDirectory = '/Users/alice/projects/A';
    sessionState.sessions = [
      { id: 'session-A', workingDirectory: '/Users/alice/projects/A' },
      { id: 'session-B', workingDirectory: '/Users/alice/projects/B' },
    ];
    // 模拟 global 队列（sessionIdOverride=null）把会话 B 的请求弹在会话 A 窗口上
    const card = openCard(makeRequest({
      id: 'cross-session-B-target-A',
      sessionId: 'session-B',
      tool: 'Write',
      type: 'file_write',
      boundary: { id: 'file.external_write' },
      details: { path: '/Users/alice/projects/A/secret.txt' },
    }), null);
    const row = card.querySelector('[title="~/projects/A/secret.txt"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe('~/projects/A/secret.txt');
    expect(card.textContent).not.toContain('./secret.txt');
  });

  it('归属会话不在列表里且非当前会话（或无 sessionId）时不做相对化', () => {
    i18nState.language = 'en';
    sessionState.currentSessionId = 'session-A';
    appState.workingDirectory = '/Users/alice/projects/A';
    sessionState.sessions = [{ id: 'session-A', workingDirectory: '/Users/alice/projects/A' }];
    const card = openCard(makeRequest({
      id: 'unknown-session-target-A',
      sessionId: undefined,
      tool: 'Read',
      type: 'file_read',
      details: { path: '/Users/alice/projects/A/secret.txt' },
    }), null);
    const row = card.querySelector('[title="~/projects/A/secret.txt"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe('~/projects/A/secret.txt');
    expect(card.textContent).not.toContain('./secret.txt');
  });
});
