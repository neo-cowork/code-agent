import { expectDb } from './db';
import type { AttemptEnv, FlowDef, ServerInfo } from './types';
import { sleep } from './ui';

// 自动化页「新建」→ 简版创建表单：目标里写「每周一早上 9 点」，表单把频率（每周）/星期（周一）/时间（09:00）
// 自动带出来。任务名不填时缺省取目标句（buildSimpleDraft），列表里就叫这句话。
// 手动触发后的执行是真实 agent run：模型有时要往工作目录外写文件，权限请求会停车等审
// （执行一直 running）。真用户的处理位是自动化页的「待过目」收件箱；脚本用同一入口背后的
// /api/agent/permission-response 代点允许（与 neo-realrun --auto-approve 同一机制），让执行走到终态。
// cleanup 会删掉本单建的同名任务：列表里同名行只剩本次尝试的这一条，「点这条任务」才不会点串。
const GOAL = '每周一早上 9 点帮我整理周报';
const CREATE_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 600_000;

async function cronDomain<T>(server: ServerInfo, action: string, payload: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/domain/cron/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null) as { success?: boolean; data?: T; error?: { message?: string } } | null;
  if (!res.ok || !body?.success) throw new Error(`cron:${action} 失败：HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  return body.data as T;
}

/** 收尾：删掉本单建的同名任务（用户在详情里点「删除」走的同一通道）。 */
async function cleanup(server: ServerInfo): Promise<void> {
  try {
    const jobs = await cronDomain<Array<{ id: string; name?: string }>>(server, 'listJobs', {});
    for (const job of jobs.filter((j) => j.name === GOAL)) {
      await cronDomain(server, 'deleteJob', { jobId: job.id }).catch(() => undefined);
    }
  } catch { /* 收尾尽力而为：列表里多一条同名任务不挡下一次尝试的断言（db 按创建时间过滤） */ }
}

/** 无人值守执行里停车等审的权限请求：代用户点「允许」（只对本次执行关联的会话）。
 *  pending_approvals 表不带 session 列，会话与请求 id 都在 payload_json 里。 */
async function approveParkedPermissions(env: AttemptEnv): Promise<void> {
  const { data } = await env.readDb();
  const cronSessionIds = new Set(
    data.cronExecutions
      .filter((e) => e.status === 'running' || Number(e.started_at ?? 0) >= env.startedAtMs - 300_000)
      .map((e) => String(e.session_id ?? '')),
  );
  const pending = data.pendingApprovals.filter((a) => String(a.status ?? 'pending') === 'pending');
  for (const row of pending) {
    let payload: { sessionId?: string; tool?: string } = {};
    try { payload = JSON.parse(String(row.payload_json ?? '{}')) as typeof payload; } catch { continue; }
    // 请求 id 就是停车行自己的 id（perm-…，permission-response 端点收的就是它）
    const requestId = String(row.id ?? '');
    const sessionId = String(payload.sessionId ?? '');
    if (!requestId || !cronSessionIds.has(sessionId)) continue;
    await fetch(`http://127.0.0.1:${env.server.port}/api/agent/permission-response`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([requestId, 'allow', sessionId]),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    env.note(`定时执行停车等审，代点允许（请求 ${requestId.slice(0, 8)}… 会话 ${sessionId.slice(-8)}）`);
  }
}

