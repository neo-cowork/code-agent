// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { pickWorkingDirectory } from '../../../src/renderer/services/workingDirectoryPicker';

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: dialogMocks.open,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));

describe('pickWorkingDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('calls @tauri-apps/plugin-dialog open with directory: true in Tauri mode, then invokes WORKSPACE.setCurrent and returns the picked path', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    dialogMocks.open.mockResolvedValueOnce('/picked/folder');
    invokeDomain.mockResolvedValueOnce('/picked/folder');

    const result = await pickWorkingDirectory('选择工作目录');

    expect(result).toBe('/picked/folder');
    expect(dialogMocks.open).toHaveBeenCalledTimes(1);
    expect(dialogMocks.open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '选择工作目录',
    });
    expect(invokeDomain).toHaveBeenCalledTimes(1);
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'setCurrent', {
      dir: '/picked/folder',
    });
  });

  it('returns null and invokes nothing else when the native picker is canceled in Tauri mode', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    dialogMocks.open.mockResolvedValueOnce(null);

    const result = await pickWorkingDirectory('选择工作目录');

    expect(result).toBeNull();
    expect(dialogMocks.open).toHaveBeenCalledTimes(1);
    expect(invokeDomain).not.toHaveBeenCalled();
  });

  it('falls back to WORKSPACE.selectDirectory in non-Tauri mode', async () => {
    invokeDomain.mockResolvedValueOnce('/fallback/dir');

    const result = await pickWorkingDirectory('选择工作目录');

    expect(result).toBe('/fallback/dir');
    expect(dialogMocks.open).not.toHaveBeenCalled();
    expect(invokeDomain).toHaveBeenCalledTimes(1);
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'selectDirectory');
  });
});
