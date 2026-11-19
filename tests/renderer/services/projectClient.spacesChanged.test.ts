// @vitest-environment jsdom
// 归档/恢复/删除空间都要通知侧栏重拉空间列表，否则残留空组里的「新建会话」会带无效 projectId。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn(async () => ({ deleted: true })) },
}));

import { SPACES_CHANGED_EVENT, deleteProject, setProjectStatus } from '../../../src/renderer/services/projectClient';

afterEach(() => vi.clearAllMocks());

describe('projectClient notifies the sidebar when the space set changes', () => {
  it.each([
    ['archive', () => setProjectStatus('p1', 'archived')],
    ['restore', () => setProjectStatus('p1', 'active')],
    ['delete', () => deleteProject('p1')],
  ])('%s fires the spaces-changed event', async (_name, run) => {
    const handler = vi.fn();
    window.addEventListener(SPACES_CHANGED_EVENT, handler);
    await run();
    window.removeEventListener(SPACES_CHANGED_EVENT, handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
