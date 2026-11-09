// 审批卡授权 IPC 动作：只有 granted 才放行同文件夹兄弟请求；kept_existing 只放行被点的这一条。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  grantResult: undefined as unknown,
  rows: [] as Array<{ id: string; kind: string; status: string; payloadJson: string }>,
  respond: vi.fn((_sessionId: string, _requestId: string, _response: string) => 'delivered'),
}));

vi.mock('../../../src/host/cron/cronService', () => ({
  getCronService: () => ({ grantWriteFolderFromParkedApproval: async () => h.grantResult }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getPendingApprovalRepo: () => ({
      getById: (id: string) => h.rows.find((r) => r.id === id) ?? null,
      listByKindAndStatus: () => h.rows.filter((r) => r.status === 'pending'),
    }),
  }),
}));
vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({ handlePermissionResponse: h.respond }),
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => null }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

import { registerCronHandlers } from '../../../src/host/ipc/cron.ipc';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'neo-ipc-sib-')));
  mkdirSync(path.join(dir, 'notes'));
  const notes = path.join(dir, 'notes');
  h.rows = ['a.md', 'b.md', 'c.md'].map((n, i) => ({
    id: `req-${i}`, kind: 'tool_approval', status: 'pending',
    payloadJson: JSON.stringify({ sessionId: 's1', type: 'file_write', argsSummary: path.join(notes, n), writeGrantFolder: notes }),
  }));
  h.respond.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = () => (registerCronHandlers.routes.actions as unknown as Record<string, (c: unknown, p: unknown) => Promise<unknown>>)
  .grantWriteFolderFromParkedApproval(undefined, { requestId: 'req-0' });

describe('grantWriteFolderFromParkedApproval 兄弟放行', () => {
  it('granted：被点的 + 同文件夹兄弟都放行', async () => {
    h.grantResult = { status: 'granted', folder: path.join(dir, 'notes'), jobId: 'j' };
    await call();
    expect(h.respond.mock.calls.map((c) => c[1]).sort()).toEqual(['req-0', 'req-1', 'req-2']);
  });

  it('kept_existing：只放行被点的这一条，兄弟不动', async () => {
    h.grantResult = { status: 'kept_existing', folder: path.join(dir, 'notes'), existingRoot: '/other', jobId: 'j' };
    await call();
    expect(h.respond.mock.calls.map((c) => c[1])).toEqual(['req-0']);
  });
});
