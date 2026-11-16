import { describe, expect, it } from 'vitest';
import { languages } from '../../../src/renderer/i18n';
import type { HookActivityEvent } from '../../../src/renderer/stores/turnExecutionStore';
import { buildTurnExecutionClarityProjection } from '../../../src/renderer/utils/turnTimelineProjection';

type Args = Parameters<typeof buildTurnExecutionClarityProjection>[0];
const HAN = /[㐀-䶿一-鿿豈-﫿]/u;

function hook(event: string, extra: Partial<HookActivityEvent> = {}): HookActivityEvent {
  return {
    sessionId: 's', timestamp: 130, event, action: 'allow', hookCount: 1, durationMs: 5, sources: ['global'], ...extra,
  } as HookActivityEvent;
}

function summaryOf(language: 'zh' | 'en', hookEvents: HookActivityEvent[]): string | undefined {
  const enriched = buildTurnExecutionClarityProjection({
    hookCopy: languages[language].turnHooks,
    projection: {
      sessionId: 's',
      activeTurnIndex: -1,
      turns: [{
        turnNumber: 1, turnId: 'turn-1', status: 'completed', startTime: 120, endTime: 180,
        nodes: [
          { id: 'u', type: 'user', content: 'run the hooks', timestamp: 100 },
          { id: 'a', type: 'assistant_text', content: 'done', timestamp: 160 },
        ],
      }],
    },
    capabilities: {} as Args['capabilities'],
    launchRequests: [],
    swarmEvents: [],
    routingEvents: [],
    hookEvents,
  });
  return enriched.turns[0]?.nodes.find((node) => node.turnTimeline?.kind === 'hook_activity')?.turnTimeline?.hookActivity?.summary;
}

describe('Hooks 折叠行摘要跟随界面语言（FB-1151）', () => {
  const twoMoments = [hook('UserPromptSubmit'), hook('PreToolUse', { hookCount: 2 })];
  const named = [hook('UserPromptSubmit', { names: ['persona', 'memory-index'] }), hook('PreToolUse', { names: ['memory-index'] })];
  const blocked = [hook('PreToolUse', { action: 'block' }), hook('Stop', { action: 'block' })];
  const errored = [hook('PreToolUse', { errorCount: 2 })];

  it('中文与改动前逐字相同', () => {
    expect(summaryOf('zh', twoMoments)).toBe('2 个时机 · 3 个 hook');
    expect(summaryOf('zh', named)).toBe('2 个时机 · persona、memory-index');
    expect(summaryOf('zh', blocked)).toBe('拦下 2 次 · 2 个时机 · 2 个 hook');
    expect(summaryOf('zh', errored)).toBe('2 个出错 · PreToolUse · 1 个 hook');
  });

  it('英文没有中文', () => {
    expect(summaryOf('en', twoMoments)).toBe('2 hook events · 3 hooks');
    expect(summaryOf('en', named)).toBe('2 hook events · persona, memory-index');
    expect(summaryOf('en', blocked)).toBe('Blocked 2× · 2 hook events · 2 hooks');
    expect(summaryOf('en', errored)).toBe('2 failed · PreToolUse · 1 hook');
    for (const events of [twoMoments, named, blocked, errored]) expect(summaryOf('en', events)).not.toMatch(HAN);
  });
});
