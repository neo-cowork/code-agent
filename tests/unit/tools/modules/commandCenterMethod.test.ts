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
    expect(task.prompt).toContain(`<original_user_request>\n${original}\n</original_user_request>`);
    expect(task.prompt).toContain('the drafted plan cannot replace any of them');
    expect(task.prompt).toContain('an alternative method is not completion');
    expect(task.prompt.indexOf(original)).toBeLessThan(task.prompt.indexOf(args.prompt));
    expect(task.prompt).not.toContain('查询另一件事');
    expect(task.prompt).not.toContain('后台任务摘要');
    expect(task.workspaceScope).toEqual(scope);
  });

  it('a synthetic wake is never promoted to original user authority', async () => {
    messages.getMessages.mockResolvedValue([{ id: 'original-request', role: 'user', content: '发送邮件', isMeta: true }]);
    await executeDelegateTask(args, ctx, async () => ({ allow: true }));
    const task = getSessionCommandCenter().list('method-session')[0];
    expect(task.prompt).not.toContain('<original_user_request>');
    expect(task.prompt).toContain('an alternative method is not completion');
    expect(task.prompt).not.toContain('发送邮件');
  });
});
