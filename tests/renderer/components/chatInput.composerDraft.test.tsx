// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { COMPOSER_DRAFT_ATTACHMENT_BUDGET_BYTES, UI } from '../../../src/shared/constants';
import type { MessageAttachment } from '../../../src/shared/contract';
import {
  COMPOSER_DRAFT_DEBOUNCE_MS,
  COMPOSER_DRAFT_SEND_TIMEOUT_MS,
  composerDraftStorageKey,
  createComposerDraftWriter,
  readComposerDraft,
  readComposerDraftEntry,
} from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';
import { useComposerDraftPersistence } from '../../../src/renderer/components/features/chat/ChatInput/useComposerDraftPersistence';
import { openInitialSession } from '../../../src/renderer/stores/sessionBootDraft';
import { UnsentDraftNotice } from '../../../src/renderer/components/features/chat/ChatInput/UnsentDraftNotice';

let activeLocale: 'zh' | 'en' = 'zh';
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: activeLocale === 'en' ? en : zh, language: activeLocale }),
}));

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

class FlushTarget {
  private listeners = new Set<() => void>();
  addEventListener(_type: string, listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: () => void): void { this.listeners.delete(listener); }
  emit(): void { for (const listener of this.listeners) listener(); }
}

class VisibilityTarget extends FlushTarget {
  visibilityState = 'visible';
}

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const KEY_A = composerDraftStorageKey(SESSION_A, false)!;
const KEY_B = composerDraftStorageKey(SESSION_B, false)!;

function DraftHarness({
  sessionId = SESSION_A,
  sessionless = false,
  scopeProjectId = null,
  clearOnSessionSwitch = false,
  pendingAttachment = null,
}: {
  sessionId?: string | null;
  sessionless?: boolean;
  scopeProjectId?: string | null;
  clearOnSessionSwitch?: boolean;
  pendingAttachment?: MessageAttachment | null;
}) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const lastSessionRef = React.useRef(sessionId);
  React.useEffect(() => {
    if (!clearOnSessionSwitch || lastSessionRef.current === sessionId) return;
    lastSessionRef.current = sessionId;
    setValue('');
    setAttachments([]);
  }, [clearOnSessionSwitch, sessionId]);
  const draft = useComposerDraftPersistence({
    sessionId,
    sessionless,
    scopeProjectId,
    value,
    setValue,
    attachments,
    setAttachments,
  });
  return (
    <div>
      {draft.notice && (
        <UnsentDraftNotice
          preview={draft.notice.preview}
          attachmentNames={draft.notice.attachmentNames}
          droppedNames={draft.notice.droppedNames}
          onPutBack={draft.putBack}
          onDiscard={draft.discard}
        />
      )}
      <div data-testid="composer-attachment-list">
        {attachments.map((att) => (
          <span key={att.id} data-testid={`attachment-chip-${att.name}`}>
            {att.name}
          </span>
        ))}
      </div>
      {pendingAttachment && (
        <button
          type="button"
          data-testid="attach-pending"
          onClick={() => setAttachments((prev) => [...prev, pendingAttachment])}
        >
          attach
        </button>
      )}
      <textarea
        data-testid="composer-draft-box"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </div>
  );
}

describe('composer draft store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('debounces a write per session and does not store whitespace', () => {
    const storage = memoryStorage();
    const page = new FlushTarget();
    const visibility = new VisibilityTarget();
    const writer = createComposerDraftWriter({
      storage,
      pageTarget: page,
      visibilityTarget: visibility,
    });

    const homeKey = composerDraftStorageKey(null, false);
    expect(homeKey).toEqual(expect.stringMatching(/^neo\.composerDraft\.v1:/));
    if (!homeKey) throw new Error('home composer key missing');
    expect(homeKey).not.toBe(KEY_A);
    expect(composerDraftStorageKey(SESSION_A, true)).toBeNull();
    writer.flushNow(KEY_A, '   \n\t', () => false);
    expect(readComposerDraft(KEY_A, storage)).toBeNull();
    expect(storage.getItem(KEY_A)).toBeNull();

    writer.schedule(KEY_A, 'from A', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS - 1); });
    expect(readComposerDraft(KEY_A, storage)).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(readComposerDraft(KEY_A, storage)).toBe('from A');

    writer.schedule(KEY_B, 'from B', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_B, storage)).toBe('from B');
    expect(readComposerDraft(KEY_A, storage)).toBe('from A');

    writer.schedule(KEY_A, '   \n\t', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A, storage)).toBeNull();
    expect(storage.getItem(KEY_A)).toBeNull();

    writer.schedule(KEY_B, 'keep during send', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    writer.schedule(KEY_B, '   ', () => true);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_B, storage)).toBe('keep during send');

    writer.schedule(composerDraftStorageKey(null, true), 'sessionless', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(storage.getItem(homeKey)).toBeNull();

    writer.schedule(homeKey, 'home brief', () => false);
    page.emit();
    expect(readComposerDraft(homeKey, storage)).toBe('home brief');

    writer.schedule(homeKey, 'hidden brief', () => false);
    visibility.visibilityState = 'hidden';
    visibility.emit();
    expect(readComposerDraft(homeKey, storage)).toBe('hidden brief');
    writer.dispose();
  });
});

