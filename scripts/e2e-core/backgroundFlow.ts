import { describeRows, expectDb, family, inSessions, lastAssistantText } from './db';
import { writeHtmlPages } from './fixtures';
import type { FlowDef } from './types';
import { approveCard, backgroundTaskRow, driveTurn, openFolderSession, sendMessage, waitFor } from './ui';

const TURN_TIMEOUT_MS = 240_000;
const BACKGROUND_TIMEOUT_MS = 600_000;

export const f08: FlowDef = {
  id: 'F08',
  title: '转后台并收到完成通知',
  prepare: async (server) => { writeHtmlPages(server); },
  steps: [
    {
      text: '说「把这三个页面整理成周报，放后台去做，做完告诉我」。',
      run: async (env) => {
        env.sessionIds.push(await openFolderSession(env, '三个页面整理周报'));
        await sendMessage(env.page, '把这三个页面整理成周报，放后台去做，做完告诉我');
      },
    },
    {
      text: '看到「后台任务」面板出现任务。',
      run: async (env) => {
        await driveTurn(env.page, {
          onPermissionCard: async (page) => { env.note(`有审批卡，脚本点了「${await approveCard(page)}」`); },
        }, TURN_TIMEOUT_MS);
        const task = await backgroundTaskRow(env.page);
        if (!task) {
          env.note('模型没有走 delegate_task，面板里没有后台任务（模型分支）');
          throw new Error('回合结束了，「后台任务」面板里没有任务');
        }
        const { data } = await env.readDb();
        const said = inSessions(data.messages, env.sessionIds).filter((m) => m.role === 'assistant').map((m) => String(m.content ?? '')).join('\n');
        if (!/后台/.test(said)) throw new Error(`回复里没有说已交给后台：${said.slice(0, 120)}`);
        env.note(`面板条目：${task.status} ${task.title.slice(0, 30)}`);
      },
    },
    {
      text: '任务完成后回到会话看结果。',
      run: async (env) => {
        await waitFor('后台任务不再是「进行中」', async () => (await backgroundTaskRow(env.page))?.status !== '进行中', BACKGROUND_TIMEOUT_MS);
        await driveTurn(env.page, { mayBeIdle: true, onPermissionCard: async (page) => { await approveCard(page); } }, TURN_TIMEOUT_MS);
        const row = await backgroundTaskRow(env.page);
        if (row?.status !== '完成') throw new Error(`后台任务结束了但状态是「${row?.status ?? '没有条目'}」`);
        const { data } = await env.readDb();
        if (!lastAssistantText(data, env.sessionIds)) throw new Error('后台任务结束后会话里没有交付结果');
      },
    },
    {
      text: '核对可观测量：delegate_task complete success，输出含「后台任务「…」已开始，尚未完成」。',
      run: (env) => expectDb(env, (d) => {
        const ids = family(d, env.sessionIds);
        const events = inSessions(d.toolEvents, ids).filter((e) => e.tool_name === 'delegate_task');
        if (!events.some((e) => e.phase === 'complete' && e.status === 'success')) return `没有 delegate_task complete success：\n${describeRows(inSessions(d.toolEvents, ids), ['tool_name', 'phase', 'status'])}`;
        const said = inSessions(d.messages, ids).some((m) => /后台任务「.+」已开始，尚未完成/.test(String(m.tool_results ?? '')));
        if (!said) return 'delegate_task 的输出里没有「后台任务「…」已开始，尚未完成」';
        const status = String(d.sessions.find((x) => x.id === env.sessionIds[0])?.status ?? '');
        return status === 'completed' ? null : `会话 status 是「${status}」，应为 completed`;
      }),
    },
  ],
};
