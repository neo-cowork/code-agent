import { expectDb } from './db';
import type { FlowDef } from './types';
import { sleep } from './ui';

// 自动化页「新建」→ 简版创建表单：目标里写「每周一早上 9 点」，表单把频率（每周）/星期（周一）/时间（09:00）
// 自动带出来。任务名不填时缺省取目标句（buildSimpleDraft），列表里就叫这句话。
const GOAL = '每周一早上 9 点帮我整理周报';
const CREATE_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 420_000;

export const f15: FlowDef = {
  id: 'F15',
  title: '「每周一早上 9 点帮我整理周报」',
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
        // 无角色任务先出「保存前确认」复述卡，确认后才真正创建（任务摘要确认）；
        // 等复述卡和编辑器都收起，再等列表里这条任务的行出现
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
      run: (env) => expectDb(env, (d) => {
        const mine = d.cronJobs.filter((j) => String(j.name ?? '') === GOAL && Number(j.created_at ?? 0) >= env.startedAtMs - 60_000);
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
      }, RUN_TIMEOUT_MS),
    },
  ],
};
