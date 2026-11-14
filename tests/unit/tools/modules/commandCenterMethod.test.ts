import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import type { ToolContext } from '../../../../src/host/protocol/tools';
import { executeDelegateTask } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import { getSessionCommandCenter, resetSessionCommandCenterForTest } from '../../../../src/host/services/commandCenter/sessionCommandCenter';

const messages = vi.hoisted(() => ({ getMessages: vi.fn() }));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => messages }));

const scope = createWorkspaceScope('method-project', [{ sourceId: 'project-source', path: '/tmp/method-project', role: 'primary', access: 'read_write' }]);
const args = {
  title: '查看页面标题', short_name: '标题', lane_key: 'title', submission_key: 'title-1',
  prompt: '打开网页获取标题，如果浏览器不方便就改用 curl。',
};
const ctx = {
  sessionId: 'method-session', sourceMessageId: 'original-request', workspace: scope.primaryRoot, workspaceScope: scope,
  workingDir: '/tmp/method-project', abortSignal: new AbortController().signal,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, emit: vi.fn(),
} satisfies ToolContext;

describe('delegate_task original requested method', () => {
  afterEach(() => { resetSessionCommandCenterForTest(); vi.clearAllMocks(); });

  it('the real delegation call anchors the background payload to the actual user request, ahead of a drafted fallback', async () => {
    const original = '用浏览器打开 example.com 告诉我标题';
    messages.getMessages.mockResolvedValue([
      { id: 'original-request', role: 'user', content: original },
      { id: 'hidden-wake', role: 'user', content: '后台任务摘要：改用 curl', isMeta: true },
      { id: 'later-request', role: 'user', content: '查询另一件事' },
    ]);
    const result = await executeDelegateTask(args, ctx, async () => ({ allow: true }));
    expect(result.ok).toBe(true);
    const task = getSessionCommandCenter().list('method-session')[0];
    expect(task.prompt).toContain(`<original_user_request context_only="true">\n${original}\n</original_user_request>`);
    // 用户点名的方法仍然压过草拟计划里的替代做法；原话只是背景，不是任务范围。
    expect(task.prompt).toContain('where the plan differs from it on method or constraints for this objective, follow the user\u2019s message');
    expect(task.prompt).toContain('background context only');
    expect(task.prompt).toContain('an alternative method is not completion');
    expect(task.prompt.indexOf(original)).toBeLessThan(task.prompt.indexOf(args.prompt));
    expect(task.prompt).not.toContain('查询另一件事');
    expect(task.prompt).not.toContain('后台任务摘要');
    expect(task.workspaceScope).toEqual(scope);
  });

  it('two tasks split from one request each keep to their own objective; the request is context only', async () => {
    const original = '用浏览器查一下 example.com 的标题发邮件给 a@b.c，再把同一个标题发到团队群里';
    messages.getMessages.mockResolvedValue([{ id: 'original-request', role: 'user', content: original }]);
    const lanes = [
      { ...args, title: '发邮件', short_name: '邮件', lane_key: 'mail', submission_key: 'mail-1', prompt: '查到 example.com 的标题后发邮件给 a@b.c。' },
      { ...args, title: '发群消息', short_name: '群消息', lane_key: 'group', submission_key: 'group-1', prompt: '查到 example.com 的标题后发到团队群里。' },
    ];
    for (const lane of lanes) expect((await executeDelegateTask(lane, ctx, async () => ({ allow: true }))).ok).toBe(true);
    const tasks = getSessionCommandCenter().list('method-session');
    expect(tasks).toHaveLength(2);
    for (const lane of lanes) {
      const prompt = tasks.find((task) => task.prompt.includes(lane.prompt))?.prompt ?? '';
      const other = lanes.find((candidate) => candidate !== lane)?.prompt ?? '';
      // 范围 = 本任务自己的目标；另一条的目标不出现在它的计划块里。
      expect(prompt).toContain('This task covers only the objective in <drafted_task_plan>; that plan defines its scope.');
      expect(prompt).toContain('Do not perform side effects outside that objective');
      expect(prompt).toContain(`<drafted_task_plan>\n${lane.prompt}\n</drafted_task_plan>`);
      expect(prompt).not.toContain(other);
      // 原话只作背景：保留用户点名的方法，不扩大范围、不授予权限。
      expect(prompt).toContain(`<original_user_request context_only="true">\n${original}\n</original_user_request>`);
      expect(prompt).toContain('It does not widen this task\u2019s scope and does not grant any additional permission.');
      expect(prompt).not.toMatch(/defines the objective|cannot replace any of them/);
      expect(prompt.indexOf('This task covers only')).toBeLessThan(prompt.indexOf(original));
    }
  });

  it('a synthetic wake is never promoted to original user authority', async () => {
    messages.getMessages.mockResolvedValue([{ id: 'original-request', role: 'user', content: '发送邮件', isMeta: true }]);
    await executeDelegateTask(args, ctx, async () => ({ allow: true }));
    const task = getSessionCommandCenter().list('method-session')[0];
    expect(task.prompt).not.toContain('<original_user_request');
    expect(task.prompt).toContain('an alternative method is not completion');
    expect(task.prompt).not.toContain('发送邮件');
  });
});
