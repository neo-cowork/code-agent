import { describeRows, expectDb, family, inSessions } from './db';
import type { AttemptEnv, FlowDef } from './types';
import { approveCard, clickCardButton, driveTurn, openNewSession, sendMessage } from './ui';

// 同类工具连发两次：同一条任务里两次 curl。第一次问（点「本次任务内允许」铸 run 档授权），
// 第二次应当命中授权记忆直接执行（permission_decisions 里 auto-approve），不再弹卡。
const PROMPT = '用两条单独的 curl 命令分别抓取网页：第一条抓 https://example.com 存成 a.html，第二条抓 https://example.org 存成 b.html，完成后各用一句话说明页面讲了什么';
const TURN_TIMEOUT_MS = 300_000;
const CARD_TIMEOUT_MS = 120_000;

async function waitFirstCard(env: AttemptEnv): Promise<void> {
  const card = env.page.getByTestId('permission-card').first();
  await driveTurn(env.page, { until: async () => card.isVisible() }, CARD_TIMEOUT_MS);
  if (!(await card.isVisible().catch(() => false))) {
    throw new Error('回合收尾了，没有出现审批卡 permission-card（模型没走需要审批的做法，模型分支）');
  }
}

export const f07: FlowDef = {
  id: 'F07',
  title: '审批卡：本次任务内允许',
  steps: [
    { text: '触发审批卡。', run: async (env) => {
      env.sessionIds.push(await openNewSession(env.page));
      await sendMessage(env.page, PROMPT);
      await waitFirstCard(env);
    } },
    {
      text: '点「本次任务内允许」。',
      run: async (env) => {
        await clickCardButton(env.page, '本次任务内允许');
        env.scratch.approvedAt = Date.now();
      },
    },
    {
      text: '任务继续，后续同类操作不再弹卡。',
      run: async (env) => {
        // 后续同类（Bash/curl）再弹卡就是授权记忆没命中；别类工具（比如 Write 存文件）照常点允许，不算同类
        await driveTurn(env.page, {
          onPermissionCard: async (page) => {
            const text = await page.getByTestId('permission-card').first().innerText();
            if (/curl/.test(text)) throw new Error(`点「本次任务内允许」后同类 curl 命令又弹了审批卡：${text.slice(0, 120)}`);
            await approveCard(page);
          },
        }, TURN_TIMEOUT_MS);
      },
    },
    {
      text: '核对可观测量：permission_decisions 首行 ask-approved，后续同工具行 auto-approve（授权记忆命中）。',
      run: async (env) => {
        const { data } = await env.readDb();
        const ids = family(data, env.sessionIds);
        const events = inSessions(data.toolEvents, ids);
        // 两次调用是这条流程的前提：模型只 curl 了一次就没有「后续同类操作」可验，按任务书要求如实失败，不降级成「点过一次」
        const bashCalls = events.filter((e) => e.tool_name === 'Bash' && e.phase === 'begin').length;
        if (bashCalls < 2) {
          env.note(`模型只发了 ${bashCalls} 次 Bash（要求两条单独的 curl），没有第二次同类调用可验授权记忆`);
          throw new Error(`模型没有调用两次同类工具（Bash begin 只有 ${bashCalls} 次），无法验证「本次任务内允许」的授权记忆（模型分支）`);
        }
        await expectDb(env, (d) => {
          const rows = inSessions(d.permissionDecisions, family(d, env.sessionIds))
            .filter((r) => r.tool_name === 'Bash')
            .sort((a, b) => Number(a.recorded_at) - Number(b.recorded_at));
          if (!rows.length) return `没有 Bash 的审批记录：\n${describeRows(inSessions(d.permissionDecisions, ids), ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
          const first = rows[0];
          if (first.history_outcome !== 'ask-approved' || first.final_outcome !== 'allow') {
            return `第一条 Bash 审批不是 allow | ask-approved：\n${describeRows(rows, ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
          }
          const auto = rows.slice(1).filter((r) => r.history_outcome === 'auto-approve' && String(r.reason ?? '').includes('tool_grant:run'));
          if (!auto.length) return `后续 Bash 调用没有命中授权记忆（auto-approve / tool_grant:run）：\n${describeRows(rows, ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
          const reAsked = rows.slice(1).filter((r) => String(r.history_outcome ?? '').startsWith('ask'));
          if (reAsked.length) return `首条之后还有 Bash 再问了用户（授权记忆没拦住二次弹卡）：\n${describeRows(rows, ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
          return null;
        });
      },
    },
  ],
};
