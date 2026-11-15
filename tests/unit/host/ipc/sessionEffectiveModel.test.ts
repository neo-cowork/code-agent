// N-FIX-MODEL-PICKER-SHOWS-WRONG-MODEL：输入框模型名取自 session/getEffectiveModel，
// 它必须和运行循环用同一个解析（resolveRunModelConfig），包括「默认 provider 没写 model」时的回落。
import { afterEach, describe, expect, it, vi } from 'vitest';

// 现场 Dev 配置的形状（2026-11-15 真机）：默认 = 云端下发的团队中转，没写 model。
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
  it('现场配置：默认 provider 没写 model → 与渲染层 applyModelSettings 一致（运行入口同口径由 bootstrap.providerEndpoint 钉住）', async () => {
    applyModelSettings(JSON.parse(JSON.stringify(liveSettings)));
    await expect(getEffectiveModel('s1')).resolves.toEqual({
      success: true,
      data: { provider: 'custom-team-relay', model: 'gpt-5.5', adaptive: false },
    });
    expect(useAppStore.getState().modelConfig.model).toBe('gpt-5.5');
  });

  it('会话 override 优先（与运行循环同一条解析链）', async () => {
    getModelSessionState().setOverride('s1', { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' } as never);
    await expect(getEffectiveModel('s1')).resolves.toMatchObject({
      data: { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' },
    });
  });

});
