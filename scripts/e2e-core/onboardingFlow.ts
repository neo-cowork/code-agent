import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastAssistantText } from './db';
import type { FlowDef, ServerInfo } from './types';
import { driveTurn, openNewSession, sendMessage, sleep } from './ui';

// 首启引导（F18）。隔离 home 上模型已被 neo-realrun 预配好，引导入口 checkApiKeyConfigured 恒真，
// 引导默认不出现；产品自带的 e2e 钩子（CODE_AGENT_E2E=1 + CODE_AGENT_E2E_FORCE_MODEL_ONBOARDING_AFTER）
// 就是给这种「模型已配好但要验首启」的场景用的——不改产品代码。prepare 里停服务、带着钩子环境变量
// 重启（neo-realrun 每次 launch 都重写 config.json，settings 清零，completedAt 自然为空），页面上走的
// 每一步都是真用户路径：欢迎页 → 密钥路线（中转站，URL/Key 用的就是隔离 home 里已有的 dogfood 配置）
// → 验证 → 默认模型 → 继续进入聊天 → 首条消息。
const FORCE_ENV = 'CODE_AGENT_E2E_FORCE_MODEL_ONBOARDING_AFTER';
const FIRST_MESSAGE = '你好，用一句话说说你能帮我做什么';
const WALK_TIMEOUT_MS = 120_000;

function realrunBin(): string {
  return process.env.NEO_REALRUN_BIN?.trim() || path.join(os.homedir(), 'work/fleet-console/mini/bin/neo-realrun.mjs');
}

function realrun(server: ServerInfo, cmd: 'kill9' | 'restart', env?: NodeJS.ProcessEnv): void {
  execFileSync(process.execPath, [realrunBin(), cmd, '--out', server.dir], {
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 隔离 config.json 里 dogfood provider 的连接信息（引导「密钥」路线填的就是这套已在本机的配置）。 */
function relayConfig(server: ServerInfo): { baseUrl: string; apiKey: string; model: string } {
  const config = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'config.json'), 'utf8')) as {
    models?: { defaultProvider?: string; providers?: Record<string, { apiKey?: string; baseUrl?: string; model?: string }> };
  };
  const providerId = config.models?.defaultProvider ?? '';
  const provider = config.models?.providers?.[providerId] ?? {};
  if (!provider.baseUrl || !provider.apiKey || !provider.model) throw new Error(`隔离 config.json 里没有完整的 provider 配置（${providerId}）`);
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model };
}

async function prepare(server: ServerInfo): Promise<void> {
  // 停服务 → 带首启强制钩子重启；重启时 writeConfig 重写 config.json，settings（含 onboarding）清零。
  // kill9 而不是 stop：stop 等 SIGTERM 收尾，超时后进程可能还活着，restart 会拒绝启动
  realrun(server, 'kill9');
  realrun(server, 'restart', { [FORCE_ENV]: String(Date.now()) });
}

async function cleanup(server: ServerInfo): Promise<void> {
  // 摘掉钩子再重启一次：后面的流程/下一轮跑批不能看到首启引导
  delete process.env[FORCE_ENV];
  realrun(server, 'kill9');
  realrun(server, 'restart');
}

export const f18: FlowDef = {
  id: 'F18',
  title: '第一次打开，配好模型开始聊',
  requiresFirstRun: true,
  prepare,
  cleanup,
  steps: [
    {
      text: '首次打开，出现「初始化 Neo」引导。',
      run: async (env) => {
        await env.page.getByTestId('onboarding-welcome').waitFor({ state: 'visible', timeout: 60_000 });
      },
    },
    {
      text: '选订阅或填 API Key。',
      run: async (env) => {
        const page = env.page;
        const relay = relayConfig(env.server);
        env.note('走「密钥」路线：URL/Key 用隔离 home 里已有的 dogfood 中转配置（只在本单隔离数据目录内使用）');
        await page.getByTestId('onboarding-route-api').click();
        // 中转站卡片（provider 卡列表里的 custom 档，卡名「中转站 / 自定义」）
        await page.getByTestId('onboarding-api-source').getByRole('button').filter({ hasText: '中转站' }).first().click();
        await page.locator('input[placeholder*="example.com"]').fill(relay.baseUrl);
        await page.locator('input[type="password"]').first().fill(relay.apiKey);
        await page.getByRole('button', { name: /验证|Verify/ }).click();
        await page.getByTestId('onboarding-model-step').waitFor({ state: 'visible', timeout: WALK_TIMEOUT_MS });
        // 默认模型优先选本机已在用的那只；列表里没有就选第一张卡
        const preferred = page.locator(`[data-onboarding-model="${relay.model}"]`);
        if (await preferred.count()) await preferred.first().click();
        else await page.locator('[data-onboarding-model]').first().click();
      },
    },
    {
      text: '点「继续」进入聊天。',
      run: async (env) => {
        const page = env.page;
        const continueButton = page.getByTestId('onboarding-continue-to-chat');
        await continueButton.waitFor({ state: 'visible', timeout: 30_000 });
        if (await continueButton.isDisabled()) throw new Error('「继续」按钮是灰的（模型没有选中）');
        await continueButton.click();
        // 引导后段：连接来源 → 快捷键页，都可以跳过/下一步，走到完成
        await page.getByTestId('onboarding-connectors-next').or(page.getByTestId('onboarding-connectors-skip')).first().click({ timeout: 30_000 });
        await page.getByTestId('onboarding-voice-hotkey-skip').click({ timeout: 30_000 });
        await page.getByTestId('onboarding-welcome').waitFor({ state: 'hidden', timeout: WALK_TIMEOUT_MS });
        // 进入聊天后发第一条消息
        env.sessionIds.push(await openNewSession(page));
        await sendMessage(page, FIRST_MESSAGE);
        await driveTurn(page, {}, 240_000);
      },
    },
    {
      text: '核对可观测量：config.json 的 settings.onboarding.completedAt 有值；第二次启动不再弹引导。',
      run: async (env) => {
        const page = env.page;
        const raw = fs.readFileSync(path.join(env.server.dataDir, 'config.json'), 'utf8');
        const completedAt = JSON.parse(raw)?.settings?.onboarding?.completedAt;
        if (!completedAt) throw new Error(`config.json 里 settings.onboarding.completedAt 没有值：${raw.slice(0, 200)}`);
        // 第二次打开不再弹引导
        await page.reload();
        await page.getByTestId('sidebar-new-task').waitFor({ timeout: 30_000 });
        await sleep(6_000);
        if (await page.getByTestId('onboarding-welcome').isVisible().catch(() => false)) throw new Error('完成引导并重开后，首启引导又弹出来了');
        const { data } = await env.readDb();
        const reply = lastAssistantText(data, env.sessionIds);
        if (!reply) throw new Error('完成引导后第一条消息没有收到回复');
      },
    },
  ],
};
