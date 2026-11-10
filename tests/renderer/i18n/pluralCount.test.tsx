// @vitest-environment jsdom
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { interpolate, interpolatePlural } from '../../../src/renderer/i18n/interpolate';

function rendered(template: { one: string; other: string }, count: number, extra: Record<string, string | number> = {}): string {
  return render(<span>{interpolate(interpolatePlural(template, count), extra)}</span>).container.textContent ?? '';
}

describe('English count copy', () => {
  it('renders thinking digest singular and plural in the DOM', () => {
    expect(rendered(en.chat.thinkingDigestWithDuration, 1, { duration: '1s' })).toBe('Thought for 1s · 1 segment');
    expect(rendered(en.chat.thinkingDigestWithDuration, 2, { duration: '1s' })).toBe('Thought for 1s · 2 segments');
  });

  it('renders agent stats and failed status with correct agreement', () => {
    expect(rendered(en.expert.memberBar.collapsedWorking, 1)).toBe('1 agent working');
    expect(rendered(en.expert.memberBar.collapsedWaiting, 1)).toBe('1 agent waiting');
    expect(rendered(en.expert.memberBar.collapsedStandby, 1)).toBe('1 agent on standby');
    expect(rendered(en.expert.memberBar.collapsedCancelled, 1)).toContain('1 agent ·');
    expect(rendered(en.expert.memberBar.collapsedFailed, 1)).toBe('1 agent · Failed');
    expect(rendered(en.expert.memberBar.collapsedFailed, 3)).toBe('3 agents · Failed');
    expect(rendered(en.expert.memberBar.stopAllTitle, 1)).toBe('Stop all 1 agent');
    expect(rendered(en.expert.memberBar.stopAllTitle, 3)).toBe('Stop all 3 agents');
    expect(rendered(en.agentMentionRouting.directPlaceholderMulti, 1)).toBe('To 1 agent — or keep typing @agent…');
    expect(rendered(en.agentMentionRouting.directPlaceholderMulti, 3)).toBe('To 3 agents — or keep typing @agent…');
    expect(rendered(en.chat.waitingSubagentFleet, 1)).toBe('1 agent working in parallel');
    expect(rendered(en.chat.waitingSubagentFleet, 3)).toBe('3 agents working in parallel');
  });

  it('renders the parked approval title and keeps Chinese copy unchanged', () => {
    expect(rendered(en.cronCenter.parkedTitle, 1)).toBe('1 action waiting for you to confirm');
    expect(rendered(en.cronCenter.parkedTitle, 5)).toBe('5 actions waiting for you to confirm');
    expect(rendered(en.sessionInspector.activity.browser, 1)).toBe('1 browser action');
    expect(rendered(en.sessionInspector.activity.browser, 4)).toBe('4 browser actions');
    expect(rendered(zh.chat.thinkingDigestWithDuration, 1, { duration: '1s' })).toBe('思考 1s · 1 段');
    expect(rendered(zh.chat.thinkingDigestWithDuration, 2, { duration: '1s' })).toBe('思考 1s · 2 段');
    expect(rendered(zh.cronCenter.parkedTitle, 1)).toBe('1 个操作等你确认');
    expect(rendered(zh.cronCenter.parkedTitle, 5)).toBe('5 个操作等你确认');
  });
});