describe('useComposerDraftPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('deletes the stored draft only after a successful send', async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useComposerDraftPersistence({
        sessionId: SESSION_A,
        sessionless: false,
        value,
        setValue: () => undefined,
      }),
      { initialProps: { value: 'keep until success' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('keep until success');

    let resolveSend: (value: boolean) => void = () => undefined;
    const pendingSend = new Promise<boolean>((resolve) => { resolveSend = resolve; });
    let tracked: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { tracked = result.current.trackSend(() => pendingSend); });
    expect(readComposerDraft(KEY_A)).toBe('keep until success');
    rerender({ value: '' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('keep until success');
    await act(async () => {
      resolveSend(true);
      await tracked;
    });
    expect(readComposerDraft(KEY_A)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBeNull();
  });

  it('keeps the stored draft when onSend returns false, throws, or times out', async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useComposerDraftPersistence({
        sessionId: SESSION_A,
        sessionless: false,
        value,
        setValue: () => undefined,
      }),
      { initialProps: { value: 'still here' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });

    let resolveSend: (value: boolean) => void = () => undefined;
    const pendingSend = new Promise<boolean>((resolve) => { resolveSend = resolve; });
    let tracked: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { tracked = result.current.trackSend(() => pendingSend); });
    rerender({ value: '' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('still here');
    await act(async () => {
      resolveSend(false);
      await tracked;
    });
    expect(readComposerDraft(KEY_A)).toBe('still here');
    rerender({ value: 'still here' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('still here');

    await expect(act(async () => {
      await result.current.trackSend(() => { throw new Error('send failed closed'); });
    })).rejects.toThrow('send failed closed');
    expect(readComposerDraft(KEY_A)).toBe('still here');

    let timed: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { timed = result.current.trackSend(() => new Promise<boolean>(() => undefined)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_SEND_TIMEOUT_MS); });
    await expect(timed).resolves.toBe('timeout');
    expect(readComposerDraft(KEY_A)).toBe('still here');
  });

  it('deletes the draft of the session that sent, not the one current when the send settles', async () => {
    const seeder = createComposerDraftWriter({ pageTarget: null, visibilityTarget: null });
    seeder.flushNow(KEY_B, 'beta text', () => false);
    seeder.dispose();

    const { result, rerender } = renderHook(
      ({ sessionId, value }: { sessionId: string; value: string }) => useComposerDraftPersistence({
        sessionId,
        sessionless: false,
        value,
        setValue: () => undefined,
      }),
      { initialProps: { sessionId: SESSION_A, value: 'alpha send' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('alpha send');

    let resolveSend: (value: boolean) => void = () => undefined;
    const pendingSend = new Promise<boolean>((resolve) => { resolveSend = resolve; });
    let tracked: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { tracked = result.current.trackSend(() => pendingSend); });
    // The optimistic clear already emptied the box; the user switches to
    // session B while the send from A is still in flight.
    rerender({ sessionId: SESSION_B, value: '' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });

    await act(async () => {
      resolveSend(true);
      await tracked;
    });
    expect(readComposerDraft(KEY_A)).toBeNull();
    expect(readComposerDraft(KEY_B)).toBe('beta text');
    expect(result.current.notice?.preview).toBe('beta text');

    // Back on A the successful send is not offered again.
    rerender({ sessionId: SESSION_A, value: '' });
    expect(result.current.notice).toBeNull();
  });

  it('does not store queued-edit text or drop the idle draft when that edit ends', async () => {
    const { rerender } = renderHook(
      ({ value, suspend }: { value: string; suspend: boolean }) => useComposerDraftPersistence({
        sessionId: SESSION_A,
        sessionless: false,
        value,
        setValue: () => undefined,
        suspend,
      }),
      { initialProps: { value: 'idle brief', suspend: false } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('idle brief');

    rerender({ value: 'queued body that must stay out of the idle draft', suspend: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('idle brief');

    rerender({ value: '', suspend: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('idle brief');
  });

  it('flushes the previous session before the box is cleared', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId, value }: { sessionId: string; value: string }) => useComposerDraftPersistence({
        sessionId,
        sessionless: false,
        value,
        setValue: () => undefined,
      }),
      { initialProps: { sessionId: SESSION_A, value: 'alpha text' } },
    );
    const seeder = createComposerDraftWriter({ pageTarget: null, visibilityTarget: null });
    seeder.flushNow(KEY_B, 'beta text', () => false);
    seeder.dispose();
    rerender({ sessionId: SESSION_B, value: 'alpha text' });
    rerender({ sessionId: SESSION_B, value: '' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('alpha text');
    expect(readComposerDraft(KEY_B)).toBe('beta text');
    expect(result.current.notice?.preview).toBe('beta text');
  });
});

describe('UnsentDraftNotice restart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  const longText = `给 Neo 的长说明${'甲'.repeat(40)}`;

  async function typeAndUnmount(): Promise<void> {
    const view = render(<DraftHarness />);
    fireEvent.change(screen.getByTestId('composer-draft-box'), { target: { value: longText } });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    view.unmount();
  }

  it('shows the first 40 characters after remount, and put back fills the box', async () => {
    await typeAndUnmount();
    render(<DraftHarness />);
    const notice = screen.getByTestId('unsent-draft-notice');
    expect(notice.textContent).toContain('上次输入框里还有一段内容');
    expect(notice.textContent).toContain(longText.slice(0, 40));
    expect(notice.textContent).not.toContain(longText);

    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect((screen.getByTestId('composer-draft-box') as HTMLTextAreaElement).value).toBe(longText);
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
  });

  it('discard removes the stored draft and the notice', async () => {
    await typeAndUnmount();
    render(<DraftHarness />);
    fireEvent.click(screen.getByTestId('unsent-draft-discard'));
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
    expect(readComposerDraft(KEY_A)).toBeNull();
  });

  it('shows the card when boot adopts the home draft onto the already-mounted session', async () => {
    localStorage.setItem(composerDraftStorageKey(null, false)!, JSON.stringify({ v: 1, text: 'typed with no session' }));
    render(<DraftHarness sessionId="fresh-session" />);
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
    await act(async () => {
      await openInitialSession({
        sessions: [],
        isBlank: () => true,
        switchSession: async () => undefined,
        createSession: async () => ({ id: 'fresh-session' }),
      });
    });
    expect(screen.getByTestId('unsent-draft-notice')).toBeTruthy();
    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect((screen.getByTestId('composer-draft-box') as HTMLTextAreaElement).value).toBe('typed with no session');
  });

  it('home key (no session): saves, restores on a fresh mount, and clears after a successful send', async () => {
    const HOME = composerDraftStorageKey(null, false)!;
    const first = renderHook(
      ({ value }: { value: string }) => useComposerDraftPersistence({
        sessionId: null, sessionless: false, value, setValue: () => undefined,
      }),
      { initialProps: { value: 'home task description' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(HOME)).toBe('home task description');
    first.unmount();

    const setValue = vi.fn();
    const second = renderHook(() => useComposerDraftPersistence({
      sessionId: null, sessionless: false, value: '', setValue,
    }));
    expect(second.result.current.notice?.preview).toBe('home task description');
    act(() => { second.result.current.putBack(); });
    expect(setValue).toHaveBeenCalledWith('home task description');

    let tracked: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { tracked = second.result.current.trackSend(() => Promise.resolve(true)); });
    await act(async () => { await tracked; });
    expect(readComposerDraft(HOME)).toBeNull();
    expect(second.result.current.notice).toBeNull();
  });
});

describe('project-page (sessionless) composer draft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  const type = async (text: string) => {
    fireEvent.change(screen.getByTestId('composer-draft-box'), { target: { value: text } });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
  };

  it('离开项目页再回来：同项目草稿可放回，其他项目看不到', async () => {
    const first = render(<DraftHarness sessionId={null} sessionless scopeProjectId="proj-1" />);
    await type('很长的周报草稿');
    first.unmount();

    render(<DraftHarness sessionId={null} sessionless scopeProjectId="proj-1" />);
    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect((screen.getByTestId('composer-draft-box') as HTMLTextAreaElement).value).toBe('很长的周报草稿');
    cleanup();

    render(<DraftHarness sessionId={null} sessionless scopeProjectId="proj-2" />);
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
    // 首页草稿键不受影响
    expect(readComposerDraft(composerDraftStorageKey(null, false))).toBeNull();
  });

  it('发送成功后清掉项目草稿；无项目 id 的 sessionless 仍不落盘', async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useComposerDraftPersistence({
        sessionId: null,
        sessionless: true,
        scopeProjectId: 'proj-1',
        value,
        setValue: () => undefined,
      }),
      { initialProps: { value: '发出去的内容' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    const key = composerDraftStorageKey(null, true, 'proj-1')!;
    expect(readComposerDraft(key)).toBe('发出去的内容');
    await act(async () => { await result.current.trackSend(() => true); });
    rerender({ value: '' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(key)).toBeNull();
    expect(composerDraftStorageKey(null, true)).toBeNull();
  });
});

function makeImageAttachment(
  id: string,
  name: string,
  dataBytes = 64,
): MessageAttachment {
  const payload = `data:image/png;base64,${'A'.repeat(dataBytes)}`;
  return {
    id,
    type: 'image',
    category: 'image',
    name,
    size: dataBytes,
    mimeType: 'image/png',
    data: payload,
    thumbnail: 'data:image/png;base64,AAAA',
  };
}

describe('composer draft v2 attachments', () => {
  beforeEach(() => {
    activeLocale = 'zh';
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    activeLocale = 'zh';
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('saves and restores text + attachment across a session switch', async () => {
    const shot = makeImageAttachment('att-1', 'shot.png', 128);
    const view = render(
      <DraftHarness sessionId={SESSION_A} clearOnSessionSwitch pendingAttachment={shot} />,
    );

    fireEvent.change(screen.getByTestId('composer-draft-box'), {
      target: { value: '附件草稿复测1113' },
    });
    fireEvent.click(screen.getByTestId('attach-pending'));
    expect(screen.getByTestId('attachment-chip-shot.png')).toBeTruthy();

    // Switch to session B before debounce fires: pre-switch flush writes v2 draft to KEY_A
    view.rerender(
      <DraftHarness sessionId={SESSION_B} clearOnSessionSwitch pendingAttachment={shot} />,
    );
    expect((screen.getByTestId('composer-draft-box') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByTestId('attachment-chip-shot.png')).toBeNull();

    const rawStored = localStorage.getItem(KEY_A);
    expect(rawStored).toBeTruthy();
    const parsed = JSON.parse(rawStored!);
    expect(parsed).toMatchObject({
      v: 2,
      text: '附件草稿复测1113',
      attachments: [expect.objectContaining({ id: 'att-1', name: 'shot.png' })],
    });

    // Switch back to session A: notice shows text preview + attachment name, putBack restores both
    view.rerender(
      <DraftHarness sessionId={SESSION_A} clearOnSessionSwitch pendingAttachment={shot} />,
    );
    const notice = screen.getByTestId('unsent-draft-notice');
    expect(notice.textContent).toContain('附件草稿复测1113');
    expect(notice.textContent).toContain('shot.png');

    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect((screen.getByTestId('composer-draft-box') as HTMLTextAreaElement).value).toBe('附件草稿复测1113');
    expect(screen.getByTestId('attachment-chip-shot.png')).toBeTruthy();
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
  });

  it('saves and restores an attachment-only draft across a session switch (zh and en)', async () => {
    const diagram = makeImageAttachment('att-only', 'diagram.png', 96);
    const view = render(
      <DraftHarness sessionId={SESSION_A} clearOnSessionSwitch pendingAttachment={diagram} />,
    );
    fireEvent.click(screen.getByTestId('attach-pending'));

    // Switch away with empty text: attachment-only flush must persist
    view.rerender(
      <DraftHarness sessionId={SESSION_B} clearOnSessionSwitch pendingAttachment={diagram} />,
    );
    expect(readComposerDraftEntry(KEY_A)).toMatchObject({
      text: '',
      attachments: [expect.objectContaining({ id: 'att-only', name: 'diagram.png' })],
      dropped: [],
    });

    // Switch back: zh notice names the attachment, putBack restores it while keeping text empty
    view.rerender(
      <DraftHarness sessionId={SESSION_A} clearOnSessionSwitch pendingAttachment={diagram} />,
    );
    expect(screen.getByTestId('unsent-draft-notice').textContent).toContain('diagram.png');

    activeLocale = 'en';
    view.rerender(
      <DraftHarness sessionId={SESSION_A} clearOnSessionSwitch pendingAttachment={diagram} />,
    );
    expect(screen.getByTestId('unsent-draft-notice').textContent).toContain('1 unsent attachment: diagram.png');

    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect((screen.getByTestId('composer-draft-box') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('attachment-chip-diagram.png')).toBeTruthy();
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
  });

  it('places over-budget attachments in dropped, names them in the notice, and restores fitting ones', async () => {
    const smallFirst = makeImageAttachment('small-1', 'small-first.png', 200);
    const overBudget = makeImageAttachment(
      'oversize-1',
      'oversize-board.png',
      COMPOSER_DRAFT_ATTACHMENT_BUDGET_BYTES + 1024,
    );
    const smallSecond = makeImageAttachment('small-2', 'small-second.png', 200);

    const setValue = vi.fn();
    const setAttachments = vi.fn();
    const { result, rerender } = renderHook(
      ({ sessionId, value, attachments }: { sessionId: string; value: string; attachments: MessageAttachment[] }) =>
        useComposerDraftPersistence({
          sessionId,
          sessionless: false,
          value,
          setValue,
          attachments,
          setAttachments,
        }),
      {
        initialProps: {
          sessionId: SESSION_A,
          value: '月度复盘说明',
          attachments: [smallFirst, overBudget, smallSecond],
        },
      },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    const entry = readComposerDraftEntry(KEY_A);
    expect(entry?.attachments.map((att) => att.name)).toEqual(['small-first.png', 'small-second.png']);
    expect(entry?.dropped).toEqual(['oversize-board.png']);

    rerender({ sessionId: SESSION_B, value: '', attachments: [] });
    rerender({ sessionId: SESSION_A, value: '', attachments: [] });
    expect(result.current.notice).toMatchObject({
      preview: '月度复盘说明',
      attachmentNames: ['small-first.png', 'small-second.png'],
      droppedNames: ['oversize-board.png'],
    });

    const noticeView = render(
      <UnsentDraftNotice
        preview={result.current.notice!.preview}
        attachmentNames={result.current.notice!.attachmentNames}
        droppedNames={result.current.notice!.droppedNames}
        onPutBack={result.current.putBack}
        onDiscard={result.current.discard}
      />,
    );
    const noticeText = screen.getByTestId('unsent-draft-notice').textContent ?? '';
    expect(noticeText).toContain('small-first.png');
    expect(noticeText).toContain('small-second.png');
    expect(noticeText).toContain('oversize-board.png');
    expect(noticeText).toContain('没能保存或恢复');

    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect(setValue).toHaveBeenCalledWith('月度复盘说明');
    expect(setAttachments).toHaveBeenCalledWith([smallFirst, smallSecond]);
    noticeView.unmount();
  });

  it('retries without attachments and records dropped names when setItem throws on quota', async () => {
    const rawMap = new Map<string, string>();
    let setItemCalls = 0;
    const quotaStorage = {
      getItem: (k: string) => rawMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        setItemCalls += 1;
        if (v.includes('data:image/png')) {
          const err = new Error('QuotaExceededError');
          err.name = 'QuotaExceededError';
          throw err;
        }
        rawMap.set(k, v);
      },
      removeItem: (k: string) => { rawMap.delete(k); },
    };

    const writer = createComposerDraftWriter({
      storage: quotaStorage,
      pageTarget: null,
      visibilityTarget: null,
    });
    const attA = makeImageAttachment('q-1', 'report-a.png', 128);
    const attB = makeImageAttachment('q-2', 'report-b.png', 128);
    writer.flushNow(KEY_A, '保留正文', () => false, [attA, attB]);
    writer.dispose();

    expect(setItemCalls).toBe(2);
    const fallbackEntry = readComposerDraftEntry(KEY_A, quotaStorage);
    expect(fallbackEntry).toEqual({
      text: '保留正文',
      attachments: [],
      dropped: ['report-a.png', 'report-b.png'],
    });

    // Also drive the real hook with an attachment-only draft hitting localStorage quota: never silent
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (v.includes('data:image/png')) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      realSetItem.call(this, k, v);
    });

    const view = render(
      <DraftHarness sessionId={SESSION_A} clearOnSessionSwitch pendingAttachment={attA} />,
    );
    fireEvent.click(screen.getByTestId('attach-pending'));
    view.rerender(
      <DraftHarness sessionId={SESSION_B} clearOnSessionSwitch pendingAttachment={attA} />,
    );
    view.rerender(
      <DraftHarness sessionId={SESSION_A} clearOnSessionSwitch pendingAttachment={attA} />,
    );

    const notice = screen.getByTestId('unsent-draft-notice');
    expect(notice.textContent).toContain('report-a.png');
    expect(notice.textContent).toContain('没能保存或恢复');
    expect(screen.queryByTestId('unsent-draft-put-back')).toBeNull();
    fireEvent.click(screen.getByTestId('unsent-draft-discard'));
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
  });

  it('caps stored and restored attachments at UI.MAX_ATTACHMENTS_DROP (10) without duplicates', () => {
    const storage = memoryStorage();
    const writer = createComposerDraftWriter({
      storage,
      pageTarget: null,
      visibilityTarget: null,
    });
    const twelve = Array.from({ length: UI.MAX_ATTACHMENTS_DROP + 2 }, (_, idx) =>
      makeImageAttachment(`cap-${idx + 1}`, `shot-${idx + 1}.png`, 32),
    );
    writer.flushNow(KEY_A, '十二张图', () => false, twelve);
    writer.dispose();

    const stored = readComposerDraftEntry(KEY_A, storage);
    expect(stored?.attachments).toHaveLength(UI.MAX_ATTACHMENTS_DROP);
    expect(stored?.dropped).toEqual(['shot-11.png', 'shot-12.png']);

    // Put back into a composer that already holds 3 attachments (1 shared + 2 new): dedupes and caps at 10
    const realWriter = createComposerDraftWriter({ pageTarget: null, visibilityTarget: null });
    realWriter.flushNow(KEY_A, '', () => false, twelve.slice(0, 9));
    realWriter.dispose();

    const existing = [
      twelve[0], // duplicate of shot-1.png
      makeImageAttachment('existing-a', 'existing-a.png', 32),
      makeImageAttachment('existing-b', 'existing-b.png', 32),
    ];
    const setAttachments = vi.fn();
    const { result } = renderHook(() =>
      useComposerDraftPersistence({
        sessionId: SESSION_A,
        sessionless: false,
        value: '',
        setValue: () => undefined,
        attachments: existing,
        setAttachments,
      }),
    );

    act(() => { result.current.putBack(); });
    expect(setAttachments).toHaveBeenCalledTimes(1);
    const merged = setAttachments.mock.calls[0][0] as MessageAttachment[];
    expect(merged).toHaveLength(UI.MAX_ATTACHMENTS_DROP);
    const names = merged.map((att) => att.name);
    expect(new Set(names).size).toBe(UI.MAX_ATTACHMENTS_DROP);
    expect(names.slice(0, 3)).toEqual(['shot-1.png', 'existing-a.png', 'existing-b.png']);
  });

  it('names an unreadable stored attachment as not restored and puts back only the valid one', () => {
    const good = makeImageAttachment('good-1', 'good-shot.png', 64);
    const noData = { ...makeImageAttachment('bad-1', 'broken-shot.png', 64), data: '' };
    const wrongShape = { id: 'bad-2', type: 'file', name: 'C:\\tmp\\old-report.pdf' };
    localStorage.setItem(KEY_A, JSON.stringify({ v: 2, text: '继续写', attachments: [good, noData, wrongShape] }));

    const setValue = vi.fn();
    const setAttachments = vi.fn();
    const { result } = renderHook(() =>
      useComposerDraftPersistence({
        sessionId: SESSION_A, sessionless: false, value: '', setValue, attachments: [], setAttachments,
      }),
    );
    expect(result.current.notice).toMatchObject({
      preview: '继续写',
      attachmentNames: ['good-shot.png'],
      droppedNames: ['broken-shot.png', 'old-report.pdf'],
    });
    const view = render(
      <UnsentDraftNotice
        preview={result.current.notice!.preview}
        attachmentNames={result.current.notice!.attachmentNames}
        droppedNames={result.current.notice!.droppedNames}
        onPutBack={result.current.putBack}
        onDiscard={result.current.discard}
      />,
    );
    const text = screen.getByTestId('unsent-draft-notice').textContent ?? '';
    expect(text).toContain('broken-shot.png');
    expect(text).toContain('old-report.pdf');
    expect(text).not.toContain('tmp');
    expect(text).toContain('没能保存或恢复');
    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect(setAttachments).toHaveBeenCalledWith([good]);
    view.unmount();
  });

  it('keeps v1 drafts readable and restorable through the hook', () => {
    localStorage.setItem(KEY_A, JSON.stringify({ v: 1, text: '旧版 v1 纯文本草稿' }));
    expect(readComposerDraft(KEY_A)).toBe('旧版 v1 纯文本草稿');

    render(<DraftHarness sessionId={SESSION_A} />);
    const notice = screen.getByTestId('unsent-draft-notice');
    expect(notice.textContent).toContain('旧版 v1 纯文本草稿');
    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect((screen.getByTestId('composer-draft-box') as HTMLTextAreaElement).value).toBe('旧版 v1 纯文本草稿');
  });

  it('deletes text+attachment draft on successful send and keeps both on failure or timeout', async () => {
    const shot = makeImageAttachment('send-att', 'send-proof.png', 96);
    const { result, rerender } = renderHook(
      ({ value, attachments }: { value: string; attachments: MessageAttachment[] }) =>
        useComposerDraftPersistence({
          sessionId: SESSION_A,
          sessionless: false,
          value,
          setValue: () => undefined,
          attachments,
          setAttachments: () => undefined,
        }),
      { initialProps: { value: '发送前草稿', attachments: [shot] } },
    );

    // Failed send: optimistic clear empties value & attachments, failure keeps v2 entry intact
    let resolveFail: (ok: boolean) => void = () => undefined;
    let trackedFail: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => {
      trackedFail = result.current.trackSend(() => new Promise<boolean>((r) => { resolveFail = r; }));
    });
    rerender({ value: '', attachments: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    await act(async () => {
      resolveFail(false);
      await trackedFail;
    });
    expect(readComposerDraftEntry(KEY_A)).toMatchObject({
      text: '发送前草稿',
      attachments: [expect.objectContaining({ name: 'send-proof.png' })],
    });
    expect(result.current.notice?.attachmentNames).toEqual(['send-proof.png']);

    // Restore and test timeout: still keeps draft
    rerender({ value: '发送前草稿', attachments: [shot] });
    let trackedTimeout: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => {
      trackedTimeout = result.current.trackSend(() => new Promise<boolean>(() => undefined));
    });
    rerender({ value: '', attachments: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_SEND_TIMEOUT_MS); });
    await expect(trackedTimeout).resolves.toBe('timeout');
    expect(readComposerDraftEntry(KEY_A)?.attachments).toHaveLength(1);

    // Restore and succeed: removes whole localStorage entry
    rerender({ value: '发送前草稿', attachments: [shot] });
    let trackedOk: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { trackedOk = result.current.trackSend(() => Promise.resolve(true)); });
    rerender({ value: '', attachments: [] });
    await act(async () => { await trackedOk; });
    expect(localStorage.getItem(KEY_A)).toBeNull();
    expect(readComposerDraftEntry(KEY_A)).toBeNull();
  });

  it('adopts an attachment-only home draft onto a freshly created session at cold boot', async () => {
    const shot = makeImageAttachment('home-att', 'home-shot.png', 64);
    const seeder = createComposerDraftWriter({ pageTarget: null, visibilityTarget: null });
    seeder.flushNow(composerDraftStorageKey(null, false), '', () => false, [shot]);
    seeder.dispose();

    render(<DraftHarness sessionId="boot-created" />);
    await act(async () => {
      await openInitialSession({
        sessions: [],
        isBlank: () => true,
        switchSession: async () => undefined,
        createSession: async () => ({ id: 'boot-created' }),
      });
    });
    expect(screen.getByTestId('unsent-draft-notice').textContent).toContain('home-shot.png');
    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect(screen.getByTestId('attachment-chip-home-shot.png')).toBeTruthy();
  });
});
