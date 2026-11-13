import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, ToolContext } from '../../../../src/host/protocol/tools';

const mocks = vi.hoisted(() => ({ createJob: vi.fn(), unattended: vi.fn() }));
vi.mock('../../../../src/host/cron/cronService', () => ({ getCronService: () => ({ createJob: mocks.createJob }) }));
vi.mock('../../../../src/host/permissions/modes', () => ({ getPermissionModeManager: () => ({ isUnattendedSession: mocks.unattended }) }));
import { createScheduledTaskModule } from '../../../../src/host/tools/modules/scheduling/createScheduledTask';
import { getTextForegroundToolNames } from '../../../../src/host/tools/protocolRegistry';
import { buildDeferredToolIndex } from '../../../../src/host/services/toolSearch/deferredTools';

const args = { name: 'Weekly report', prompt: 'Summarize this week’s notes', cron: '0 17 * * 5', timezone: 'Asia/Shanghai' };
const ctx = { sessionId: 'test-session', abortSignal: new AbortController().signal } as ToolContext;
const execute = (input: Record<string, unknown>, approve: CanUseToolFn, context = ctx) => createScheduledTaskModule.createHandler().execute(input, context, approve);

describe('create_scheduled_task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unattended.mockReturnValue(false);
    mocks.createJob.mockResolvedValue({ id: 'job-1' });
  });

  it('is discoverable without a connector or slash command', () => {
    expect(getTextForegroundToolNames()).toContain('create_scheduled_task');
    expect(buildDeferredToolIndex().get(createScheduledTaskModule.schema.name)?.aliases).toContain('定时任务');
  });

  it('waits for mandatory confirmation before creating the exact schedule', async () => {
    let resolve!: (value: { allow: boolean }) => void;
    const approval = vi.fn(() => new Promise<{ allow: boolean }>((done) => { resolve = done; }));
    const pending = execute(args, approval);
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(approval).toHaveBeenCalledWith('create_scheduled_task', args, expect.stringContaining(args.prompt), expect.objectContaining({ forceConfirm: true }));
    resolve({ allow: true });
    expect(await pending).toMatchObject({ ok: true, meta: { jobId: 'job-1' } });
    expect(mocks.createJob).toHaveBeenCalledWith({ name: args.name, enabled: true, runsOn: 'local', scheduleType: 'cron', schedule: { type: 'cron', expression: args.cron, timezone: args.timezone }, action: { type: 'agent', agentType: 'default', prompt: args.prompt } });
  });

  it('creates a one-off run only after confirmation', async () => {
    const at = '2099-01-02T15:00:00+08:00';
    expect(await execute({ name: args.name, prompt: args.prompt, at }, vi.fn().mockResolvedValue({ allow: true }))).toMatchObject({ ok: true });
    expect(mocks.createJob.mock.calls[0][0].schedule).toEqual({ type: 'at', datetime: Date.parse(at) });
  });

  it.each([
    { ...args, cron: '* * *' }, { ...args, timezone: 'Not/AZone' },
    { ...args, at: '2099-01-02T15:00:00Z' }, { name: 'missing prompt', cron: args.cron },
    { name: args.name, prompt: args.prompt, at: '2020-01-01T00:00:00Z' },
    { name: args.name, prompt: args.prompt, at: '2099-01-02T15:00:00' },
  ])('rejects invalid input before approval: %j', async (input) => {
    const approval = vi.fn();
    expect(await execute(input, approval)).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(approval).not.toHaveBeenCalled();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it('does not create on denial, cancellation or unattended invocation', async () => {
    expect(await execute(args, vi.fn().mockResolvedValue({ allow: false }))).toMatchObject({ code: 'PERMISSION_DENIED' });
    const controller = new AbortController(); controller.abort();
    expect(await execute(args, vi.fn().mockResolvedValue({ allow: true }), { ...ctx, abortSignal: controller.signal })).toMatchObject({ code: 'ABORTED' });
    mocks.unattended.mockReturnValue(true);
    const approval = vi.fn();
    expect(await execute(args, approval)).toMatchObject({ code: 'UNATTENDED_UNSUPPORTED' });
    expect(approval).not.toHaveBeenCalled();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it('reports persistence failure without claiming creation', async () => {
    mocks.createJob.mockRejectedValue(new Error('storage unavailable'));
    expect(await execute(args, vi.fn().mockResolvedValue({ allow: true }))).toMatchObject({ ok: false, code: 'SCHEDULE_CREATE_FAILED' });
  });
});
