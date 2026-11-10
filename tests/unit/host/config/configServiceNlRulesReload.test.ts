// ============================================================================
// 保存 permissions.nlRules 必须立即装载进 PolicyEngine（N-PERM-NL-RULES-K2 r2）
// 真机 web 构建复现：只写 nlRules（一句话规则卡的保存路径）时，config.json 已落盘，
// 但引擎里 nlRules=0，规则要等重启才生效——handback/preapprove 整条链路形同虚设。
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ConfigService.updateSettings：只改 nlRules 也要重载规则', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'neo-nlrules-reload-'));
    vi.stubEnv('CODE_AGENT_DATA_DIR', join(root, 'env-data'));
    vi.stubEnv('CODE_AGENT_LOG_DIR', join(root, 'logger-sink'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('updateSettings({permissions:{nlRules}}) → 引擎立刻按该规则判 handback', async () => {
    const { ConfigService } = await import('../../../../src/host/services/core/configService');
    const { getPolicyEngine } = await import('../../../../src/host/permissions/policyEngine');
    const service = new ConfigService() as unknown as {
      configPath: string;
      updateSettings: (u: unknown) => Promise<void>;
    };
    service.configPath = join(root, 'data', 'config.json');
    await service.updateSettings({
      permissions: { nlRules: [{ behavior: 'handback', rule: 'Bash(rm *)' }] },
    });
    const matched = getPolicyEngine().matchUserRules(
      { tool: 'Bash', level: 'execute', description: 'x', command: 'rm /tmp/a' },
    );
    expect(matched.some((rule) => rule.userNlRule?.behavior === 'handback')).toBe(true);
  });

  // 返修（PR #2911 Important 2）：非 admin 可自助的 settings set 也要过高危探针。
  it('保存 preapprove 盖到 sudo 的规则 → 落盘前抛错，引擎里不出现该规则', async () => {
    const { ConfigService } = await import('../../../../src/host/services/core/configService');
    const { getPolicyEngine } = await import('../../../../src/host/permissions/policyEngine');
    const service = new ConfigService() as unknown as {
      configPath: string;
      updateSettings: (u: unknown) => Promise<void>;
    };
    service.configPath = join(root, 'data', 'config.json');
    await expect(service.updateSettings({
      permissions: { nlRules: [{ behavior: 'preapprove', rule: 'Bash(sudo *)', phrases: ['确认'] }] },
    })).rejects.toThrow(/protected/);
    expect(getPolicyEngine().getRules().some((rule) => rule.id.startsWith('user-nl:'))).toBe(false);
  });

  // 返修（PR #2911 Important 3）：改短语再保存，引擎必须换成新短语。
  it('同一条 preapprove 规则改短语再保存 → 引擎只认新短语', async () => {
    const { ConfigService } = await import('../../../../src/host/services/core/configService');
    const { getPolicyEngine } = await import('../../../../src/host/permissions/policyEngine');
    const service = new ConfigService() as unknown as {
      configPath: string;
      updateSettings: (u: unknown) => Promise<void>;
    };
    service.configPath = join(root, 'data', 'config.json');
    await service.updateSettings({
      permissions: { nlRules: [{ behavior: 'preapprove', rule: 'Bash(npm publish *)', phrases: ['确认发布', '照常发'] }] },
    });
    await service.updateSettings({
      permissions: { nlRules: [{ behavior: 'preapprove', rule: 'Bash(npm publish *)', phrases: ['照常发'] }] },
    });
    const phrases = getPolicyEngine().getRules()
      .filter((rule) => rule.userNlRule?.behavior === 'preapprove')
      .map((rule) => rule.userNlRule?.phrases);
    expect(phrases).toEqual([['照常发']]);
  });
});
