// @vitest-environment jsdom
// N-FIX-COMPOSER-SELECT-ALL-PASTE-DROPS-REFS：输入框里 ⌘A 后粘贴 / 删除 / 剪切只改文字，
// skill / library / session / artifact 四类引用 chip 不许被连带清掉（attachment 前例同款）。
// 引用不按 DOM 在场与否裁剪（原实现会静默丢掉用户摆进来的引用，还随信封发给模型）；
// 显式删除入口不变：chip × 按钮 / Backspace·Delete 紧贴 chip → handleRemoveInlineChip。
// 对照组钉住 pendingCommand 仍按 DOM 在场裁剪的既有行为（本单范围外）。
import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { zh } from '../../../src/renderer/i18n/zh';

const mocks = vi.hoisted(() => ({
  listLibraryItems: vi.fn(),
  getSessionPin: vi.fn(),
  setSessionPin: vi.fn(),
  listProjects: vi.fn(),
  getProjectArtifacts: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useToast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/hooks/useToast')>()),
  toast: { show: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: mocks.listLibraryItems,
  getSessionPin: mocks.getSessionPin,
  setSessionPin: mocks.setSessionPin,
}));
vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: mocks.listProjects,
  getProjectArtifacts: mocks.getProjectArtifacts,
}));

import { ChatInput, type ChatInputHandle } from '../../../src/renderer/components/features/chat/ChatInput';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { LibraryItem } from '../../../src/shared/contract/library';

const SKILL_ID = 'weekly-report';
const LIB_ITEM_ID = 'lib-notes';
const LIB_ITEM_TITLE = '本周笔记';
const PAST_SESSION_ID = 'past-1';
const PAST_SESSION_TITLE = '历史设计';
const ARTIFACT_ID = 'art-1';
const ARTIFACT_NAME = '方案.html';
const CURRENT_SESSION_ID = 'session-1';
const NEW_TEXT = "Summarize this week's notes into 3 bullet points";

const CURRENT_SESSION = {
  id: CURRENT_SESSION_ID,
  title: '当前会话',
  projectId: 'proj-1',
  modelConfig: {},
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
} as unknown as SessionWithMeta;

function libraryItem(id: string, title: string): LibraryItem {
  return { id, projectId: 'proj-1', title, kind: 'upload', pathOrUri: `/lib/${id}.md`, tags: [], createdAt: 0, updatedAt: 0 };
}

beforeEach(() => {
  // jsdom 未实现 scrollIntoView；面板高亮行的滚动跟随只需不炸（同 atMentionPanel.test.tsx）
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  useSessionStore.setState({ currentSessionId: CURRENT_SESSION_ID, sessions: [CURRENT_SESSION] });
  useAppStore.setState({ workingDirectory: null });
  useComposerStore.setState({
    selectedSkillIds: [],
    selectedConnectorIds: [],
    selectedMcpServerIds: [],
    turnCapabilityScopeMode: 'auto',
    pendingPinItemIds: [],
    pendingCommand: null,
  });
  // library pin 真源在本会话（getSessionPin）；资料库条目解析出 chip 标题
  mocks.listLibraryItems.mockResolvedValue([libraryItem(LIB_ITEM_ID, LIB_ITEM_TITLE)]);
  mocks.getSessionPin.mockResolvedValue({ sessionId: CURRENT_SESSION_ID, itemIds: [LIB_ITEM_ID] });
  mocks.setSessionPin.mockReset();
  mocks.setSessionPin.mockResolvedValue({ sessionId: CURRENT_SESSION_ID, itemIds: [] });
  mocks.listProjects.mockResolvedValue([{ id: 'proj-1', name: 'Neo 项目' }]);
  mocks.getProjectArtifacts.mockResolvedValue([
    { id: ARTIFACT_ID, sessionId: PAST_SESSION_ID, sessionTitle: PAST_SESSION_TITLE, kind: 'generic_html', title: ARTIFACT_NAME, createdAt: 3 },
  ]);
  // @ 面板生产路径要的 IPC：会话清单（session 行）+ 空 agent 树快照（SessionMemberBar
  // 轮询 getTree，data 缺 summary 会炸）+ 托管浏览器会话空态（refresh 读
  // getManagedBrowserSession，data:null 会把 managedSession 置 null 炸掉）。
  // 其余 IPC 一律 success:false → ipcService 抛错，走各读方自己的 catch 空值兜底。
  (window as { domainAPI?: unknown }).domainAPI = {
    invoke: vi.fn().mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'list') {
        return Promise.resolve({
          success: true,
          data: [{ id: PAST_SESSION_ID, title: PAST_SESSION_TITLE, projectId: 'proj-1', modelConfig: {}, createdAt: 1, updatedAt: 2, messageCount: 3 }],
        });
      }
      if (domain === IPC_DOMAINS.AGENT && action === 'getTree') {
        return Promise.resolve({
          success: true,
          data: {
            generatedAt: 0,
            roots: [],
            nodes: [],
            summary: { total: 0, running: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, withWorktree: 0, ownershipConflicts: [] },
          },
        });
      }
      if (domain === IPC_DOMAINS.DESKTOP && action === 'getManagedBrowserSession') {
        return Promise.resolve({ success: true, data: { running: false, sessionId: null } });
      }
      if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') {
        return Promise.resolve({ success: true, data: [] });
      }
      return Promise.resolve({ success: false, error: { code: 'NOT_MOCKED', message: 'not mocked in test' } });
    }),
  };
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: [], currentSessionId: null });
  useAppStore.setState({ workingDirectory: null });
});

