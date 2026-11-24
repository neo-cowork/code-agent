import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { debug: vi.fn(), info, warn, error: vi.fn() };
  return { createLogger: () => fake };
});

import { readDevCliConnectorStatusShim } from '../../../src/host/connectors/cli/devCliConnectorStatusShim';

let dir: string;
const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
const previousDevApi = process.env.CODE_AGENT_ENABLE_DEV_API;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dev-cli-shim-'));
  process.env.CODE_AGENT_DATA_DIR = dir;
  delete process.env.CODE_AGENT_ENABLE_DEV_API;
  warn.mockClear();
  info.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  if (previousDevApi === undefined) delete process.env.CODE_AGENT_ENABLE_DEV_API;
  else process.env.CODE_AGENT_ENABLE_DEV_API = previousDevApi;
});

function writeShim(body: string): void {
  writeFileSync(path.join(dir, 'dev-cli-connector-status.json'), body);
}

describe('readDevCliConnectorStatusShim', () => {
  it('开发 API 没开时不读文件', () => {
    writeShim(JSON.stringify({ feishu: { connected: false, lostReason: 'cli_not_logged_in' } }));
    expect(readDevCliConnectorStatusShim('feishu')).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('文件不存在时不警告，走真探测', () => {
    process.env.CODE_AGENT_ENABLE_DEV_API = 'true';
    expect(readDevCliConnectorStatusShim('feishu')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('未登录与已连接都按文件返回，日志不带绝对路径', () => {
    process.env.CODE_AGENT_ENABLE_DEV_API = 'true';
    writeShim(JSON.stringify({
      feishu: { connected: false, lostReason: 'cli_not_logged_in' },
      tmeet: { connected: true },
    }));
    expect(readDevCliConnectorStatusShim('feishu')).toEqual({
      connected: false,
      identity: 'none',
      lostReason: 'cli_not_logged_in',
    });
    expect(readDevCliConnectorStatusShim('tmeet')).toEqual({ connected: true, identity: 'none' });
    expect(readDevCliConnectorStatusShim('mail')).toBeUndefined();
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(dir);
    expect(info).toHaveBeenCalledWith('Dev CLI connector status shim applied', expect.objectContaining({
      connectorId: 'feishu',
      connected: false,
      lostReason: 'cli_not_logged_in',
    }));
  });

  it('读不了或不是对象时警告并当没写', () => {
    process.env.CODE_AGENT_ENABLE_DEV_API = 'true';
    writeShim('{');
    expect(readDevCliConnectorStatusShim('feishu')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Dev CLI connector status shim ignored', {
      connectorId: 'feishu',
      reason: 'unreadable',
    });
    warn.mockClear();
    writeShim('[]');
    expect(readDevCliConnectorStatusShim('feishu')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Dev CLI connector status shim ignored', {
      connectorId: 'feishu',
      reason: 'not-object',
    });
  });
});