export const f15: FlowDef = {
  id: 'F15',
  title: '「每周一早上 9 点帮我整理周报」',
  cleanup,
  steps: [
    {
      text: '说「每周一早上 9 点帮我整理周报」或在自动化页新建。',
      run: async (env) => {
        const page = env.page;
        await page.getByTestId('sidebar-capability-automation').click();
        await page.getByTestId('cron-center-panel').waitFor({ state: 'visible', timeout: 30_000 });
        await page.getByRole('button', { name: '新建', exact: true }).click();
        const form = page.getByTestId('cron-simple-create');
        await form.waitFor({ state: 'visible', timeout: CREATE_TIMEOUT_MS });
        // 只填目标：频率/星期/时间是表单按目标里的「每周一早上 9 点」自动带出的，用户不动它们
        await form.getByPlaceholder('例如：读一遍我关注的竞品动态，整理成简报').fill(GOAL);
        env.note('频率（每周）/星期（周一）/时间（09:00）用表单按目标句自动带出的值，未手动改');
      },
    },
    {
      text: '确认任务摘要。',
      run: async (env) => {
        const page = env.page;
        await page.getByRole('button', { name: '创建自动化' }).click();
        // 无角色任务先出「保存前确认」复述卡，确认后才真正创建（任务摘要确认）
        const confirm = page.getByTestId('cron-pending-routine-confirm');
        await confirm.waitFor({ state: 'visible', timeout: CREATE_TIMEOUT_MS });
        await confirm.click();
        await page.getByTestId('cron-simple-create').waitFor({ state: 'hidden', timeout: CREATE_TIMEOUT_MS });
        // 任务行 = 列表滚动区里含任务名的按钮（复述卡也含任务名，所以先等它收起）
        const row = page.getByTestId('cron-center-scroll').getByRole('button').filter({ hasText: GOAL }).first();
        await row.waitFor({ state: 'visible', timeout: CREATE_TIMEOUT_MS });
        // 列表要给人话的执行时间（不是裸 cron 表达式），下次执行时间非空，且确实是「周一」
        const nextRun = row.getByTestId('cron-job-next-run');
        await nextRun.waitFor({ state: 'visible', timeout: CREATE_TIMEOUT_MS });
        const text = (await nextRun.innerText()).trim();
        if (!text) throw new Error('这条任务的「下次运行」是空的');
        if (/\*/.test(text)) throw new Error(`下次运行暴露了原始 cron 表达式：${text}`);
        const date = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(text);
        if (!date) throw new Error(`下次运行不是人话的日期表述：${text}`);
        const weekday = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getDay();
        if (weekday !== 1) throw new Error(`下次运行日期 ${date[0]} 不是周一（周${'日一二三四五六'[weekday]}）：${text}`);
        env.note(`下次运行：${text}`);
        // 选中这条任务，右侧出详情（手动触发的入口在详情里）
        await row.click();
        await page.getByTestId('cron-job-detail').waitFor({ state: 'visible', timeout: CREATE_TIMEOUT_MS });
      },
    },
    {
      text: '手动「运行一次」。',
      run: async (env) => {
        await env.page.getByRole('button', { name: '手动触发' }).click();
        await sleep(1_000);
      },
    },
    {
      text: '核对可观测量：cron_jobs 新增 enabled=1 的行；运行后 cron_executions 有该 job_id 的行，status 终态且 session_id 非空。',
      run: async (env) => {
        // 执行是真实 agent run：边等终态边把停车等审的权限请求代点允许（见文件头说明）
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        for (;;) {
          await approveParkedPermissions(env);
          const { data } = await env.readDb();
          const mine = data.cronJobs.filter((j) => String(j.name ?? '') === GOAL)
            .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0));
          const execs = mine.length ? data.cronExecutions.filter((e) => String(e.job_id) === String(mine[0].id)) : [];
          const terminal = execs.find((e) => ['completed', 'failed', 'interrupted'].includes(String(e.status)));
          if (mine.length && terminal) break;
          if (Date.now() > deadline) break;
          await sleep(5_000);
        }
        await expectDb(env, (d) => {
          // 同名任务取最新一条（cleanup 已删上一轮的，这里再按创建时间兜底）
          const mine = d.cronJobs.filter((j) => String(j.name ?? '') === GOAL)
            .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0));
          if (!mine.length) return `没有以目标句命名的 cron_jobs 新行：\n${d.cronJobs.map((j) => `${j.id}|${j.name}|enabled=${j.enabled}`).join('\n') || '（没有行）'}`;
          const job = mine[0];
          env.scratch.jobId = String(job.id);
          if (Number(job.enabled) !== 1) return `新任务 enabled=${String(job.enabled)}，应为 1`;
          const execs = d.cronExecutions.filter((e) => String(e.job_id) === String(job.id));
          if (!execs.length) return `任务 ${String(job.id)} 没有执行记录（cron_executions 没有行）`;
          const terminal = execs.find((e) => ['completed', 'failed', 'interrupted'].includes(String(e.status)));
          if (!terminal) return `执行记录还不是终态：\n${execs.map((e) => `${e.id}|${e.status}|session=${String(e.session_id)}`).join('\n')}`;
          if (!terminal.session_id) return `终态执行 ${String(terminal.id)} 的 session_id 是空的`;
          env.note(`执行 ${String(terminal.id)} status=${String(terminal.status)} session=${String(terminal.session_id)}`);
          return null;
        });
      },
    },
  ],
};
