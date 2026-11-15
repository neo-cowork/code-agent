// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const appState = { language: 'zh' as 'zh' | 'en', setShowSettings: vi.fn(), setPendingRoleChatSeed: vi.fn() };
const createSession = vi.fn(async (title?: string) => ({ id: 's1', title }));
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: { getState: () => appState } }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: { getState: () => ({ createSession }) } }));

import { getDisplaySessionTitle } from '../../../src/renderer/utils/sessionPresentation';
import { startCreateRoleChat } from '../../../src/renderer/utils/startCreateRoleChat';
import { startEditRoleChat } from '../../../src/renderer/utils/startEditRoleChat';

beforeEach(() => {
  appState.language = 'zh';
  createSession.mockClear();
});

describe('对话式建/改角色会话的标题跟随界面语言（FB-1302）', () => {
  it('创建时按当前界面语言写标题；中文界面与改动前逐字相同', async () => {
    await startCreateRoleChat();
    await startEditRoleChat('研究员');
    expect(createSession.mock.calls.map((call) => call[0])).toEqual(['新建角色', '修改角色：研究员']);

    createSession.mockClear();
    appState.language = 'en';
    await startCreateRoleChat();
    await startEditRoleChat('研究员');
    expect(createSession.mock.calls.map((call) => call[0])).toEqual(['New role', 'Edit role: 研究员']);
  });

  it('展示层：库里存的中文固定名在英文界面显示英文，反过来也成立，角色名本身不动', () => {
    expect(getDisplaySessionTitle('新建角色', 'en')).toBe('New role');
    expect(getDisplaySessionTitle('修改角色：researcher', 'en')).toBe('Edit role: researcher');
    expect(getDisplaySessionTitle('New role', 'zh')).toBe('新建角色');
    expect(getDisplaySessionTitle('Edit role: researcher', 'zh')).toBe('修改角色：researcher');
    expect(getDisplaySessionTitle('新建角色', 'zh')).toBe('新建角色');
    expect(getDisplaySessionTitle('修改角色：研究员', 'zh')).toBe('修改角色：研究员');
  });

  it('只认整句固定名和固定前缀，用户自己起的相近标题原样保留', () => {
    expect(getDisplaySessionTitle('新建角色方案讨论', 'en')).toBe('新建角色方案讨论');
    expect(getDisplaySessionTitle('New role ideas', 'zh')).toBe('New role ideas');
  });
});
