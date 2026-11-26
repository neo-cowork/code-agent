// English UI must show no Han in the three host-side copies fixed here; stored values and history filters stay Chinese.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_ROLES, RETIRED_BUILTIN_ROLE_VISUALS } from '../../src/host/services/roleAssets/builtinRoles';
import { localizeBuiltinRoleCopy } from '../../src/shared/localizeBuiltinRoleCopy';
import { localizeCronSessionTitle, localizeRoleWakeTitle } from '../../src/shared/cronSessionTitle';
import { ROLE_PROACTIVITY, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../src/shared/constants';
import { BackgroundTaskManager } from '../../src/host/session/backgroundTaskManager';
import { isSyntheticWakeTask } from '../../src/host/services/roleAssets/roleWriteBack';
import { lastWakeDateFromHistory } from '../../src/host/services/roleAssets/roleWakeFindWork';

const HAN = /\p{Script=Han}/u;
const { sessionManager, notifyTaskComplete, settings } = vi.hoisted(() => ({
  sessionManager: { getSession: vi.fn(), getSessionTitle: vi.fn(), getMessages: vi.fn() },
  notifyTaskComplete: vi.fn(),
  settings: { language: 'en' as 'en' | 'zh' },
}));
vi.mock('../../src/host/services', () => ({
  getSessionManager: () => sessionManager,
  notificationService: { notifyTaskComplete },
}));
vi.mock('../../src/host/services/infra/notificationHeldStore', () => ({ readHeldFile: () => [], writeHeldFile: () => undefined }));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: settings.language } }) }),
}));

const WAKE = ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX;
const factoryDescription = (agentMd: string) => /^description: (.*)$/m.exec(agentMd)?.[1] ?? '';

describe('built-in expert copy in English UI', () => {
  it.each(BUILTIN_ROLES.map((role) => [role.id, role] as const))('%s has English description, tags and quick prompts', (id, role) => {
    const out = localizeBuiltinRoleCopy(id, {
      description: factoryDescription(role.agentMd), tags: role.visual.tags, quickPrompts: role.visual.quickPrompts,
    }, 'en');
    expect(out.description).not.toBe(factoryDescription(role.agentMd));
    for (const text of [out.description, ...out.tags, ...out.quickPrompts]) {
      expect(text).toBeTruthy();
      expect(text).not.toMatch(HAN);
    }
    expect(out.tags).toHaveLength(role.visual.tags.length);
    expect(out.quickPrompts).toHaveLength(role.visual.quickPrompts.length);
  });

  it('covers the retired researcher visual', () => {
    const v = RETIRED_BUILTIN_ROLE_VISUALS['研究员'];
    const out = localizeBuiltinRoleCopy('研究员', { tags: v.tags, quickPrompts: v.quickPrompts }, 'en');
    for (const text of [...out.tags, ...out.quickPrompts]) expect(text).not.toMatch(HAN);
  });

  it('keeps zh, user-edited descriptions and user-created roles unchanged', () => {
    const role = BUILTIN_ROLES[0];
    const copy = { description: factoryDescription(role.agentMd), tags: role.visual.tags, quickPrompts: role.visual.quickPrompts };
    expect(localizeBuiltinRoleCopy(role.id, copy, 'zh')).toBe(copy);
    expect(localizeBuiltinRoleCopy(role.id, { ...copy, description: '我改过的描述' }, 'en').description).toBe('我改过的描述');
    expect(localizeBuiltinRoleCopy('我的专家', copy, 'en')).toBe(copy);
  });
});

describe('role wake titles', () => {
  it.each([
    [`牧之 · ${WAKE} 11-25 09:00`, 'Muzhi · Proactive check 11-25 09:00'],
    [`牧之 · ${WAKE}`, 'Muzhi · Proactive check'],
    [`我的专家 · ${WAKE} 11-25 09:00`, '我的专家 · Proactive check 11-25 09:00'],
    [`2026-11-25 ${WAKE}`, '2026-11-25 Proactive check'],
  ])('renders %s in English and keeps zh', (stored, en) => {
    expect(localizeRoleWakeTitle(stored, 'en')).toBe(en);
    expect(localizeCronSessionTitle(stored, 'en')).toBe(en);
    expect(localizeRoleWakeTitle(stored, 'zh')).toBe(stored);
    expect(localizeCronSessionTitle(stored, 'zh')).toBe(stored);
  });

  it('no Han for every built-in role id', () => {
    for (const role of BUILTIN_ROLES) {
      expect(localizeRoleWakeTitle(`${role.id} · ${WAKE} 11-25 09:00`, 'en')).not.toMatch(HAN);
    }
  });

  it('history filters still match stored Chinese lines while ui.language=en', () => {
    settings.language = 'en';
    expect(isSyntheticWakeTask(`${WAKE}（cadence 触发）`)).toBe(true);
    expect(lastWakeDateFromHistory([`- 2026-11-20 | ${WAKE}(cadence) | - | 摘要`])).toBeDefined();
  });
});

describe('background task failure notification body', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionManager.getMessages.mockResolvedValue([]);
    sessionManager.getSessionTitle.mockReturnValue('Review the contract');
  });

  async function fail(error?: string) {
    const manager = new BackgroundTaskManager();
    sessionManager.getSession.mockResolvedValue({ title: 'Review the contract', messages: [] });
    await manager.moveToBackground('s-1');
    await manager.markFailed('s-1', error);
    return notifyTaskComplete.mock.calls[0][0].summary as string;
  }

  it.each([[RUN_ERROR_CODE_MAX_ITERATIONS], ['Provider auth failure'], [undefined]])('en body has no Han for %s', async (error) => {
    settings.language = 'en';
    expect(await fail(error)).not.toMatch(HAN);
  });

  it('zh body stays Chinese', async () => {
    settings.language = 'zh';
    expect(await fail(undefined)).toBe('任务失败: 未知错误');
    notifyTaskComplete.mockClear();
    expect(await fail(RUN_ERROR_CODE_MAX_ITERATIONS)).toContain('最大执行轮次');
  });
});

describe('realtime role wake desktop notification (production notificationService)', () => {
  beforeEach(() => { vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function wake(lang: 'en' | 'zh', roleId: string, body: string) {
    settings.language = lang;
    vi.resetModules();
    const { notificationService: service } = await import('../../src/host/services/infra/notificationService');
    service.notifyRoleWakeOutput({ sessionId: 'wake-1', title: `${roleId} · ${WAKE}`, body, roleId });
    return service.getRecentNotifications().at(-1)!;
  }

  it('en title and fallback body have no Han', async () => {
    const entry = await wake('en', '牧之', '');
    expect(entry.title).toBe('Muzhi · Proactive check');
    expect(entry.body).toBe('Muzhi produced new output');
    expect(`${entry.title}${entry.body}`).not.toMatch(HAN);
  });

  it('zh title and fallback body stay Chinese', async () => {
    const entry = await wake('zh', '牧之', '');
    expect(entry.title).toBe(`牧之 · ${WAKE}`);
    expect(entry.body).toBe('角色 牧之 醒来产出了新内容');
  });
});
