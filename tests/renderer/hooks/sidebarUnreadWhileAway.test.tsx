// @vitest-environment jsdom
// 后台完成必须留未读点：真 useSessionStore + applyTaskProgressEffects 公共入口。
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { TaskCompleteData } from '../../../src/shared/contract';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import {
  applyTaskProgressEvent,
  type TaskProgressEventDeps,
} from '../../../src/renderer/hooks/agent/effects/useTaskProgressEffects';
import { useClearCurrentUnreadOnReturn } from '../../../src/renderer/components/features/sidebar/useClearCurrentUnreadOnReturn';

let away = false;

function setAway(value: boolean): void {
  away = value;
  document.hasFocus = () => !value;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
}

function deps(): TaskProgressEventDeps {
  return {
    debug: () => {},
    getCurrentSessionId: () => useSessionStore.getState().currentSessionId,
    isWindowAway: () => away,
    markSessionUnread: (id, options) => useSessionStore.getState().markSessionUnread(id, options),
    now: () => 1,
    setLastEventAt: () => {},
    setSessionTaskComplete: () => {},
    setSessionTaskProgress: () => {},
    setSessionTasks: () => {},
    setTodos: () => {},
  };
}

function complete(sessionId: string): void {
  applyTaskProgressEvent(
    { type: 'task_complete', data: { turnId: sessionId } as unknown as TaskCompleteData, sessionId },
    deps(),
  );
}

// 等价于 switchSession 对未读集合的效果：落到会话 = 当前会话变更 + 该会话已读。
function open(sessionId: string): void {
  useSessionStore.setState({ currentSessionId: sessionId });
  useSessionStore.getState().markSessionRead(sessionId);
}

const unread = () => [...useSessionStore.getState().unreadSessionIds].sort();

describe('sidebar unread dot when a task completes while Neo is in the background', () => {
  beforeEach(() => {
    useSessionStore.setState({ currentSessionId: null, unreadSessionIds: new Set<string>() });
    setAway(false);
  });
  afterEach(() => {
    setAway(false);
  });

  it('realrun39 order: NB1-NB4 get a dot, NB5 watched in the foreground does not', () => {
    open('NB1'); open('NB2'); // 用户在 NB2 里发任务后切到别的会话，NB1 在非当前会话完成
    complete('NB1'); // 前台非当前
    setAway(true);
    complete('NB2'); // 离开 + 当前
    open('NB3'); setAway(true);
    complete('NB3'); // 离开 + 当前
    open('NB4');
    complete('NB4'); // 离开 + 当前
    open('NB5'); setAway(false);
    complete('NB5'); // 前台盯着看
    expect(unread()).toEqual(['NB1', 'NB2', 'NB3', 'NB4']);
  });

  it('away + current session completion is marked even with no host notification involved', () => {
    open('A'); setAway(true);
    complete('A');
    expect(unread()).toEqual(['A']);
  });

  it('foreground completion of the current session stays unmarked', () => {
    open('A');
    complete('A');
    expect(unread()).toEqual([]);
  });

  it('non-current completion is still marked (Neo in front)', () => {
    open('A');
    complete('B');
    expect(unread()).toEqual(['B']);
  });

  describe('returning to the window', () => {
    it('focus clears only the current session dot', () => {
      open('A'); setAway(true);
      complete('A');
      useSessionStore.getState().markSessionUnread('B');
      const { unmount } = renderHook(() => useClearCurrentUnreadOnReturn());
      setAway(false);
      window.dispatchEvent(new Event('focus'));
      expect(unread()).toEqual(['B']);
      unmount();
    });

    it('opening another session first keeps the earlier dot; later focus does not clear it', () => {
      open('A'); setAway(true);
      complete('A');
      open('B');
      const { unmount } = renderHook(() => useClearCurrentUnreadOnReturn());
      setAway(false);
      window.dispatchEvent(new Event('focus'));
      expect(unread()).toEqual(['A']);
      unmount();
    });

    it('visibilitychange back to visible also clears the current dot', () => {
      open('A'); setAway(true);
      complete('A');
      const { unmount } = renderHook(() => useClearCurrentUnreadOnReturn());
      setAway(false);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(unread()).toEqual([]);
      unmount();
    });

    it('does nothing while the window is still away', () => {
      open('A'); setAway(true);
      complete('A');
      const { unmount } = renderHook(() => useClearCurrentUnreadOnReturn());
      window.dispatchEvent(new Event('focus'));
      expect(unread()).toEqual(['A']);
      unmount();
    });
  });
});
