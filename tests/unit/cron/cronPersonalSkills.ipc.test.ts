import { beforeEach, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import { CronSchemas } from '../../../src/shared/ipc/schemas/cron';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
  createJob: vi.fn(async (..._args: unknown[]) => ({ id: 'morning' })),
  updateJob: vi.fn(async (..._args: unknown[]) => ({ id: 'morning' })),
}));
vi.mock('../../../src/host/platform', () => ({ ipcHost: { handle: (ch: string, fn: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => h.handlers.set(ch, fn) } }));
vi.mock('../../../src/host/cron/cronService', () => ({ getCronService: () => h }));
vi.mock('../../../src/host/model/modelRouter', () => ({ ModelRouter: class {} }));
import { registerCronHandlers } from '../../../src/host/ipc/cron.ipc';
beforeEach(() => { vi.clearAllMocks(); h.handlers.clear(); registerCronHandlers(); });

it('cron schema and public create/update IPC keep only explicit normalized personal names, including clearing', async () => {
  const action = { type: 'agent', agentType: 'default', prompt: '汇总邮件、即时消息和日历',
    allowedPersonalSkillIds: [' wechat-local-query ', 'wechat-local-query', '/tmp/skill', 42] };
  const request = { action: 'createJob', payload: { name: '晨间分诊', action } };
  expect(CronSchemas.REQUEST.payload.safeParse(request).success).toBe(true);
  const call = (action: string, payload: unknown) => h.handlers.get(IPC_DOMAINS.CRON)!(null, { action, payload } as IPCRequest);
  expect(await call('createJob', request.payload)).toMatchObject({ success: true });
  expect(h.createJob).toHaveBeenCalledWith({ name: '晨间分诊', action: { ...action, allowedPersonalSkillIds: ['wechat-local-query'] } });
  await call('updateJob', { jobId: 'morning', updates: { action } });
  expect(h.updateJob).toHaveBeenLastCalledWith('morning', { action: { ...action, allowedPersonalSkillIds: ['wechat-local-query'] } });
  await call('updateJob', { jobId: 'morning', updates: { action: { ...action, allowedPersonalSkillIds: [] } } });
  expect(h.updateJob).toHaveBeenLastCalledWith('morning', { action: { ...action, allowedPersonalSkillIds: undefined } });
  expect(action.allowedPersonalSkillIds).toEqual([' wechat-local-query ', 'wechat-local-query', '/tmp/skill', 42]);
});
