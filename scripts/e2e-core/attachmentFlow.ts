import { describeRows, expectDb, family, inSessions } from './db';
import { writeSalesXlsx } from './fixtures';
import type { FlowDef } from './types';
import { approveCard, driveTurn, openFolderSession, sendMessage } from './ui';

const TURN_TIMEOUT_MS = 420_000;
const READ_TOOLS = ['ExcelAutomate', 'Bash', 'Read', 'Glob'];

export const f10: FlowDef = {
  id: 'F10',
  title: '附件分析（xlsx / PDF / 图片）',
  prepare: async (server) => { writeSalesXlsx(server); },
  steps: [
    {
      text: '说「帮我看一下 q1-sales.xlsx，哪个区域哪个月卖得最好」。',
      run: async (env) => {
        env.sessionIds.push(await openFolderSession(env, 'q1 销售分析'));
        await sendMessage(env.page, '帮我看一下 q1-sales.xlsx，哪个区域哪个月卖得最好');
      },
    },
    {
      text: '遇到读文件审批点允许。',
      run: async (env) => {
        let clicks = 0;
        await driveTurn(env.page, {
          onPermissionCard: async (page) => { clicks++; await approveCard(page); },
        }, TURN_TIMEOUT_MS);
        env.note(clicks ? `读文件时点了 ${clicks} 次允许` : '没有弹审批卡');
        env.scratch.clicks = clicks;
      },
    },
    {
      text: '读回复。',
      run: async (env) => {
        const { data } = await env.readDb();
        const ids = family(data, env.sessionIds);
        const reply = inSessions(data.messages, ids).filter((m) => m.role === 'assistant').map((m) => String(m.content ?? '')).join('\n');
        if (/审批请求超时|超时了，重新发起/.test(reply)) throw new Error(`回复是审批超时：${reply.slice(0, 100)}`);
        const read = inSessions(data.toolEvents, ids).some((e) => e.phase === 'complete' && e.status === 'success' && READ_TOOLS.includes(String(e.tool_name)));
        if (!read && !env.scratch.clicks) env.note('模型没有去读表，只回了反问/说明（模型分支）');
        if (!/华东/.test(reply) || !/(3|三)\s*月/.test(reply)) throw new Error(`回复没有给出「华东区 3 月」：${reply.slice(0, 160)}`);
        if (!/150[,，]?000|15\s*万/.test(reply)) throw new Error(`回复里没有 150,000 元：${reply.slice(0, 160)}`);
        if (!/405[,，]?000|40\.5\s*万/.test(reply)) throw new Error(`回复里没有季度小结（华东合计 405,000）：${reply.slice(0, 160)}`);
      },
    },
    {
      text: '核对可观测量：工具事件读了表，审批记录都是 ask-approved（没有超时/拒绝）。',
      run: (env) => expectDb(env, (d) => {
        const ids = family(d, env.sessionIds);
        const events = inSessions(d.toolEvents, ids);
        const ok = events.filter((e) => e.phase === 'complete' && e.status === 'success').map((e) => String(e.tool_name));
        if (!ok.some((t) => READ_TOOLS.includes(t))) return `没有读表的工具成功事件：\n${describeRows(events, ['tool_name', 'phase', 'status'])}`;
        env.note(events.some((e) => e.tool_name === 'delegate_task') ? '模型转后台（delegate_task）读表' : '模型在前台直接读表');
        const decisions = inSessions(d.permissionDecisions, ids);
        const bad = decisions.filter((r) => r.final_outcome === 'deny' || r.reason === 'timeout');
        if (bad.length) return `有被拒绝/超时的审批：\n${describeRows(bad, ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
        if (env.scratch.clicks && !decisions.some((r) => r.history_outcome === 'ask-approved')) return '点过允许，但 permission_decisions 里没有 ask-approved';
        return null;
      }),
    },
  ],
};
