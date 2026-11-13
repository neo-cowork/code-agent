// @vitest-environment jsdom
// N-BROWSER-WAIT-FOR-USER-RESUME-W2 rework: the chat run card carries the Done button (no side panel needed).
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SurfaceExecutionConversationPanel } from '../../../../src/renderer/components/features/surfaceExecution/SurfaceExecutionConversationPanel';
import { getSurfaceExecutionTranslations, surfaceExecutionZh } from '../../../../src/renderer/i18n/surfaceExecution';
import { selectBrowserWaitForUserV1 } from '../../../../src/renderer/utils/surfaceExecutionProjection';
import { surfaceEvent, surfaceScope, surfaceSession } from './fixtures';

afterEach(() => cleanup());

function waitingSession(reason: string, action: 'wait_for_user' | 'wait_for_user_timeout' | null = 'wait_for_user') {
  const scope = surfaceScope('w');
  const base = surfaceSession({ id: 'w', state: 'waiting_human' });
  return {
    ...base,
    availableControls: ['resume', 'stop', 'end_session'] as typeof base.availableControls,
    events: [surfaceEvent(scope, {
      sessionState: 'waiting_human',
      phase: 'human',
      status: 'waiting',
      userSummary: reason,
      ...(action ? { operation: { action, risk: 'control' } } : {}),
      availableControls: ['resume', 'stop', 'end_session'],
    })],
  };
}

describe('chat run card while Neo waits for the user', () => {
  it('shows Done on the card and sends the existing resume control', async () => {
    const onControl = vi.fn().mockResolvedValue(undefined);
    render(
      <SurfaceExecutionConversationPanel
        conversationId="conversation-1"
        sessions={[waitingSession('请在浏览器里完成人机验证，完成后点确认。')]}
        translations={surfaceExecutionZh}
        now={10_000}
        onControl={onControl}
      />,
    );
    const card = screen.getByTestId('surface-human-takeover-card');
    expect(card.textContent).toContain('Neo 在等你');
    expect(card.textContent).toContain('请在浏览器里完成人机验证');
    expect(card.textContent).not.toContain('点确认');
    // the card header stage line and the timeline read the same shared layer
    expect(screen.getByTestId('surface-execution-session').textContent).not.toContain('点确认');
    fireEvent.click(screen.getByTestId('surface-human-takeover-done'));
    await waitFor(() => expect(onControl).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-w',
      action: 'resume',
    }));
  });

  it('after the wait ran out the card says Neo stopped and still offers Done', () => {
    render(
      <SurfaceExecutionConversationPanel
        conversationId="conversation-1"
        sessions={[waitingSession('请登录你的账号', 'wait_for_user_timeout')]}
        translations={getSurfaceExecutionTranslations('en')}
        now={10_000}
        onControl={vi.fn()}
      />,
    );
    expect(screen.getByTestId('surface-human-takeover-card').textContent).toContain('Neo stopped and is waiting for you');
    expect(screen.getByTestId('surface-human-takeover-done').textContent).toBe('Done');
  });

  it('a takeover the user started keeps the old card without Done', () => {
    render(
      <SurfaceExecutionConversationPanel
        conversationId="conversation-1"
        sessions={[waitingSession('Waiting for human control', null)]}
        translations={surfaceExecutionZh}
        now={10_000}
        onControl={vi.fn()}
      />,
    );
    expect(screen.getByTestId('surface-human-takeover-card').textContent).toContain('需要你接管');
    expect(screen.queryByTestId('surface-human-takeover-done')).toBeNull();
  });
});

describe('reason never names another button', () => {
  it.each([
    ['发票门户要求人机验证，请在打开的浏览器窗口里手动完成验证，完成后点确认。', '发票门户要求人机验证，请在打开的浏览器窗口里手动完成验证'],
    ['发票门户要求先完成人机验证，请在浏览器窗口里操作好，然后点完成让我继续。', '发票门户要求先完成人机验证，请在浏览器窗口里操作好'],
    ['发票门户需要人工完成人机验证，请在浏览器里操作，完成后点 Done。', '发票门户需要人工完成人机验证，请在浏览器里操作'],
    ['页面要求人机验证，请在浏览器窗口中手动完成验证，然后点 Done。', '页面要求人机验证，请在浏览器窗口中手动完成验证'],
    ['请在打开的浏览器页面里勾选「I\'m not a robot」完成人机验证，通过后点 Done。', '请在打开的浏览器页面里勾选「I\'m not a robot」完成人机验证'],
    ['Please solve the verification in the browser, then click Done.', 'Please solve the verification in the browser'],
  ])('%s', (input, expected) => {
    expect(selectBrowserWaitForUserV1(waitingSession(input))?.reason).toBe(expected);
  });

  it('leaves reasons without a button instruction alone (including 点击 + a page element)', () => {
    for (const ok of ['请完成页面上的人机验证', '请点击页面里的验证码方块完成验证', '请登录你的账号']) {
      expect(selectBrowserWaitForUserV1(waitingSession(ok))?.reason).toBe(ok);
    }
  });

  it('is applied by the shared selector both the bar and the card read', () => {
    const picked = selectBrowserWaitForUserV1(waitingSession('请完成验证，完成后点确认。'));
    expect(picked?.reason).toBe('请完成验证');
  });
});
