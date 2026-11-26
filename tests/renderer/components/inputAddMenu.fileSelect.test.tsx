// @vitest-environment jsdom
// N-FIX-COMPOSER-UPLOAD-PICK-NO-CHIP：「+」菜单选文件 → 真实 InputAddMenu 的 input →
// 真实 handleFileSelect → 真实 processFile。只 mock ipcService / 能力注册表等外围。
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MessageAttachment } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({ skills: [], connectors: [], mcpServers: [], items: [] }),
}));
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector: (state: { entries: unknown[] }) => unknown) => selector({ entries: [] }),
}));
const appState = {
  activeAgentId: null as string | null,
  setActiveAgentId: vi.fn(),
  openCapabilityHub: vi.fn(),
  openSettingsTab: vi.fn(),
  syncActiveAgentForSession: vi.fn(),
  activeAgentSessionKey: null as string | null,
  bindAgentForSession: vi.fn(),
};
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof appState) => unknown) => selector(appState),
    { getState: () => appState, setState: (p: Partial<typeof appState>) => { Object.assign(appState, p); } },
  ),
}));
const sessionStoreState = {
  currentSessionId: null as string | null,
  sessions: [] as unknown[],
  messages: [] as unknown[],
  updateSessionMemoryMode: vi.fn(async () => {}),
};
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionStoreState) => unknown) => selector(sessionStoreState),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
const ipc = vi.hoisted(() => ({ getPathForFile: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));

import { InputAddMenu } from '../../../src/renderer/components/features/chat/ChatInput/InputAddMenu';
import { useFileUpload } from '../../../src/renderer/components/features/chat/ChatInput/useFileUpload';
import { useChatInputComposerActions } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputComposerActions';
import { useToastStore } from '../../../src/renderer/hooks/useToast';

function Harness() {
  const { processFile } = useFileUpload();
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const actions = useChatInputComposerActions({
    processFile,
    inputAreaRef: { current: null },
    setIsUploading: setUploading,
    attachmentCount: attachments.length,
    setAttachments,
    setValue: vi.fn(),
    setVoiceInputContext: vi.fn(),
  });
  return (
    <div>
      <InputAddMenu onFileSelect={actions.handleFileSelect} onSelectCapability={vi.fn()} />
      <span data-testid="uploading">{String(uploading)}</span>
      <ul>{attachments.map((a) => <li key={a.id} data-testid="chip">{a.name}</li>)}</ul>
    </div>
  );
}

function pick(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
  return input;
}

describe('InputAddMenu 选文件 → 附件 chip', () => {
  beforeEach(() => {
    ipc.getPathForFile.mockReset();
    ipc.getPathForFile.mockResolvedValue('/tmp/weekly-notes.txt');
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('选 .txt 后出现带文件名的附件，input 被清空以便再选同一文件', async () => {
    render(<Harness />);
    const input = pick(new File(['本周三个要点'], 'weekly-notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(screen.getAllByTestId('chip').map((c) => c.textContent)).toEqual(['weekly-notes.txt']));
    expect(input.value).toBe('');
    expect(screen.getByTestId('uploading').textContent).toBe('false');
  });

  it('processFile 抛异常时给出人话 toast，不再静默无 chip', async () => {
    // 真实 processFile 内部抛出（FileReader 构造即炸），而不是返回 null
    vi.stubGlobal('FileReader', class { readAsText() { throw new Error('boom'); } });
    render(<Harness />);
    pick(new File(['x'], 'weekly-notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.message))
      .toEqual(['文件 "weekly-notes.txt" 添加失败，没能处理这个文件。请重新选择，或换一个文件试试']));
    expect(screen.queryAllByTestId('chip')).toHaveLength(0);
    expect(screen.getByTestId('uploading').textContent).toBe('false');
  });
});