function editor(): HTMLElement { return screen.getByTestId('chat-composer-textarea'); }
function chipMounts(prefix: string): Element[] {
  return Array.from(editor().querySelectorAll(`[data-composer-chip-key^="${prefix}"]`));
}
function plainText(): string { return editor().getAttribute('data-plain-text') ?? ''; }
function popover(): HTMLElement | null { return document.querySelector('[data-at-mention-popover]'); }

function setup() {
  // skill 走生产入口：composerStore.setSelectedSkillIds（slash 面板选中即调它）
  act(() => { useComposerStore.getState().setSelectedSkillIds([SKILL_ID]); });
  const onSend = vi.fn<(envelope: ConversationEnvelope) => Promise<boolean>>().mockResolvedValue(true);
  const ref = createRef<ChatInputHandle>();
  render(<ChatInput ref={ref} onSend={onSend} />);
  return { onSend, ref };
}

/** library 经 usePinnedLibraryItems(getSessionPin) 生产路径装载；skill 由 store 动作补挂载点。 */
async function seedStoreChips() {
  await waitFor(() => expect(chipMounts('skill:')).toHaveLength(1));
  await waitFor(() => expect(chipMounts('library:')).toHaveLength(1));
}

/** session / artifact 经 @ 面板生产路径：输入 @ → AtMentionPopover 出行 → 点行选中。 */
async function selectAtMentionRow(rowLabel: string) {
  const root = editor();
  root.insertBefore(document.createTextNode('@'), root.firstChild);
  fireEvent.input(root);
  // 面板 200ms 防抖后打开，行随 listProjects / getProjectArtifacts / SESSION list 解析填充
  const row = await waitFor(() => {
    const el = Array.from(popover()?.querySelectorAll('button') ?? [])
      .find((candidate) => candidate.textContent?.includes(rowLabel));
    expect(el).toBeTruthy();
    return el!;
  }, { timeout: 3000 });
  fireEvent.click(row);
}

/** 摆齐四类引用 chip：skill / library（store 真源）+ session / artifact（@ 面板选中）。 */
async function seedAllReferenceChips() {
  await seedStoreChips();
  await selectAtMentionRow(PAST_SESSION_TITLE);
  await waitFor(() => expect(chipMounts('session:')).toHaveLength(1));
  await selectAtMentionRow(ARTIFACT_NAME);
  await waitFor(() => expect(chipMounts('artifact:')).toHaveLength(1));
}

async function withAllReferences(text = 'First draft 80709') {
  const ctx = setup();
  await seedAllReferenceChips();
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

async function expectAllReferenceChips() {
  await waitFor(() => {
    expect(chipMounts('skill:')).toHaveLength(1);
    expect(chipMounts('library:')).toHaveLength(1);
    expect(chipMounts('session:')).toHaveLength(1);
    expect(chipMounts('artifact:')).toHaveLength(1);
  });
  expect(screen.getByRole('group', { name: SKILL_ID })).toBeTruthy();
  expect(screen.getByRole('group', { name: LIB_ITEM_TITLE })).toBeTruthy();
  expect(screen.getByRole('group', { name: PAST_SESSION_TITLE })).toBeTruthy();
  expect(screen.getByRole('group', { name: ARTIFACT_NAME })).toBeTruthy();
}

async function sendAndGetEnvelope(onSend: ReturnType<typeof setup>['onSend']) {
  fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 13 });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0];
}

/** chip × 按钮：portal 渲染进挂载点，移除按钮是挂载点里的唯一 <button>。 */
function chipRemoveButton(prefix: string): HTMLButtonElement {
  const mount = editor().querySelector(`[data-composer-chip-key^="${prefix}"]`);
  expect(mount).toBeTruthy();
  const button = mount!.querySelector('button');
  expect(button).toBeTruthy();
  return button!;
}

