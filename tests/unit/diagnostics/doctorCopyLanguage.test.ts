import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  authFailure: null as { provider: string; model: string; status: number; at: number } | null,
  modelFailure: null as { provider?: string; model?: string; failureReason: string; status?: number; at: number } | null,
  mcpStates: [] as Array<{ config: { name: string }; status: string; toolCount: number; resourceCount: number; error?: string }>,
}));

vi.mock('../../../src/host/session/sessionTitleHostPrompt', () => ({ readUiLanguage: () => state.language }));
vi.mock('../../../src/host/model/quickModel', () => ({
  getQuickModelAuthFailure: () => state.authFailure,
  getQuickModelFailure: () => state.modelFailure,
}));
vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ getServerStates: () => state.mcpStates }),
}));

import { checkHooksConfig } from '../../../src/host/diagnostics/checks/hooks';
import { checkMcpServers } from '../../../src/host/diagnostics/checks/mcp';
import { checkQuickModelAuth } from '../../../src/host/diagnostics/checks/quickModelAuth';
import type { DoctorItem } from '../../../src/host/diagnostics/types';

const HAN = /[㐀-䶿一-鿿豈-﫿]/u;
const workDir = mkdtempSync(join(tmpdir(), 'doctor-copy-'));
mkdirSync(join(workDir, '.code-agent', 'hooks'), { recursive: true });

function texts(items: DoctorItem[]): string[] {
  return items.flatMap((item) => [item.name, item.message, item.suggestion ?? '']).filter(Boolean);
}

async function collect(): Promise<Record<string, string[]>> {
  state.authFailure = { provider: 'p', model: 'm', status: 401, at: 1 };
  state.modelFailure = null;
  const authFailed = texts(checkQuickModelAuth());
  state.authFailure = null;
  const noFailure = texts(checkQuickModelAuth());
  state.modelFailure = { provider: 'p', model: 'm', failureReason: 'invalid_response', status: 200, at: 1 };
  const invalidResponse = texts(checkQuickModelAuth());
  state.modelFailure = { failureReason: 'not_configured', at: 1 };
  const callFailed = texts(checkQuickModelAuth());

  state.mcpStates = [];
  const noServers = texts(checkMcpServers());
  state.mcpStates = ['connected', 'lazy', 'connecting', 'disconnected', 'error'].map((status, index) => ({
    config: { name: `server-${index}` }, status, toolCount: index === 0 ? 3 : 0, resourceCount: 0,
  }));
  const mcp = texts(checkMcpServers());

  const hooks = texts((await checkHooksConfig(workDir)).filter((item) => item.name.startsWith('project')));
  return { authFailed, noFailure, invalidResponse, callFailed, noServers, mcp, hooks };
}

beforeEach(() => {
  state.language = 'zh';
});
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('诊断报告文案跟随界面语言（FB-1291）', () => {
  it('中文与改动前逐字相同', async () => {
    const zh = await collect();
    expect(zh.authFailed).toEqual([
      '快模型健康',
      '快模型（p / m）鉴权失败（HTTP 401），API Key 可能已失效或过期',
      '请前往模型设置更新对应 Provider 的 API Key',
    ]);
    expect(zh.noFailure).toEqual(['快模型健康', '最近未检测到快模型失败']);
    expect(zh.invalidResponse).toEqual([
      '快模型健康',
      '快模型（p / m）响应格式异常，HTTP 200，记忆判定或写回可能已降级',
      '请检查模型 Provider 的 endpoint、模型兼容性与服务状态后重试',
    ]);
    expect(zh.callFailed[1]).toBe('快模型调用失败：not_configured，记忆判定或写回可能已降级');
    expect(zh.noServers).toEqual(['MCP servers', '尚未配置任何 MCP server']);
    expect(zh.mcp).toEqual([
      'server-0', '已连接 · 3 tools',
      'server-1', '懒加载（尚未触发首次调用）',
      'server-2', '连接中', '如果长时间停在此状态，检查 server 是否真的在启动',
      'server-3', '未连接', '若希望立即可用，可在 MCP 面板手动连接',
      'server-4', '连接错误', '检查 server 命令、网络、依赖；详细错误见 details',
    ]);
    expect(zh.hooks).toEqual(['project hooks 配置', '未配置（不存在）']);
  });

  it('英文没有中文，且每条都换成了英文', async () => {
    const zh = await collect();
    state.language = 'en';
    const en = await collect();
    for (const [key, lines] of Object.entries(en)) {
      expect(lines.length, key).toBe(zh[key].length);
      for (const line of lines) expect(line, key).not.toMatch(HAN);
    }
    expect(en.noFailure).toEqual(['Fast model health', 'No recent fast model failures']);
    expect(en.invalidResponse[1]).toBe(
      'Fast model (p / m) returned an unexpected response format, HTTP 200. Memory decisions or write-back may be degraded.',
    );
    expect(en.mcp.slice(0, 4)).toEqual(['server-0', 'Connected · 3 tools', 'server-1', 'Loads on first use (not called yet)']);
    expect(en.hooks).toEqual(['project hooks configuration', 'Not configured (no file)']);
  });

  it('hooks 文件存在但解析失败时，结论和建议也按语言出', async () => {
    writeFileSync(join(workDir, '.code-agent', 'hooks', 'hooks.json'), '{ not json', 'utf8');
    const broken = (await checkHooksConfig(workDir)).filter((item) => item.name.startsWith('project'));
    state.language = 'en';
    const brokenEn = (await checkHooksConfig(workDir)).filter((item) => item.name.startsWith('project'));
    expect(texts(broken)).toEqual(['project hooks 配置', 'JSON 解析失败', '检查 JSON 语法（引号、逗号、括号匹配）']);
    expect(texts(brokenEn)).toEqual([
      'project hooks configuration',
      'JSON could not be parsed',
      'Check the JSON syntax (quotes, commas, matching brackets).',
    ]);
    expect(brokenEn[0]?.status).toBe(broken[0]?.status);
  });
});
