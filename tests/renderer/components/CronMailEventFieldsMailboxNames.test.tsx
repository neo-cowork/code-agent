// @vitest-environment jsdom
// 「监听邮箱」下拉的显示名：中文界面把 Mail 的英文系统邮箱（Sent Messages / Deleted Messages /
// Junk …）说成中文，服务商中文名和用户自建文件夹原样；英文界面全部原样。
// 选项的 value 始终是连接器给的原名——保存下去的绑定不能被显示名改掉。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { CronMailEventFields } from '../../../src/renderer/components/features/cron/CronMailEventFields';

const ACCOUNT = '163 · 艾达';
const MAILBOXES = ['INBOX', '广告邮件', '草稿箱', 'Sent Messages', 'Deleted Messages', 'Junk', 'Receipts'];

/** cron:listMailSources 的域 IPC 桩（cronClient 走 window.domainAPI），同 CronJobEditorEventErrorTab。 */
function stubMailSources(mailboxes: string[]): void {
  (window as unknown as { domainAPI?: unknown }).domainAPI = {
    invoke: async () => ({
      success: true,
      data: { ok: true, accounts: [{ name: ACCOUNT }], mailboxesByAccount: { [ACCOUNT]: mailboxes } },
    }),
  };
}

async function renderFields(onMailboxChange = vi.fn()): Promise<HTMLSelectElement> {
  render(
    <CronMailEventFields
      accountId={ACCOUNT}
      mailbox=""
      onAccountChange={vi.fn()}
      onMailboxChange={onMailboxChange}
      maxRunBudget="0.5"
      onBudgetChange={vi.fn()}
      violation={null}
    />,
  );
  const select = document.querySelector('#cron-event-mailbox') as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  return select;
}

const optionsOf = (select: HTMLSelectElement) =>
  Array.from(select.options).map((option) => ({ value: option.value, label: option.textContent }));

beforeEach(() => {
  stubMailSources(MAILBOXES);
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
  useAppStore.setState({ language: 'zh' });
});

describe('CronMailEventFields 监听邮箱下拉的显示名', () => {
  it('zh：系统邮箱只显示中文名，服务商中文名和自建文件夹原样，value 是原名', async () => {
    useAppStore.setState({ language: 'zh' });
    const select = await renderFields();
    expect(optionsOf(select)).toEqual([
      { value: '', label: '收件箱（默认）' },
      { value: '广告邮件', label: '广告邮件' },
      { value: '草稿箱', label: '草稿箱' },
      { value: 'Sent Messages', label: '已发送' },
      { value: 'Deleted Messages', label: '已删除' },
      { value: 'Junk', label: '垃圾邮件' },
      { value: 'Receipts', label: 'Receipts' },
    ]);
    const labels = optionsOf(select).map((option) => option.label).join('|');
    expect(labels).not.toMatch(/INBOX|Sent Messages|Deleted Messages|Junk/);
  });

  it('zh：选中译名项时交出去的是原名', async () => {
    useAppStore.setState({ language: 'zh' });
    const onMailboxChange = vi.fn();
    const select = await renderFields(onMailboxChange);
    fireEvent.change(select, { target: { value: 'Junk' } });
    expect(onMailboxChange).toHaveBeenCalledWith('Junk');
  });

  it('zh：译名和账号里另一个邮箱重名时，译出的那项带上原名', async () => {
    useAppStore.setState({ language: 'zh' });
    stubMailSources(['INBOX', '垃圾邮件', 'Junk', 'Sent Messages']);
    const select = await renderFields();
    expect(optionsOf(select)).toEqual([
      { value: '', label: '收件箱（默认）' },
      { value: '垃圾邮件', label: '垃圾邮件' },
      { value: 'Junk', label: '垃圾邮件（Junk）' },
      { value: 'Sent Messages', label: '已发送' },
    ]);
  });

  it('en：全部保持连接器给的原名', async () => {
    useAppStore.setState({ language: 'en' });
    const select = await renderFields();
    expect(optionsOf(select)).toEqual([
      { value: '', label: 'INBOX (inbox, default)' },
      { value: '广告邮件', label: '广告邮件' },
      { value: '草稿箱', label: '草稿箱' },
      { value: 'Sent Messages', label: 'Sent Messages' },
      { value: 'Deleted Messages', label: 'Deleted Messages' },
      { value: 'Junk', label: 'Junk' },
      { value: 'Receipts', label: 'Receipts' },
    ]);
  });
});
