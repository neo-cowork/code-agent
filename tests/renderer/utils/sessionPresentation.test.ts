import { describe, expect, it } from 'vitest';
import { buildSessionSearchText, getSessionStatusPresentation, getDisplaySessionTitle, getLocalizedSessionTitle, splitCronSessionTitleParts } from '../../../src/renderer/utils/sessionPresentation';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

describe('sessionPresentation', () => {
  it('explains background sessions before generic running state', () => {
    const status = getSessionStatusPresentation({
      backgroundSession: {
        sessionId: 'session-1',
        title: '后台任务',
        startedAt: Date.now() - 1_000,
        backgroundedAt: Date.now() - 500,
        status: 'running',
      },
      runtime: {
        sessionId: 'session-1',
        status: 'running',
        activeAgentCount: 1,
        contextHealth: null,
        lastActivityAt: Date.now(),
      },
      taskState: { status: 'running' },
    });

    expect(status.kind).toBe('background');
    expect(status.label).toBe('执行中');
    expect(status.showBadge).toBe(true);
  });

  it('labels prompt-only sessions as needing attention', () => {
    const status = getSessionStatusPresentation({
      messageCount: 1,
      turnCount: 1,
      sessionStatus: 'idle',
    });

    expect(status.kind).toBe('incomplete');
    expect(status.label).toBe('未完成');
    expect(status.showBadge).toBe(true);
  });

  it('keeps sessions with assistant output in the completed bucket without a sidebar badge', () => {
    const status = getSessionStatusPresentation({
      messageCount: 2,
      turnCount: 1,
      sessionStatus: 'idle',
    });

    expect(status.kind).toBe('done');
    expect(status.label).toBe('已完成');
    expect(status.showBadge).toBe(false);
  });

  it('prioritizes pending approvals over generic running state', () => {
    const status = getSessionStatusPresentation({
      hasPendingApproval: true,
      runtime: {
        sessionId: 'session-1',
        status: 'running',
        activeAgentCount: 1,
        contextHealth: null,
        lastActivityAt: Date.now(),
      },
    });

    expect(status.kind).toBe('approval');
    expect(status.label).toBe('待确认');
    expect(status.showBadge).toBe(true);
  });

  it('indexes snapshot and working directory into session search text', () => {
    const session: SessionWithMeta = {
      id: 'session-1',
      title: '修复浏览器上下文',
      modelConfig: { provider: 'openai', model: 'gpt-5.4' },
      createdAt: 1,
      updatedAt: 2,
      workingDirectory: '/repo/code-agent',
      messageCount: 8,
      turnCount: 3,
      workbenchSnapshot: {
        summary: '工作区 · Browser',
        labels: ['工作区', 'Browser'],
        recentToolNames: ['browser_action'],
      },
    };

    const text = buildSessionSearchText({
      session,
      snapshot: session.workbenchSnapshot,
      status: {
        kind: 'live',
        label: '执行中',
        toneClassName: '',
        showBadge: true,
      },
    });

    expect(text).toContain('修复浏览器上下文');
    expect(text).toContain('/repo/code-agent');
    expect(text).toContain('browser');
    expect(text).toContain('执行中');
  });
});

describe('placeholder display uses the current UI language', () => {
  it.each(['新对话', 'New conversation', 'New Chat', '新会话', '', null, undefined])('localises %j without rewriting storage', (title) => {
    expect(getDisplaySessionTitle(title, 'en')).toBe('New conversation');
    expect(getDisplaySessionTitle(title, 'zh')).toBe('新对话');
  });
  it('preserves named conversations and localises appshot fallback', () => {
    expect(getDisplaySessionTitle('Trip planning', 'zh')).toBe('Trip planning');
    expect(getDisplaySessionTitle('Session Native Workspace', 'zh')).toBe('Session Native Workspace');
    expect(getDisplaySessionTitle('CLI Session notes', 'en')).toBe('CLI Session notes');
    expect(getDisplaySessionTitle('<appshot>capture</appshot>', 'en')).toBe('Appshot conversation');
    expect(getDisplaySessionTitle('<appshot>capture</appshot>', 'zh')).toBe('Appshot 会话');
  });
});


describe('display-only automatic-session prefixes', () => {
  it.each([
    ['[Schedule]', '[定时]'], ['[Cron]', '[定时]'], ['[Heartbeat]', '[心跳]'],
  ])('localizes %s without changing editing or raw detection', (stored, localized) => {
    const title = `${stored} Morning notes`;
    expect(getLocalizedSessionTitle(title, 'zh')).toBe(`${localized} Morning notes`);
    expect(getLocalizedSessionTitle(title, 'en')).toBe(title);
    expect(getDisplaySessionTitle(title, 'zh')).toBe(`${localized} Morning notes`);
    expect(splitCronSessionTitleParts(title)).toEqual({ prefix: stored, name: 'Morning notes' });
    expect(getLocalizedSessionTitle('Manual task', 'zh')).toBe('Manual task');
  });
});

it('search indexes the visible cron prefix and the stored title', () => {
  const session = { title: '[Cron] 周报' } as Parameters<typeof buildSessionSearchText>[0]['session'];
  const status = getSessionStatusPresentation({});
  expect(buildSessionSearchText({ session, status, language: 'zh' })).toContain('[定时] 周报');
  expect(buildSessionSearchText({ session, status, language: 'zh' })).toContain('[cron] 周报');
  expect(buildSessionSearchText({ session, status, language: 'en' })).toContain('[schedule] 周报');
});

describe('automation titles stay localized at display time', () => {
  it.each([
    ['[Schedule] Weekly report', 'zh', '[定时] Weekly report'],
    ['[Heartbeat] 巡检', 'zh', '[心跳] 巡检'],
    ['[Cron] Old report', 'en', '[Schedule] Old report'],
    ['[Schedule] Weekly report', 'en', '[Schedule] Weekly report'],
    ['[Heartbeat] Check', 'en', '[Heartbeat] Check'],
  ] as const)('localizes %s in %s', (stored, language, expected) => {
    expect(getDisplaySessionTitle(stored, language)).toBe(expected);
    expect(splitCronSessionTitleParts(expected)?.name).toBe(stored.replace(/^\[\w+\] /, ''));
  });
  it('removes a legacy channel UUID but preserves the account and real chat names', () => {
    const legacy = '[Channel] Meeting notes channel · f3927c39-8924-43f1-86e4-8e5c9cc5086e';
    expect(getDisplaySessionTitle(legacy, 'zh')).toBe('渠道 · Meeting notes channel');
    expect(getDisplaySessionTitle(legacy, 'en')).toBe('Channel · Meeting notes channel');
    for (const id of ['oc_1234abcd', 'ou_9876abcd', '1234567890', 'chat_abcdef123456']) {
      expect(getDisplaySessionTitle(`[Channel] Work · ${id}`, 'zh')).toBe('渠道 · Work');
    }
    expect(getDisplaySessionTitle('[Channel] Work · Design team', 'en')).toBe('Channel · Work · Design team');
    expect(getDisplaySessionTitle('[Channel] Work · EngineeringCommunicationChannel', 'en')).toBe('Channel · Work · EngineeringCommunicationChannel');
    expect(getDisplaySessionTitle('Ordinary · title', 'zh')).toBe('Ordinary · title');
  });
});
