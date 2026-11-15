// ============================================================================
// initializeCLIServices --bare 纯净模式（N-HEADLESS-BARE-BUILTIN）
// 走真公共入口 initializeCLIServices/buildCLIConfig/syncCLIWorkingDirectory/cleanup，
// mock 只打在模块边界（skills 发现、MCP client、数据库、配置服务等）。
// 钉住的不变量：--bare 下 skills 走 builtin-only、hooks/MCP 仍跳过，
// 且 CODE_AGENT_ENABLE_ARGUS_MCP=1 也不能把 MCP 自动接入带回来；
// 不带 --bare 时三者照常开启（历史行为逐字节不变）。
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // 模拟发现服务的 builtin-only 翻转：bootstrap 的 setBuiltinOnly 真改它，指纹据此如实报告
  const skillServiceState = { builtinOnly: false };
  return {
    getSettings: vi.fn(() => ({})),
    getApiKey: vi.fn((provider: string) => `${provider}-test-key`),
    skillServiceState,
    skillInitialize: vi.fn(async () => {}),
    skillEnsureInitialized: vi.fn(async () => {}),
    skillSetBuiltinOnly: vi.fn((builtinOnly: boolean) => {
      skillServiceState.builtinOnly = builtinOnly;
    }),
    initMCPClient: vi.fn(async () => {}),
    mcpDisconnectAll: vi.fn(async () => {}),
    getMCPClient: vi.fn(),
    initCLIDatabase: vi.fn(),
    probeEnvCapabilities: vi.fn(async () => {}),
    reapChildProcesses: vi.fn(async () => {}),
  };
});

vi.mock('../../../src/host/services/skills', () => ({
  getSkillDiscoveryService: () => ({
    initialize: mocks.skillInitialize,
    ensureInitialized: mocks.skillEnsureInitialized,
    setBuiltinOnly: mocks.skillSetBuiltinOnly,
    isBuiltinOnly: () => mocks.skillServiceState.builtinOnly,
    isInitialized: () => true,
    getAllSkills: () => [],
  }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  initMCPClient: mocks.initMCPClient,
  getMCPClient: () => ({
    disconnectAll: mocks.mcpDisconnectAll,
    // 指纹实况快照从这里读：非 bare 的 mcpServers 必须真的来自 getStatus()
    getStatus: () => ({ connectedServers: ['cli-bare-stub-mcp'] }),
  }),
}));

// computer-use 安装态固定未安装：MCP 触发只剩 env 一条路，测试可控
vi.mock('../../../src/host/plugins/builtin/computerUse/installState', () => ({
  isComputerUseCapabilityInstalledSync: () => false,
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  initConfigService: () => ({
    initialize: async () => {},
    getSettings: mocks.getSettings,
    getApiKey: mocks.getApiKey,
  }),
  getConfigService: () => ({
    initialize: async () => {},
    getSettings: mocks.getSettings,
    getApiKey: mocks.getApiKey,
  }),
}));

// 数据库 mock 成 null：走 bootstrap 既有的 fail-safe 分支（警告后继续，durable run 跳过）
vi.mock('../../../src/cli/database', () => ({
  initCLIDatabase: mocks.initCLIDatabase,
}));
vi.mock('../../../src/cli/session', () => ({
  getCLISessionManager: () => ({}),
}));
vi.mock('../../../src/cli/cliLedgerSink', () => ({
  createCliLedgerSink: () => ({}),
}));
vi.mock('../../../src/host/tools/toolLedgerSink', () => ({
  setToolLedgerSink: () => {},
}));

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: vi.fn(),
}));
vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {
    setWorkingDirectory = vi.fn();
  },
}));
vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: vi.fn(() => ({})),
}));
vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: vi.fn(),
}));
vi.mock('../../../src/host/services/core/envCapabilities', () => ({
  probeEnvCapabilities: mocks.probeEnvCapabilities,
}));
vi.mock('../../../src/host/tools/shell/shutdownReaper', () => ({
  reapChildProcesses: mocks.reapChildProcesses,
}));

import { buildCLIConfig, cleanup, initializeCLIServices } from '../../../src/cli/bootstrap';
import { resolveProviderBaseUrl } from '../../../src/host/model/providers/providerResolution';
import { MODEL_API_ENDPOINTS } from '../../../src/shared/constants';

describe('buildCLIConfig provider transport settings', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-endpoint-'));
    vi.stubEnv('CODE_AGENT_DATA_DIR', tmpDir);
    vi.stubEnv('CODE_AGENT_ENABLE_ARGUS_MCP', '0');
    mocks.initCLIDatabase.mockResolvedValue(null);
    mocks.getSettings.mockReturnValue({});
    await initializeCLIServices({ bare: true });
  });
  afterEach(async () => {
    await cleanup();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes configured endpoint and protocol to the real provider resolver', () => {
    mocks.getSettings.mockReturnValue({ models: { defaultProvider: 'zhipu', providers: {
      zhipu: { model: 'glm-5.3', baseUrl: 'http://127.0.0.1:9988/v4', protocol: 'openai' },
    } } });
    const config = buildCLIConfig({}).modelConfig;
    expect(config).toMatchObject({ provider: 'zhipu', apiKey: 'zhipu-test-key',
      baseUrl: 'http://127.0.0.1:9988/v4', protocol: 'openai' });
    expect(resolveProviderBaseUrl(config)).toBe('http://127.0.0.1:9988/v4');
  });

  it('uses the built-in default when no endpoint is configured', () => {
    const config = buildCLIConfig({ provider: 'zhipu', model: 'glm-5.3' }).modelConfig;
    expect(config.baseUrl).toBeUndefined();
    expect(config.protocol).toBeUndefined();
    expect(resolveProviderBaseUrl(config)).toBe(MODEL_API_ENDPOINTS.zhipu);
  });

  it('explicit provider switch never inherits the default provider endpoint or key', () => {
    mocks.getSettings.mockReturnValue({ models: { defaultProvider: 'openai', providers: {
      openai: { baseUrl: 'https://previous.test/v1', protocol: 'openai' },
      zhipu: { model: 'glm-5.3' },
    } } });
    const config = buildCLIConfig({ provider: 'zhipu' }).modelConfig;
    expect(config).toMatchObject({ provider: 'zhipu', apiKey: 'zhipu-test-key' });
    expect(config.baseUrl).toBeUndefined();
    expect(config.protocol).toBeUndefined();
    expect(resolveProviderBaseUrl(config)).toBe(MODEL_API_ENDPOINTS.zhipu);
  });

  it('normalizes explicit aliases before looking up provider settings and key', () => {
    mocks.getSettings.mockReturnValue({ models: { providers: {
      claude: { model: 'test-model', baseUrl: 'https://claude.test/v1', protocol: 'claude' },
    } } });
    expect(buildCLIConfig({ provider: 'anthropic' }).modelConfig).toMatchObject({
      provider: 'claude', apiKey: 'claude-test-key', baseUrl: 'https://claude.test/v1', protocol: 'claude',
    });
  });
});
