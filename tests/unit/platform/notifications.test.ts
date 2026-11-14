import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notification } from '../../../src/host/platform/notifications';

afterEach(() => vi.restoreAllMocks());

describe('platform Notification support detection', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('reports support only on macOS (%s)', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    expect(Notification.isSupported()).toBe(platform === 'darwin');
  });
});
