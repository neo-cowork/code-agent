// @vitest-environment jsdom
// FB-2387：输入框里 ⌘A 后粘贴 / 删除 / 剪切，只改文字，已上传的附件 chip 不许被连带清掉。
import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useToast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/hooks/useToast')>()),
  toast: { show: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: vi.fn().mockResolvedValue([]),
  getSessionPin: vi.fn().mockResolvedValue({ itemIds: [] }),
  setSessionPin: vi.fn(),
}));
vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
  getProjectArtifacts: vi.fn().mockResolvedValue([]),
}));

import { ChatInput, type ChatInputHandle } from '../../../src/renderer/components/features/chat/ChatInput';

const FILE: MessageAttachment = {
  id: 'att-actions', type: 'file', category: 'text', name: 'actions.txt',
  size: 12, mimeType: 'text/plain', data: 'ship the fix',
};
const REMOVE_NAME = zh.chatInput.attachRemoveAria.replace('{name}', FILE.name);
const NEW_TEXT = 'Read the attached file and list its action items';

afterEach(() => { cleanup(); localStorage.clear(); });

function editor(): HTMLElement { return screen.getByTestId('chat-composer-textarea'); }
function chipMounts(): Element[] { return Array.from(editor().querySelectorAll('[data-composer-chip-key^="file:"]')); }
function plainText(): string { return editor().getAttribute('data-plain-text') ?? ''; }

function setup() {
  const onSend = vi.fn<(envelope: ConversationEnvelope) => Promise<boolean>>().mockResolvedValue(true);
  const ref = createRef<ChatInputHandle>();
  render(<ChatInput ref={ref} onSend={onSend} />);
  act(() => { ref.current!.addAttachments([FILE]); });
  return { onSend };
}

async function withDraft(text = 'First draft 80709') {
  const ctx = setup();
  await waitFor(() => expect(chipMounts()).toHaveLength(1));
  const root = editor();
  root.insertBefore(document.createTextNode(text), root.firstChild);
  fireEvent.input(root);
  expect(plainText()).toBe(text);
  return ctx;
}

function selectAll() {
  const range = document.createRange();
  range.selectNodeContents(editor());
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function paste(text: string) {
  fireEvent.paste(editor(), {
    clipboardData: { items: [], getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
}

/** jsdom 没有原生编辑：用 Range.deleteContents 复现浏览器对 ⌘A+Delete / 剪切的 DOM 结果。 */
function deleteSelection() {
  window.getSelection()!.getRangeAt(0).deleteContents();
  fireEvent.input(editor());
}

async function expectAttached() {
  await waitFor(() => expect(chipMounts()).toHaveLength(1));
  expect(screen.getByRole('button', { name: REMOVE_NAME })).toBeTruthy();
}

async function sendAndGetEnvelope(onSend: ReturnType<typeof setup>['onSend']) {
  fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 13 });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0];
}

describe('⌘A 后文本编辑不丢附件', () => {
  it('⌘A + 粘贴：文字被替换，附件仍在并随信封发出', async () => {
    const { onSend } = await withDraft();
    selectAll();
    paste(NEW_TEXT);
    await expectAttached();
    expect(plainText()).toBe(NEW_TEXT);
    const envelope = await sendAndGetEnvelope(onSend);
    expect(envelope.content).toBe(NEW_TEXT);
    expect(envelope.attachments?.map((a) => a.id)).toEqual([FILE.id]);
  });

  it('⌘A + Delete：文字清空，附件仍在并随信封发出', async () => {
    const { onSend } = await withDraft();
    selectAll();
    deleteSelection();
    await expectAttached();
    expect(plainText()).toBe('');
    // 再输入一句后发送
    const root = editor();
    root.insertBefore(document.createTextNode('看一下附件'), root.firstChild);
    fireEvent.input(root);
    const envelope = await sendAndGetEnvelope(onSend);
    expect(envelope.attachments?.map((a) => a.id)).toEqual([FILE.id]);
  });

  it('⌘A + 剪切：文字被剪走，附件仍在', async () => {
    await withDraft();
    selectAll();
    fireEvent.cut(editor());
    deleteSelection();
    await expectAttached();
    expect(plainText()).toBe('');
  });

  it('粘贴之后再次 ⌘A + 粘贴：附件仍只有一份', async () => {
    await withDraft();
    selectAll();
    paste('第二版');
    selectAll();
    paste(NEW_TEXT);
    await expectAttached();
    expect(plainText()).toBe(NEW_TEXT);
  });

  it('⌘A + 粘贴与原草稿完全相同的文字（值不变）：附件挂载点也补回', async () => {
    await withDraft('same draft');
    selectAll();
    paste('same draft');
    await expectAttached();
    expect(plainText()).toBe('same draft');
  });

  it('⌘A + 粘贴后 ⌘Z：浏览器把 DOM 还原成不含 chip 的旧状态，附件仍恰好一份并随信封发出', async () => {
    const { onSend } = await withDraft();
    selectAll();
    paste(NEW_TEXT);
    await expectAttached();
    // 原生撤销：keydown(Meta+z) → beforeinput(historyUndo) → DOM 回到旧文本（旧快照里没有 chip）→ input
    fireEvent.keyDown(editor(), { key: 'z', metaKey: true });
    fireEvent(editor(), new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true }));
    editor().replaceChildren(document.createTextNode('First draft 80709'));
    fireEvent.input(editor(), { inputType: 'historyUndo' });
    await expectAttached();
    expect(chipMounts()).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: REMOVE_NAME })).toHaveLength(1);
    expect(plainText()).toBe('First draft 80709');
    const envelope = await sendAndGetEnvelope(onSend);
    expect(envelope.attachments?.map((a) => a.id)).toEqual([FILE.id]);
  });

  it('对照：点「移除附件」按钮仍然移除', async () => {
    await withDraft();
    fireEvent.click(screen.getByRole('button', { name: REMOVE_NAME }));
    await waitFor(() => expect(chipMounts()).toHaveLength(0));
    expect(screen.queryByRole('button', { name: REMOVE_NAME })).toBeNull();
  });

  it('对照：光标紧贴 chip 之后按 Backspace 仍然移除附件', async () => {
    await withDraft('');
    const mount = chipMounts()[0];
    const range = document.createRange();
    range.setStartAfter(mount);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    await waitFor(() => expect(chipMounts()).toHaveLength(0));
    expect(screen.queryByRole('button', { name: REMOVE_NAME })).toBeNull();
  });
});
