import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeRows, expectDb, family, inSessions } from './db';
import type { Page } from 'playwright';
import type { AttemptEnv, FlowDef } from './types';
import { approveCard, clickCardButton, driveTurn, openFolderSession, openNewSession, pageText, sendMessage, sleep } from './ui';

const REMEMBER = '记住：周报用本周进展 / 风险 / 下周计划三段式，数字用万';
const TURN_TIMEOUT_MS = 300_000;
const CONFIRM_TIMEOUT_MS = 180_000;

function memoryFiles(env: AttemptEnv): Array<{ file: string; text: string }> {
  const dir = path.join(env.server.dataDir, 'memory');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => path.join(dir, rel))
    .filter((f) => f.endsWith('.md') && fs.statSync(f).isFile() && fs.statSync(f).mtimeMs >= env.startedAtMs - 1000)
    .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

// 模型有时把记忆写到真实主目录（/Users/<me>/.code-agent），那会污染这台机器的真数据：只批准隔离目录里的写入
async function answerCard(env: AttemptEnv, page: Page): Promise<void> {
  const text = await page.getByTestId('permission-card').first().innerText();
  const realData = path.join(os.homedir(), '.code-agent');
  if (text.includes(realData)) {
    await clickCardButton(page, '拒绝');
    env.note(`模型把记忆写到了真实主目录 ${realData}，脚本拒绝了（模型分支）`);
    return;
  }
  await approveCard(page);
  env.scratch.cardClicks = Number(env.scratch.cardClicks ?? 0) + 1;
}

/** 弹窗和审批卡的先后顺序不固定：谁出现点谁，直到条件满足。 */
async function pump(env: AttemptEnv, done: () => boolean, what: string): Promise<void> {
  const save = env.page.getByRole('button', { name: '确认保存规则' });
  const card = env.page.getByTestId('permission-card').first();
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`等待超时（${CONFIRM_TIMEOUT_MS / 1000}s）：${what}`);
    if (await save.isVisible().catch(() => false)) {
      // 弹窗可能在点的瞬间被换成下一张/自动收起，点失败不算数
      if (await save.click({ timeout: 5_000 }).then(() => true, () => false)) env.scratch.modalClicks = Number(env.scratch.modalClicks ?? 0) + 1;
    } else if (await card.isVisible().catch(() => false)) await answerCard(env, env.page);
    else await sleep(500);
  }
}

export const f14: FlowDef = {
  id: 'F14',
  title: '记忆写入并在新会话召回',
  // 每次尝试从空记忆开始：上一次存过，模型会回「之前已经记过了」，不再弹确认
  prepare: async (server) => { fs.rmSync(path.join(server.dataDir, 'memory'), { recursive: true, force: true }); },
  steps: [
    {
      text: '说「记住：周报用本周进展 / 风险 / 下周计划三段式，数字用万」。',
      run: async (env) => {
        env.sessionIds.push(await openFolderSession(env, '周报格式'));
        await sendMessage(env.page, REMEMBER);
      },
    },
    {
      text: '先出现第一个弹窗「确认用户规则」（不是审批卡），点「确认保存规则」。',
      run: (env) => pump(env, () => Number(env.scratch.modalClicks) > 0, '「确认用户规则」弹窗出现并点了「确认保存规则」'),
    },
    {
      text: '紧接着出现第二个确认：普通审批卡（`permission-card`，同 F05），因为记忆文件写在项目目录外；点「允许一次」。',
      run: async (env) => {
        await driveTurn(env.page, {
          mayBeIdle: true,
          onMemoryModal: async (page) => { await page.getByRole('button', { name: '确认保存规则' }).click({ timeout: 5_000 }).catch(() => {}); },
          onPermissionCard: (page) => answerCard(env, page),
        }, TURN_TIMEOUT_MS);
        // 模型写 `~/.code-agent/...` 时，权限分类把它当成项目目录内的相对路径，不会出现第二个确认——如实记下，不当作脚本失败
        if (!Number(env.scratch.cardClicks)) env.note('没有出现第二个确认：Write 的目标是 ~/ 路径，被判成「写入项目目录内」自动放行（模型分支 / 权限分类对 ~ 的处理）');
        const text = await pageText(env.page);
        if (!/已记住|记住了|记好了|已记下|记下了|已保存|存好了|已写入/.test(text)) throw new Error('第一轮回复里没有明确说「已记住」');
      },
    },
    {
      text: '新开一个会话说「帮我起草这周周报」。',
      run: async (env) => {
        env.sessionIds.push(await openNewSession(env.page));
        await sendMessage(env.page, '帮我起草这周周报');
        await driveTurn(env.page, { onPermissionCard: async (page) => { env.note('第二个会话读记忆文件时点了允许'); await approveCard(page); } }, TURN_TIMEOUT_MS);
        const { data } = await env.readDb();
        const reply = inSessions(data.messages, [env.sessionIds[1]]).filter((m) => m.role === 'assistant').map((m) => String(m.content ?? '')).join('\n');
        if (!/进展/.test(reply) || !/风险/.test(reply) || !/计划/.test(reply)) throw new Error(`第二个会话的草稿不是三段式：${reply.slice(0, 160)}`);
      },
    },
    {
      text: '核对可观测量：记忆文件落盘、Write success、W3: outside_project 的 ask-approved 审批、第二个会话 Read 了该文件。',
      run: async (env) => {
        const files = memoryFiles(env).filter((f) => /进展/.test(f.text));
        if (!files.length) throw new Error(`记忆目录里没有含「进展」的新 .md 文件（${path.join(env.server.dataDir, 'memory')}）`);
        env.note(`记忆文件 ${files.map((f) => path.basename(f.file)).join(', ')}`);
        await expectDb(env, (d) => {
          const first = family(d, [env.sessionIds[0]]);
          const wrote = inSessions(d.toolEvents, first).some((e) => e.tool_name === 'Write' && e.phase === 'complete' && e.status === 'success');
          if (!wrote) return `第一个会话没有 Write complete success：\n${describeRows(inSessions(d.toolEvents, first), ['tool_name', 'phase', 'status'])}`;
          const writes = inSessions(d.permissionDecisions, first).filter((r) => r.tool_name === 'Write' && r.final_outcome === 'allow');
          if (!writes.length) return `没有 Write | allow 的审批行：\n${describeRows(inSessions(d.permissionDecisions, first), ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
          if (Number(env.scratch.cardClicks)) {
            const asked = writes.find((r) => r.history_outcome === 'ask-approved');
            if (!asked) return `点过第二个确认，但没有 Write | allow | ask-approved 的审批行：\n${describeRows(writes, ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
            if (!String(asked.trace_json ?? '').includes('outside_project')) return 'Write 审批行的 trace_json 里没有 W3: outside_project';
          }
          const second = family(d, [env.sessionIds[1]]);
          const read = inSessions(d.toolEvents, second).some((e) => e.tool_name === 'Read' && String(e.params_json ?? '').includes('memory'));
          return read ? null : '第二个会话的工具事件里没有对记忆文件的 Read';
        });
      },
    },
  ],
};
