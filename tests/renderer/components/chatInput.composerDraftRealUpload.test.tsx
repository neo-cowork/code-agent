// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { useFileUpload } from '../../../src/renderer/components/features/chat/ChatInput/useFileUpload';
import { useComposerDraftPersistence } from '../../../src/renderer/components/features/chat/ChatInput/useComposerDraftPersistence';
import { useChatInputSessionScope } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSessionScope';
import { UnsentDraftNotice } from '../../../src/renderer/components/features/chat/ChatInput/UnsentDraftNotice';
import { readComposerDraftEntry } from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';

let locale: 'zh' | 'en' = 'zh';
const sessionState = vi.hoisted(() => ({ currentSessionId: 'upload-b', sessions: [] }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (select: (state: typeof sessionState) => unknown) => select(sessionState),
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: locale === 'zh' ? zh : en, language: locale }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { getPathForFile: async (file: File) => `/tmp/uploads/${file.name}` },
}));

const KEY = 'neo.composerDraft.v1:upload-b';
const TEXT = '请整理这份每周报告，保留附件。';
// Same filename, MIME and byte size as FB-1444. Keep the machine-specific dogfood
// instructions out of the fixture; the object itself is produced by processFile.
const markdown = new File(
  ['# Weekly report\n'.padEnd(3017, 'x')],
  'DOGFOOD-TARGETED-1114-124850-14238.prompt.md',
  { type: 'text/markdown' },
);
// Actual PNG bytes from the additional file used in the browser reproduction.
const pngData = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNQqL1DU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAHO75Ez8ERFVAAAAAElFTkSuQmCC';

function UploadDraft({ incoming }: { incoming: MessageAttachment[] }) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  // Use the same production clearing effect and hook order as ChatInput.
  const { currentSessionId } = useChatInputSessionScope(setValue, setAttachments);
  const draft = useComposerDraftPersistence({
    sessionId: currentSessionId, sessionless: false, value, setValue, attachments, setAttachments,
  });
  return <>
    {draft.notice && <UnsentDraftNotice {...draft.notice} onPutBack={draft.putBack} onDiscard={draft.discard} />}
    <textarea aria-label="report" value={value} onChange={(e) => setValue(e.target.value)} />
    <button onClick={() => setAttachments(incoming)}>upload result</button>
    {attachments.map((item) => <span role="group" aria-label={item.name} key={item.id}>
      {item.name}<button aria-label={`remove ${item.name}`} onClick={() => setAttachments((prev) => prev.filter((att) => att.id !== item.id))}>×</button>
    </span>)}
  </>;
}

async function uploadFixtures() {
  const bytes = Uint8Array.from(atob(pngData), (char) => char.charCodeAt(0));
  const png = new File([bytes], 'weekly-chart.png', { type: 'image/png' });
  const hook = renderHook(() => useFileUpload());
  let uploaded: (MessageAttachment | null)[] = [];
  await act(async () => {
    uploaded = await Promise.all([hook.result.current.processFile(markdown), hook.result.current.processFile(png)]);
  });
  hook.unmount();
  expect(uploaded.every(Boolean)).toBe(true);
  const [md, image] = uploaded as MessageAttachment[];
  expect(md).toMatchObject({ type: 'file', category: 'text', size: 3017, mimeType: 'text/markdown', language: 'markdown' });
  expect(Object.keys(md)).toEqual(['id', 'type', 'category', 'name', 'size', 'mimeType', 'data', 'language', 'path', 'sheetsJson']);
  expect(image).toMatchObject({ type: 'image', category: 'image', mimeType: 'image/png', data: `data:image/png;base64,${pngData}`, thumbnail: `data:image/png;base64,${pngData}` });
  return [md, image];
}

describe('composer drafts with actual useFileUpload results', () => {
  beforeEach(() => {
    locale = 'zh';
    sessionState.currentSessionId = 'upload-b';
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.useRealTimers();
  });

  it.each(['md', 'image', 'multi'] as const)('%s: save → read → put back, including the production session clearing effect', async (kind) => {
    const [md, image] = await uploadFixtures();
    const incoming = kind === 'md' ? [md] : kind === 'image' ? [image] : [md, image];
    vi.useFakeTimers();
    const view = render(<UploadDraft incoming={incoming} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: TEXT } });
    fireEvent.click(screen.getByText('upload result'));
    // Leave before the debounce fires: the session transition must flush the real objects.
    sessionState.currentSessionId = 'upload-a';
    view.rerender(<UploadDraft incoming={incoming} />);
    const stored = readComposerDraftEntry(KEY);
    expect(stored?.text).toBe(TEXT);
    expect(stored?.attachments).toEqual(JSON.parse(JSON.stringify(incoming)));
    expect(stored?.dropped).toEqual([]);
    expect(screen.queryByRole('group')).toBeNull();
    // Stay away long enough to flush the empty composer, then return to the persisted id.
    act(() => { vi.advanceTimersByTime(500); });
    sessionState.currentSessionId = 'upload-b';
    view.rerender(<UploadDraft incoming={incoming} />);
    act(() => { vi.advanceTimersByTime(500); });
    expect(readComposerDraftEntry(KEY)).toEqual(stored);
    for (const item of incoming) expect(screen.getByTestId('unsent-draft-notice').textContent).toContain(item.name);
    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(TEXT);
    for (const item of incoming) {
      expect(screen.getByRole('group', { name: item.name })).toBeTruthy();
      expect(screen.getByRole('button', { name: `remove ${item.name}` })).toBeTruthy();
    }
    act(() => { vi.advanceTimersByTime(500); });
    expect(readComposerDraftEntry(KEY)?.attachments).toEqual(stored?.attachments);
    // A remount must read the same objects, rather than depending on live refs.
    view.unmount();
    render(<UploadDraft incoming={incoming} />);
    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    for (const item of incoming) expect(screen.getByRole('group', { name: item.name })).toBeTruthy();
  });

  it.each(['zh', 'en'] as const)('%s: names a real uploaded PNG whose saved content cannot be read back', async (language) => {
    const [md, image] = await uploadFixtures();
    locale = language;
    localStorage.setItem(KEY, JSON.stringify({ v: 2, text: TEXT, attachments: [md, { ...image, data: '' }] }));
    render(<UploadDraft incoming={[]} />);
    const notice = screen.getByTestId('unsent-draft-notice').textContent;
    expect(notice).toContain(language === 'zh' ? '没能保存或恢复：weekly-chart.png' : 'could not be saved or restored: weekly-chart.png');
    expect(notice).not.toContain('/tmp/uploads');
    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect(screen.getByRole('group', { name: md.name })).toBeTruthy();
    expect(screen.queryByRole('group', { name: image.name })).toBeNull();
  });
});
