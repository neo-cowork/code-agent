import { describeRows, expectDb, family, inSessions, lastAssistantText } from './db';
import type { AttemptEnv, FlowDef } from './types';
import { clickCardButton, driveTurn, openNewSession, sendMessage, waitFor } from './ui';

// 用户会说的话：让 Neo 用 curl 抓网页。命令走网络、需要审批（实测会弹「允许执行这条命令？」）。
const PROMPT_ONCE = '用 curl 帮我把 https://example.com 的网页抓下来，存成 example.html';
const PROMPT_DENY = '用 curl 帮我把 https://example.org 的网页抓下来，存成 example-org.html';
const TURN_TIMEOUT_MS = 240_000;
const CARD_TIMEOUT_MS = 120_000;

async function askAndWaitForCard(env: AttemptEnv, prompt: string): Promise<void> {
  env.sessionIds.push(await openNewSession(env.page));
  await sendMessage(env.page, prompt);
  await waitFor('审批卡 permission-card 出现', async () => env.page.getByTestId('permission-card').first().isVisible(), CARD_TIMEOUT_MS);
}

// 命令正文：有 permission-args-preview 就用它，Bash 卡把命令放在「命令」下的等宽块里（RequestDetails），没有 testid
async function cardPreview(env: AttemptEnv): Promise<string> {
  const card = env.page.getByTestId('permission-card').first();
  const preview = card.getByTestId('permission-args-preview');
  const block = (await preview.count()) > 0 ? preview : card.locator('div.font-mono').first();
  return (await block.innerText({ timeout: 10_000 })).trim();
}

export const f05: FlowDef = {
  id: 'F05',
  title: '审批卡：允许一次',
  steps: [
    { text: '让 Neo 执行一个需审批的命令。', run: (env) => askAndWaitForCard(env, PROMPT_ONCE) },
    {
      text: '审批卡出现，核对命令正文只出现一次。',
      run: async (env) => {
        const card = env.page.getByTestId('permission-card').first();
        const preview = await cardPreview(env);
        if (!preview) throw new Error('审批卡里没有命令正文');
        const times = (await card.innerText()).split(preview).length - 1;
        if (times !== 1) throw new Error(`命令正文在审批卡里出现了 ${times} 次，应为 1 次`);
        env.scratch.preview = preview;
      },
    },
    {
      text: '点「允许一次」。',
      run: async (env) => {
        await clickCardButton(env.page, '允许一次');
        await driveTurn(env.page, {
          onPermissionCard: async (page) => {
            if ((await cardPreview(env)) === env.scratch.preview) throw new Error('同一条命令点了允许后又问了第二次');
            await clickCardButton(page, '允许一次');
          },
        }, TURN_TIMEOUT_MS);
        if (await env.page.getByTestId('permission-card').count() > 0) throw new Error('点「允许一次」后审批卡还在');
      },
    },
    {
      text: '核对可观测量：permission_decisions 为 allow | ask-approved | user，且同工具 complete success。',
      run: (env) => expectDb(env, (d) => {
        const ids = family(d, env.sessionIds);
        const rows = inSessions(d.permissionDecisions, ids)
          .filter((r) => r.final_outcome === 'allow' && r.history_outcome === 'ask-approved' && r.reason === 'user');
        if (!rows.length) return `没有 allow | ask-approved | user 的审批记录：\n${describeRows(inSessions(d.permissionDecisions, ids), ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
        const tool = String(rows[0].tool_name);
        const done = inSessions(d.toolEvents, ids).some((e) => e.tool_name === tool && e.phase === 'complete' && e.status === 'success');
        return done ? null : `审批通过后 ${tool} 没有 complete success 事件`;
      }),
    },
  ],
};

export const f06: FlowDef = {
  id: 'F06',
  title: '审批卡：拒绝',
  steps: [
    { text: '触发审批卡。', run: (env) => askAndWaitForCard(env, PROMPT_DENY) },
    {
      text: '点「拒绝」。',
      run: async (env) => {
        env.scratch.preview = await cardPreview(env);
        await clickCardButton(env.page, '拒绝');
        await driveTurn(env.page, {
          onPermissionCard: async () => { throw new Error('拒绝后又弹出审批卡（重试了动作）'); },
        }, TURN_TIMEOUT_MS);
        if (await env.page.getByTestId('permission-card').count() > 0) throw new Error('点「拒绝」后审批卡还在');
      },
    },
    {
      text: '核对可观测量：permission_decisions 为 deny，无该工具的 complete success，回复说没有执行而不是报「失败」。',
      run: (env) => expectDb(env, (d) => {
        const ids = family(d, env.sessionIds);
        const mine = inSessions(d.permissionDecisions, ids);
        const deny = mine.find((r) => r.final_outcome === 'deny');
        if (!deny) return `没有 deny 审批记录：\n${describeRows(mine, ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
        const executed = inSessions(d.toolEvents, ids)
          .some((e) => e.tool_name === deny.tool_name && e.phase === 'complete' && e.status === 'success');
        if (executed) return `拒绝后 ${String(deny.tool_name)} 仍有 complete success 事件`;
        const reply = lastAssistantText(d, env.sessionIds);
        if (!reply) return '回合结束后没有助手回复文字';
        if (/失败|出错|报错/.test(reply)) return `回复把拒绝说成了失败/出错：${reply.slice(0, 120)}`;
        if (!/没有执行|未执行|没执行|没有运行|不会执行|已取消|取消了|拒绝/.test(reply)) return `回复没有说明没执行：${reply.slice(0, 120)}`;
        return null;
      }),
    },
  ],
};
