// @vitest-environment jsdom
// ============================================================================
// PermissionGrantList 授权时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// grantedOn/expiresOn 模板里的 {date} 改走 utils/formatDateTime(value, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
    off: vi.fn(),
  },
}));

import PermissionGrantList from '../../../src/renderer/components/features/settings/tabs/PermissionGrantList';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const GRANTED_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const EXPIRES_AT = new Date(2026, 10, 9, 17, 30, 0).getTime(); // 2026-11-09 17:30
const ZH = '2026/11/09 16:05';
const ZH_EXPIRES = '2026/11/09 17:30';
const EN = '11/9/2026, 4:05:00 PM';
const EN_EXPIRES = '11/9/2026, 5:30:00 PM';

function grantsPayload() {
  return [
    { id: 'grant-1', kind: 'app' as const, label: '应用 A', source: 'user', grantedAt: GRANTED_AT, expiresAt: EXPIRES_AT },
    { id: 'grant-2', kind: 'tool-session' as const, label: '工具 B', source: 'user', grantedAt: GRANTED_AT, expiresAt: null },
  ];
}

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockResolvedValue(grantsPayload());
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('PermissionGrantList 授权/有效期时间（跟随 UI language）', () => {
  it('zh UI：授权于/有效期至为 24 小时制带年份，无 AM/PM', async () => {
    const { container } = render(<PermissionGrantList />);
    // 行内 meta 用 {' · '} 分隔（多文本节点），断言走容器 textContent
    await waitFor(() => {
      expect(container.textContent).toContain(`授权于 ${ZH}`);
    });
    expect(container.textContent).toContain(`有效期至 ${ZH_EXPIRES}`);
    expect(container.textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    const { container } = render(<PermissionGrantList />);
    await waitFor(() => {
      expect(container.textContent).toContain(`Granted ${EN}`);
    });
    expect(container.textContent).toContain(`Valid until ${EN_EXPIRES}`);
    expect(container.textContent).not.toContain('16:05');
  });
});


describe('PermissionGrantList time-boxed tool grants', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 9, 16, 5, 0));
  });

  afterEach(() => vi.useRealTimers());

  async function renderTimedGrant(minutes: number | null, language: 'zh' | 'en' = 'zh', detail?: string) {
    useAppStore.setState({ language });
    invokeDomain.mockResolvedValue([{
      id: 'tool-timed-row', kind: 'tool-timed', label: '发送周报',
      source: minutes === null ? 'run' : '24h', grantedAt: GRANTED_AT,
      expiresAt: minutes === null ? null : GRANTED_AT + minutes * 60_000, detail,
    }]);
    const view = render(<PermissionGrantList />);
    const row = await view.findByTestId('permission-grant-row');
    return { ...view, row };
  }

  it.each([
    [121, '剩余 3 小时'],
    [60, '剩余 1 小时'],
    [42.1, '剩余 43 分钟'],
    [59.9, '剩余 60 分钟'],
    [0.1, '剩余 1 分钟'],
    [0, '剩余 1 分钟'],
  ])('zh remaining time at %s minutes: %s', async (minutes, expected) => {
    const { row } = await renderTimedGrant(minutes);
    expect(row.textContent).toContain('限时放行 · 24 小时内');
    expect(row.textContent).toContain(`授权于 ${ZH}`);
    expect(row.textContent).toContain(expected);
    expect(row.textContent).not.toContain('有效期至');
    expect(row.textContent).not.toContain('对象：');
  });

  it('run tier shows 本次任务 and target, with no expiry suffix when null', async () => {
    const { row } = await renderTimedGrant(null, 'zh', 'team@example.com');
    expect(row.textContent).toContain('限时放行 · 本次任务');
    expect(row.textContent).toContain('对象：team@example.com');
    expect(row.textContent).not.toMatch(/剩余|有效期至/);
  });

  it('24h tier also shows its target line', async () => {
    const { row } = await renderTimedGrant(121, 'zh', 'team@example.com');
    expect(row.textContent).toContain('对象：team@example.com');
  });

  it.each([[121, '3 h left'], [42.1, '43 min left']])('en remaining time at %s minutes: %s', async (minutes, expected) => {
    const { row } = await renderTimedGrant(minutes, 'en', 'team@example.com');
    expect(row.textContent).toContain('Time-boxed allow · 24 hours');
    expect(row.textContent).toContain(`Granted ${EN}`);
    expect(row.textContent).toContain(expected);
    expect(row.textContent).toContain('Target: team@example.com');
    expect(row.textContent).not.toContain('Valid until');
  });

  it('en run tier shows This task without a target or expiry suffix', async () => {
    const { row } = await renderTimedGrant(null, 'en');
    expect(row.textContent).toContain('Time-boxed allow · This task');
    expect(row.textContent).not.toMatch(/left|Valid until|Target:/);
  });

  it('revoke forwards the listed id and removes the row after host acknowledgement', async () => {
    const { getByTestId, queryByTestId } = await renderTimedGrant(121);
    invokeDomain.mockResolvedValue({ revoked: true });
    fireEvent.click(getByTestId('permission-grant-revoke'));
    await waitFor(() => expect(queryByTestId('permission-grant-row')).toBeNull());
    expect(invokeDomain).toHaveBeenLastCalledWith('domain:settings', 'revokePermissionGrant', { id: 'tool-timed-row' });
  });
});


