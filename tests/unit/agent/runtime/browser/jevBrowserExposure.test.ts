// execute_goal 暴露面：开关三态（=0 关 / 其余开）× Jev 路由探针。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import {
  browserJevStepDescriptionSuffix,
  isBrowserJevStepEnabled,
  registerBrowserJevRouteProbe,
  withBrowserJevStepActionEnum,
} from '../../../../../src/shared/constants/jevQuestions';
import { browserSchema } from '../../../../../src/host/plugins/builtin/browserControl/browser.schema';
import { BrowserTool } from '../../../../../src/host/tools/vision/BrowserTool';

const PARAMS = ['task', 'assertions', 'jevBudgetUsd'];
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const surface = () => ({ d: browserSchema.description, s: browserSchema.inputSchema });
const exposed = () => {
  const props = browserSchema.inputSchema.properties ?? {};
  return {
    enumHas: (props.action?.enum as string[]).includes('execute_goal'),
    params: PARAMS.filter((k) => k in props),
    suffix: browserSchema.description.includes('Goal execution (execute_goal)'),
  };
};

describe('browser execute_goal exposure', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    vi.unstubAllEnvs();
    registerBrowserJevRouteProbe(null);
  });

  it('开关三态：=0 关，未设/=1 开', () => {
    expect(isBrowserJevStepEnabled({})).toBe(true);
    expect(isBrowserJevStepEnabled({ CODE_AGENT_BROWSER_JEV_STEP: '1' })).toBe(true);
    expect(isBrowserJevStepEnabled({ CODE_AGENT_BROWSER_JEV_STEP: '0' })).toBe(false);
  });

  it('未设 + 有路由 → 枚举/参数/描述后缀都在，BrowserTool 同形', () => {
    registerBrowserJevRouteProbe(() => true);
    expect(exposed()).toEqual({ enumHas: true, params: PARAMS, suffix: true });
    expect(BrowserTool.inputSchema).toEqual(browserSchema.inputSchema);
  });

  it('=0 + 有路由 → 全部不暴露', () => {
    registerBrowserJevRouteProbe(() => true);
    vi.stubEnv('CODE_AGENT_BROWSER_JEV_STEP', '0');
    expect(exposed()).toEqual({ enumHas: false, params: [], suffix: false });
  });

  it('未设 + 无路由 / 未注册探针 → 不暴露，且与 =0 逐字节一致', () => {
    registerBrowserJevRouteProbe(() => true);
    vi.stubEnv('CODE_AGENT_BROWSER_JEV_STEP', '0');
    const off = sha(surface());
    vi.unstubAllEnvs();
    registerBrowserJevRouteProbe(() => false);
    expect(exposed()).toEqual({ enumHas: false, params: [], suffix: false });
    expect(sha(surface())).toBe(off);
    registerBrowserJevRouteProbe(null);
    expect(sha(surface())).toBe(off);
  });

  it('探针抛错 → 不暴露，只 warn 一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerBrowserJevRouteProbe(() => { throw new Error('config mock missing'); });
    expect(browserJevStepDescriptionSuffix()).toBe('');
    expect(withBrowserJevStepActionEnum(browserSchema.inputSchema).properties?.task).toBeUndefined();
    expect(browserJevStepDescriptionSuffix()).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('route probe threw');
    warn.mockRestore();
  });
});
