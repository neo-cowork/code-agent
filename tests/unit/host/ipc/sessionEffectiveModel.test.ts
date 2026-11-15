// N-FIX-MODEL-PICKER-SHOWS-WRONG-MODEL：输入框模型名取自 session/getEffectiveModel，
// 它必须和运行循环用同一个解析（resolveRunModelConfig），包括「默认 provider 没写 model」时的回落。
import { afterEach, describe, expect, it, vi } from 'vitest';

// 现场 Dev 配置的形状（2026-11-15 真机）：默认 = 云端下发的团队中转，没写 model；
// 同属 openai 家族、更新更晚且配了 key 的 custom-lyclaude 在切换器里把它去重掉了，
// 于是回落走到 DEFAULT_MODELS.chat（LongCat-2.0）——host 实跑的就是它。
const liveSettings = {
  models: {
    default: 'custom-team-relay',
    defaultProvider: 'custom-team-relay',
    providers: {
      'custom-team-relay': {
        enabled: true, managedByCloud: true, apiKeyConfigured: true, protocol: 'openai',
        baseUrl: 'https://relay.example/v1', displayName: '团队共享',
        models: { 'gpt-5.5': { enabled: true }, 'gpt-5.4-mini': { enabled: true, label: 'GPT-5.4 mini' } },
      },
      'custom-lyclaude': {
        enabled: true, apiKeyConfigured: true, protocol: 'openai', updatedAt: 1784618184616,
        baseUrl: 'https://ly.example/v1', model: 'gpt-5.6-sol',
        models: { 'gpt-5.5': { enabled: true }, 'gpt-5.6-sol': { enabled: true } },
      },
    },
  },
};

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => JSON.parse(JSON.stringify(liveSettings)),
    getApiKey: () => 'k',
  }),
}));

import { installDomainRoutes } from '../../../../src/host/ipc/domainRoutes/registry';
import { defineSessionRoutes, type SessionCommandContext } from '../../../../src/host/ipc/domainRoutes/sessionRoutes';
import { getModelSessionState } from '../../../../src/host/session/modelSessionState';
import { applyModelSettings } from '../../../../src/renderer/services/modelSettings';
import { useAppStore } from '../../../../src/renderer/stores/appStore';

async function getEffectiveModel(sessionId: string) {
  const registered = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>();
  installDomainRoutes({ handle: (ch: string, fn: never) => registered.set(ch, fn) }, defineSessionRoutes('web'), {} as SessionCommandContext);
  return registered.get('domain:session')?.(undefined, { action: 'getEffectiveModel', payload: { sessionId } });
}

afterEach(() => getModelSessionState().clearOverride('s1'));

describe('session/getEffectiveModel', () => {
  it('现场配置：默认 provider 没写 model → 返回 host 实跑的回落模型，而不是渲染层快照自己算的', async () => {
    await expect(getEffectiveModel('s1')).resolves.toEqual({
      success: true,
      data: { provider: 'custom-team-relay', model: 'LongCat-2.0', adaptive: false },
    });
  });

  it('会话 override 优先（与运行循环同一条解析链）', async () => {
    getModelSessionState().setOverride('s1', { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' } as never);
    await expect(getEffectiveModel('s1')).resolves.toMatchObject({
      data: { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' },
    });
  });

  it('渲染层自己另算的默认会随设置输入漂移：同一份配置只差一个 provider 的 key 状态，就从 LongCat 变成 gpt-5.5', () => {
    // 回落依赖切换器同族去重（谁配了 key、谁更新得晚），渲染层拿到的设置只要有一点不同，结果就和 host 不一致。
    const snapshot = JSON.parse(JSON.stringify(liveSettings));
    snapshot.models.providers['custom-lyclaude'].apiKeyConfigured = false;
    applyModelSettings(snapshot);
    expect(useAppStore.getState().modelConfig.model).toBe('gpt-5.5');
  });
});