describe('PermissionGrantList human tool names', () => {
  it.each(['zh', 'en'] as const)('%s labels all tool grant kinds through the shared human-label layer', async (language) => {
    useAppStore.setState({ language });
    invokeDomain.mockResolvedValue([
      { id: 'run', kind: 'tool-timed', label: 'Bash', source: 'run', grantedAt: GRANTED_AT, expiresAt: null },
      { id: 'day', kind: 'tool-timed', label: 'mail_send', source: '24h', grantedAt: GRANTED_AT, expiresAt: Date.now() + 121 * 60_000 },
      { id: 'write', kind: 'tool-session', label: 'Write', source: 'conversation', grantedAt: GRANTED_AT, expiresAt: null },
      { id: 'edit', kind: 'tool-target', label: 'Edit', source: '周报', detail: 'summary.md', grantedAt: GRANTED_AT, expiresAt: null },
    ]);
    const view = render(<PermissionGrantList />);
    const rows = await view.findAllByTestId('permission-grant-row');
    expect(rows).toHaveLength(4);
    const names = language === 'zh'
      ? ['运行命令', '邮件', '写入文件', '编辑文件']
      : ['Run command', 'Mail', 'Write file', 'Edit file'];
    for (const [index, name] of names.entries()) {
      expect(rows[index].querySelector('.text-sm')?.textContent).toBe(name);
      expect(rows[index].textContent).not.toMatch(/Bash|mail_send/);
      expect(['Bash', 'mail_send', 'Write', 'Edit']).not.toContain(rows[index].querySelector('.text-sm')?.textContent);
    }
    expect(rows[0].textContent).toContain(language === 'zh' ? '本次任务' : 'This task');
    expect(rows[1].textContent).toContain(language === 'zh' ? '24 小时内' : '24 hours');
  });

  it.each(['zh', 'en'] as const)('%s preserves app labels even when they match an internal tool name', async (language) => {
    useAppStore.setState({ language });
    invokeDomain.mockResolvedValue([
      { id: 'app', kind: 'app', label: 'Bash', source: 'settings', grantedAt: GRANTED_AT, expiresAt: EXPIRES_AT },
    ]);
    const view = render(<PermissionGrantList />);
    const row = await view.findByTestId('permission-grant-row');
    expect(row.querySelector('.text-sm')?.textContent).toBe('Bash');
    expect(row.textContent).toContain(language === 'zh' ? `有效期至 ${ZH_EXPIRES}` : `Valid until ${EN_EXPIRES}`);
  });
});


describe('PermissionGrantList connector read grants', () => {
  it.each(['zh', 'en'] as const)('%s shows connector name, read-only scope, remaining time and revokes by stable id', async (language) => {
    useAppStore.setState({ language });
    invokeDomain.mockResolvedValue([{
      id: 'tool-24h:connector-read%3Alark', kind: 'tool-timed', label: '飞书', connectorAccess: 'read',
      source: '24h', grantedAt: Date.now(), expiresAt: Date.now() + 121 * 60_000,
    }]);
    const view = render(<PermissionGrantList />);
    const row = await view.findByTestId('permission-grant-row');
    expect(row.querySelector('.text-sm')?.textContent).toBe('飞书');
    expect(row.textContent).toContain(language === 'zh' ? '只读' : 'Read-only');
    expect(row.textContent).toContain(language === 'zh' ? '剩余 3 小时' : '3 h left');
    invokeDomain.mockResolvedValue({ revoked: true });
    fireEvent.click(view.getByTestId('permission-grant-revoke'));
    await waitFor(() => expect(view.queryByTestId('permission-grant-row')).toBeNull());
    expect(invokeDomain).toHaveBeenLastCalledWith('domain:settings', 'revokePermissionGrant', { id: 'tool-24h:connector-read%3Alark' });
  });
});
