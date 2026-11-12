import { describe, expect, it } from 'vitest';
import { buildCronAgentPrompt } from '../../../src/host/cron/cronAgentPrompt';
import { normalizeAction } from '../../../src/host/cron/cronNormalizers';
import { withWorkbenchTurnSystemContext } from '../../../src/host/app/workbenchTurnContext';
import { buildCronJobInput, buildDraftFromJob, createDefaultCronJobDraft } from '../../../src/renderer/components/features/cron/types';
import { CRON_PERSONAL_SKILLS } from '../../../src/shared/constants/cronPersonalSkills';

const optedIn = ['wechat-local-query'];

describe('cron personal skill selection', () => {
  it('normalizes names, rejects paths/commands and invalid shapes, deduplicates and caps', () => {
    const action = normalizeAction({ type: 'agent', agentType: 'default', prompt: '晨间分诊',
      allowedPersonalSkillIds: [' wechat-local-query ', 'wechat-local-query', '', 1, '/tmp/skill', '../skill',
        'printf ok', '..', 'x'.repeat(CRON_PERSONAL_SKILLS.MAX_NAME_CHARS + 1),
        ...Array.from({ length: 100 }, (_, i) => `skill-${i}`)],
    });
    expect(action?.type).toBe('agent');
    if (action?.type !== 'agent') throw new Error('Expected agent action');
    expect(action.allowedPersonalSkillIds).toHaveLength(CRON_PERSONAL_SKILLS.MAX_IDS);
    expect(action.allowedPersonalSkillIds?.slice(0, 3)).toEqual(['wechat-local-query', 'skill-0', 'skill-1']);
    for (const value of [undefined, [], '', 'wechat-local-query', [null, false, '  ']]) {
      expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: '晨间分诊', allowedPersonalSkillIds: value }))
        .toHaveProperty('allowedPersonalSkillIds', undefined);
    }
  });

  it.each([false, true])('public prompt points to the switch by default and omits the denial after opt-in (snapshot=%s)', (enabled) => {
    const build = (ids?: string[]) => buildCronAgentPrompt('汇总邮件、微信和日历', undefined, enabled,
      new Date('2026-11-10T08:00:00Z'), undefined, undefined, 'UTC', ids);
    expect(build()).toContain('未读取：微信/IM（定时任务默认不读个人聊天记录；想读，请在任务编辑的「执行动作」页勾选「允许本任务使用这些个人技能」）');
    expect(build([])).toEqual(build());
    expect(build(['   '])).toEqual(build());
    expect(build(optedIn)).not.toContain('默认不读个人聊天记录');
    expect(build(optedIn)).not.toContain('不要搜索或调用读取个人聊天记录');
    expect(build(optedIn)).toContain('本任务已允许使用这些个人技能：wechat-local-query');
    expect(build(optedIn)).toContain('它要执行的命令仍须请用户批准，未获批准不得声称已读取');
    expect(build(optedIn)).toContain('【当前时间】');
  });

  it('survives job → draft → saved job and clearing; new drafts have no consent', () => {
    const draft = createDefaultCronJobDraft();
    expect(draft.agentAllowedPersonalSkillIds).toEqual([]);
    draft.name = '晨间分诊'; draft.actionType = 'agent'; draft.agentPrompt = '汇总邮件、即时消息和日历';
    draft.agentAllowedPersonalSkillIds = optedIn;
    const saved = buildCronJobInput(draft);
    expect(saved.action).toHaveProperty('allowedPersonalSkillIds', optedIn);
    const restored = buildDraftFromJob({ ...saved, runsOn: 'local', id: 'morning', createdAt: 1, updatedAt: 1 });
    expect(restored.agentAllowedPersonalSkillIds).toEqual(optedIn);
    restored.agentAllowedPersonalSkillIds = [];
    expect(buildCronJobInput(restored).action).toHaveProperty('allowedPersonalSkillIds', undefined);
  });

  it('keeps opt-ins through the public turn-context merger without introducing narrowing lists', () => {
    const options = withWorkbenchTurnSystemContext({ mode: 'normal', toolScope: { optInPersonalSkillIds: optedIn } });
    expect(options?.toolScope).toEqual({ optInPersonalSkillIds: optedIn });
    expect(options?.toolScope?.allowedSkillIds).toBeUndefined();
    expect(options?.toolScope?.allowedConnectorIds).toBeUndefined();
    expect(options?.toolScope?.allowedMcpServerIds).toBeUndefined();
  });
});
