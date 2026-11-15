// @vitest-environment jsdom
// N-FIX-STEP-HEADER-AND-STOPPED-ROW-REPEAT ②：停住任务的原因行与录制条同时出现时不叠成多行。
// 录制条是自闸占用者，必须自报活跃态，停靠行才知道要让位（selectComposerStatusBarActive）。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MeetingBar } from '../../../src/renderer/components/features/chat/ChatInput/MeetingBar';
import { useMeetingSessionStore } from '../../../src/renderer/stores/meetingSessionStore';
import { selectComposerStatusBarActive, useComposerNoticeStore } from '../../../src/renderer/stores/composerNoticeStore';

const active = () => selectComposerStatusBarActive(useComposerNoticeStore.getState());

describe('composer status bars announce themselves so the parked row can yield', () => {
  afterEach(() => cleanup());

  it('a recording meeting bar marks the status bar slot active; ending it clears the mark', () => {
    useMeetingSessionStore.setState({
      refresh: async () => undefined,
      error: null,
      status: {
        current: { id: 'm1', title: '周会', state: 'recording', startedAtMs: Date.now() } as never,
        silenceMs: 0,
        silenceWarning: false,
        lastEnded: null,
      },
    });
    const { unmount } = render(<MeetingBar />);
    expect(active()).toBe(true);
    unmount();
    expect(active()).toBe(false);

    useMeetingSessionStore.setState({ status: { current: null, silenceMs: 0, silenceWarning: false, lastEnded: null } });
    render(<MeetingBar />);
    expect(active()).toBe(false);
  });
});