/** 光标放在 chip 挂载点之后，复现「Backspace 紧贴 chip」。 */
function placeCaretAfterChip(prefix: string) {
  const mount = editor().querySelector(`[data-composer-chip-key^="${prefix}"]`)!;
  const range = document.createRange();
  range.setStartAfter(mount);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('⌘A 后文本编辑不丢引用 chip（skill / library / session / artifact）', () => {
  it('⌘A + 粘贴：四类引用 chip 都在并随信封发出；library 不触发 setSessionPin', async () => {
    const { onSend } = await withAllReferences();
    selectAll();
    paste(NEW_TEXT);
    await expectAllReferenceChips();
    expect(plainText()).toBe(NEW_TEXT);
    // library 不按 DOM 在场与否写库（挂载点被吞≠用户取消 pin）
    expect(mocks.setSessionPin).not.toHaveBeenCalled();
    const envelope = await sendAndGetEnvelope(onSend);
    expect(envelope.content).toBe(NEW_TEXT);
    expect(envelope.context?.selectedSkillIds).toEqual([SKILL_ID]);
    expect(envelope.context?.sessionReferences?.map((r) => r.id)).toEqual([PAST_SESSION_ID]);
    expect(envelope.context?.artifactReferences?.map((r) => r.id)).toEqual([ARTIFACT_ID]);
    // 信封不直接携带 library pin id：pin 真源在本会话（setSessionPin 落库，host 注入正文）
    expect(chipMounts('library:')).toHaveLength(1);
  });

  it('⌘A + Delete：文字清空，四类引用 chip 都在，重新输入后随信封发出', async () => {
    const { onSend } = await withAllReferences();
    selectAll();
    deleteSelection();
    await expectAllReferenceChips();
    expect(plainText()).toBe('');
    const root = editor();
    root.insertBefore(document.createTextNode('汇总本周笔记'), root.firstChild);
    fireEvent.input(root);
    const envelope = await sendAndGetEnvelope(onSend);
    expect(envelope.context?.selectedSkillIds).toEqual([SKILL_ID]);
    expect(envelope.context?.sessionReferences?.map((r) => r.id)).toEqual([PAST_SESSION_ID]);
    expect(envelope.context?.artifactReferences?.map((r) => r.id)).toEqual([ARTIFACT_ID]);
    expect(mocks.setSessionPin).not.toHaveBeenCalled();
  });

  it('⌘A + 剪切：文字被剪走，四类引用 chip 都在', async () => {
    await withAllReferences();
    selectAll();
    fireEvent.cut(editor());
    deleteSelection();
    await expectAllReferenceChips();
    expect(plainText()).toBe('');
  });

  it('⌘A + 粘贴与原草稿完全相同的文字（值不变）：引用挂载点也补回', async () => {
    await withAllReferences('same draft');
    selectAll();
    paste('same draft');
    await expectAllReferenceChips();
    expect(plainText()).toBe('same draft');
  });

  it('⌘A + 粘贴后再次 ⌘A + 粘贴：四类引用 chip 都恰好一份', async () => {
    await withAllReferences();
    selectAll();
    paste('第二版');
    await expectAllReferenceChips();
    selectAll();
    paste(NEW_TEXT);
    await expectAllReferenceChips();
    expect(plainText()).toBe(NEW_TEXT);
  });
});

describe('显式删除（× 按钮 / 紧贴 Backspace）逐类生效', () => {
  it('× 移除 skill chip：store 条目清空，scope mode 保持 manual', async () => {
    setup();
    await seedStoreChips();
    fireEvent.click(chipRemoveButton('skill:'));
    await waitFor(() => expect(chipMounts('skill:')).toHaveLength(0));
    expect(useComposerStore.getState().selectedSkillIds).toEqual([]);
    expect(useComposerStore.getState().turnCapabilityScopeMode).toBe('manual');
    expect(chipMounts('library:')).toHaveLength(1);
  });

  it('× 移除 library chip：setSessionPin 被调用（pin 移除落库），chip 消失', async () => {
    setup();
    await seedStoreChips();
    fireEvent.click(chipRemoveButton('library:'));
    await waitFor(() => expect(chipMounts('library:')).toHaveLength(0));
    await waitFor(() => expect(mocks.setSessionPin).toHaveBeenCalledWith(CURRENT_SESSION_ID, []));
    expect(chipMounts('skill:')).toHaveLength(1);
  });

  it('× 移除 session chip：chip 消失，信封不再携带该引用', async () => {
    const { onSend } = setup();
    await seedAllReferenceChips();
    fireEvent.click(chipRemoveButton('session:'));
    await waitFor(() => expect(chipMounts('session:')).toHaveLength(0));
    const root = editor();
    root.insertBefore(document.createTextNode('发一句'), root.firstChild);
    fireEvent.input(root);
    const envelope = await sendAndGetEnvelope(onSend);
    expect(envelope.context?.sessionReferences).toBeUndefined();
    expect(envelope.context?.artifactReferences?.map((r) => r.id)).toEqual([ARTIFACT_ID]);
  });

  it('× 移除 artifact chip：chip 消失，信封不再携带该引用', async () => {
    const { onSend } = setup();
    await seedAllReferenceChips();
    fireEvent.click(chipRemoveButton('artifact:'));
    await waitFor(() => expect(chipMounts('artifact:')).toHaveLength(0));
    const root = editor();
    root.insertBefore(document.createTextNode('发一句'), root.firstChild);
    fireEvent.input(root);
    const envelope = await sendAndGetEnvelope(onSend);
    expect(envelope.context?.artifactReferences).toBeUndefined();
    expect(envelope.context?.sessionReferences?.map((r) => r.id)).toEqual([PAST_SESSION_ID]);
  });

  it('Backspace 紧贴 skill chip：移除且 store 条目清空', async () => {
    setup();
    await seedStoreChips();
    placeCaretAfterChip('skill:');
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    await waitFor(() => expect(chipMounts('skill:')).toHaveLength(0));
    expect(useComposerStore.getState().selectedSkillIds).toEqual([]);
    expect(useComposerStore.getState().turnCapabilityScopeMode).toBe('manual');
    expect(chipMounts('library:')).toHaveLength(1);
  });

  it('Backspace 紧贴 library chip：移除且 setSessionPin 落库', async () => {
    setup();
    await seedStoreChips();
    placeCaretAfterChip('library:');
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    await waitFor(() => expect(chipMounts('library:')).toHaveLength(0));
    await waitFor(() => expect(mocks.setSessionPin).toHaveBeenCalledWith(CURRENT_SESSION_ID, []));
    expect(chipMounts('skill:')).toHaveLength(1);
  });

  it('Backspace 紧贴 session chip：移除且信封不再携带', async () => {
    const { onSend } = setup();
    await seedAllReferenceChips();
    placeCaretAfterChip('session:');
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    await waitFor(() => expect(chipMounts('session:')).toHaveLength(0));
    const root = editor();
    root.insertBefore(document.createTextNode('发一句'), root.firstChild);
    fireEvent.input(root);
    const envelope = await sendAndGetEnvelope(onSend);
    expect(envelope.context?.sessionReferences).toBeUndefined();
    expect(envelope.context?.artifactReferences?.map((r) => r.id)).toEqual([ARTIFACT_ID]);
  });

  it('Backspace 紧贴 artifact chip：移除且信封不再携带', async () => {
    const { onSend } = setup();
    await seedAllReferenceChips();
    placeCaretAfterChip('artifact:');
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    await waitFor(() => expect(chipMounts('artifact:')).toHaveLength(0));
    const root = editor();
    root.insertBefore(document.createTextNode('发一句'), root.firstChild);
    fireEvent.input(root);
    const envelope = await sendAndGetEnvelope(onSend);
    expect(envelope.context?.artifactReferences).toBeUndefined();
    expect(envelope.context?.sessionReferences?.map((r) => r.id)).toEqual([PAST_SESSION_ID]);
  });
});

describe('对照：pendingCommand 仍按 DOM 在场裁剪（本单不修，记录既有行为）', () => {
  it('⌘A + 粘贴吞掉挂载点：command chip 被清掉，skill 引用 chip 补回', async () => {
    act(() => {
      useComposerStore.getState().setSelectedSkillIds([SKILL_ID]);
      useComposerStore.getState().setPendingCommand({ id: 'goal', name: '设定目标' });
    });
    const onSend = vi.fn<(envelope: ConversationEnvelope) => Promise<boolean>>().mockResolvedValue(true);
    render(<ChatInput ref={createRef<ChatInputHandle>()} onSend={onSend} />);
    await waitFor(() => expect(chipMounts('command:')).toHaveLength(1));
    await waitFor(() => expect(chipMounts('skill:')).toHaveLength(1));
    const root = editor();
    root.insertBefore(document.createTextNode('先写草稿 '), root.firstChild);
    fireEvent.input(root);
    selectAll();
    paste(NEW_TEXT);
    // command 按 DOM 在场移除（挂载点被吞 → pendingCommand 清空）——同一回调证明了
    // emitChange → onInlineChipsChanged 确实带着被吞后的现存 key 子集跑过真实链路。
    await waitFor(() => {
      expect(chipMounts('command:')).toHaveLength(0);
      expect(useComposerStore.getState().pendingCommand).toBeNull();
    });
    // 引用 chip 不受连坐：补回挂载点、store 条目原样
    await waitFor(() => expect(chipMounts('skill:')).toHaveLength(1));
    expect(useComposerStore.getState().selectedSkillIds).toEqual([SKILL_ID]);
    expect(plainText()).toBe(NEW_TEXT);
  });
});
