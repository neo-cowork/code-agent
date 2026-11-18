import fs from 'node:fs';
import { describeRows, expectDb, family, inSessions, lastAssistantText } from './db';
import type { FlowDef } from './types';
import { approveCard, driveTurn, openFolderSession, sendMessage, sleep, waitFor } from './ui';

// 跑长任务途中点停止：四页逐页抓取 + 汇总，dogfood 模型至少要几十秒才做得完，够点到停止键。
const PROMPT = '用 curl 依次抓取 https://example.com、https://example.org、https://www.iana.org/help/example-domains、https://httpbin.org/html 四个页面，每页先总结一段再抓下一页，最后汇总成 digest.md 存下来';
const SECOND_MESSAGE = '刚才抓到的第一个页面标题是什么？一句话回答';
const TURN_TIMEOUT_MS = 300_000;
const STOP_SETTLE_TIMEOUT_MS = 120_000;

/** /api/events 抓的原始 SSE 里属于某个会话的事件（data 行 JSON）。 */
function sessionEvents(sseFile: string, sessionId: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(sseFile)) return [];
  const events: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(sseFile, 'utf8').split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as unknown;
      const frames = Array.isArray(parsed) ? parsed : [parsed];
      for (const frame of frames) {
        const f = frame as Record<string, unknown>;
        const payload = (f.args ?? f) as Record<string, unknown>;
        if (String(payload.sessionId ?? '') === sessionId || String(f.sessionId ?? '') === sessionId) events.push(payload as Record<string, unknown>);
      }
    } catch { /* 半行 / 心跳注释，跳过 */ }
  }
  return events;
}

export const f09: FlowDef = {
  id: 'F09',
  title: '跑到一半点停止',
  steps: [
    {
      text: '发送长任务。',
      run: async (env) => {
        env.sessionIds.push(await openFolderSession(env, '抓四个页面做汇总'));
        await sendMessage(env.page, PROMPT);
        // 看到停止键 = 回合已在跑；等页面真有产出（正文或工具卡）再点，别在模型刚起步时打断
        const stop = env.page.getByTestId('composer-stop-button');
        await stop.waitFor({ state: 'visible', timeout: 45_000 });
        await waitFor('回合有可见产出', async () => {
          const text = await env.page.locator('body').innerText().catch(() => '');
          return /https?:\/\/|curl|正在|页面/.test(text.slice(-4000));
        }, 60_000);
      },
    },
    {
      text: '输入框右侧发送键变成停止键，点它。',
      run: async (env) => {
        // 长任务里抓页面要审批：先把当口的卡允许掉，让回合继续跑，再找空档点停止
        const page = env.page;
        for (;;) {
          const card = page.getByTestId('permission-card').first();
          if (await card.isVisible().catch(() => false)) { await approveCard(page); continue; }
          const stop = page.getByTestId('composer-stop-button');
          if (await stop.isVisible().catch(() => false)) { await stop.click(); break; }
          await sleep(200);
        }
        // 点完应进入「停止中」（composer-stop-stopping），再到回合收尾；两者都见不到就是停止键没生效
        const stopping = page.getByTestId('composer-stop-stopping');
        const deadline = Date.now() + STOP_SETTLE_TIMEOUT_MS;
        let sawStopping = false;
        while (Date.now() < deadline) {
          if (await stopping.isVisible().catch(() => false)) sawStopping = true;
          const stillStopping = await stopping.isVisible().catch(() => false);
          const stillRunning = await page.getByTestId('composer-stop-button').isVisible().catch(() => false);
          if (!stillStopping && !stillRunning) break;
          await sleep(150);
        }
        if (!sawStopping) {
          env.note('点停止后没有看到「停止中」（composer-stop-stopping）就收尾了');
          throw new Error('点停止后没有出现 composer-stop-stopping（停止中状态），回合就结束了');
        }
        if (await page.getByTestId('composer-stop-stopping').isVisible().catch(() => false)
          || await page.getByTestId('composer-stop-button').isVisible().catch(() => false)) {
          throw new Error(`点停止 ${STOP_SETTLE_TIMEOUT_MS / 1000}s 后回合仍在「停止中」或仍在运行（停止键没生效）`);
        }
        env.scratch.stoppedAt = Date.now();
      },
    },
    {
      text: '核对可观测量：停止以回合终止事件（非 error）收尾，输入框恢复可发送，已有输出保留，再发一条能正常回复。',
      run: async (env) => {
        // 停止收尾在事件流里的形态：agent 通道出现 turn_end，或会话状态被置为 interrupted（两种都算非 error 的终止）
        let sawTurnEnd = false;
        await waitFor('停止后的回合终止事件（turn_end / interrupted）出现在事件流里', async () => {
          sawTurnEnd = sessionEvents(env.sseFile, env.sessionIds[0]).some((e) => e.type === 'turn_end');
          if (sawTurnEnd) return true;
          // session:updated 不是 agent 事件，按本会话 id + interrupted 状态在原始文件里找
          const sid = env.sessionIds[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`"sessionId":"${sid}"[^}]*,"updates":\\{"status":"interrupted"`).test(fs.readFileSync(env.sseFile, 'utf8'));
        }, 30_000);
        if (!sawTurnEnd) env.note('停止的回合以 session:updated status=interrupted 收尾（没有 turn_end 事件）');
        const events = sessionEvents(env.sseFile, env.sessionIds[0]);
        const errors = events.filter((e) => e.type === 'error');
        if (errors.length) throw new Error(`停止收尾时事件流里有 error 事件（应为非 error 的回合终止）：${JSON.stringify(errors[0]).slice(0, 200)}`);
        // 已有输出保留：停止前页面已有产出，回合收尾后这些文字还在
        const body = await env.page.locator('body').innerText();
        if (!/https?:\/\/example|https?:\/\/www\.iana|https?:\/\/httpbin|curl/.test(body)) throw new Error('停止后页面上的已有输出不见了');
        // 输入框恢复可发送 + 第二条消息正常回复
        const box = env.page.getByTestId('chat-composer-textarea');
        await box.waitFor({ state: 'visible', timeout: 20_000 });
        await sendMessage(env.page, SECOND_MESSAGE);
        await driveTurn(env.page, {
          onPermissionCard: async (page) => { env.note('停止后的第二条消息又弹了审批卡，脚本点了允许'); await approveCard(page); },
        }, TURN_TIMEOUT_MS);
        await expectDb(env, (d) => {
          const reply = lastAssistantText(d, env.sessionIds);
          if (!reply) return `第二条消息没有收到回复：\n${describeRows(inSessions(d.messages, family(d, env.sessionIds)).slice(-6), ['role'])}`;
          return null;
        });
      },
    },
  ],
};
