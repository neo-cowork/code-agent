import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/host/runtime/pythonEnv/ensure', () => ({
  ensurePythonEnv: vi.fn(),
}));

import { createEvalSafeShellEnv } from '../../../../../src/host/tools/modules/shell/evalSafeShellEnv';

describe('createEvalSafeShellEnv × desktop shell bridge env hard-deny', () => {
  const savedBridgeUrl = process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
  const savedBridgeToken = process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
  const savedDataDir = process.env.CODE_AGENT_DATA_DIR;
  const savedEvalRealRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;
  let tempDirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    process.env.CODE_AGENT_DATA_DIR = makeTmpDir('eval-safe-data-');
    delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = 'http://127.0.0.1:54321';
    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = 'secret-bridge-token-64hex';
  });

  afterEach(() => {
    if (savedBridgeUrl === undefined) delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
    else process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = savedBridgeUrl;
    if (savedBridgeToken === undefined) delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
    else process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = savedBridgeToken;
    if (savedDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = savedDataDir;
    if (savedEvalRealRoot === undefined) delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
    else process.env.CODE_AGENT_EVAL_REAL_ROOT = savedEvalRealRoot;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it.each([
    { mode: 'allowed_secret_vars escape hatch', policy: '[env_filter]\nstrip_secret_vars = true\nallowed_secret_vars = ["CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN", "CODE_AGENT_ENV_ASSIST_BRIDGE_URL"]\n', extra: false },
    { mode: 'network secureref refill', policy: '', extra: false },
    { mode: 'strip_secret_vars=false with extra overrides', policy: '[env_filter]\nstrip_secret_vars = false\n', extra: true },
  ])('hard-denies both bridge vars under $mode', ({ policy, extra }) => {
    const projectDir = makeTmpDir('eval-safe-proj-');
    fs.writeFileSync(path.join(projectDir, 'code-agent-policy.toml'), policy);
    const result = createEvalSafeShellEnv(
      extra ? {
        CODE_AGENT_ENV_ASSIST_BRIDGE_URL: process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL,
        CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN: process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN,
      } : undefined,
      projectDir,
      undefined,
      { allowNetwork: true, command: 'echo $CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env).not.toHaveProperty('CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN');
      expect(result.env).not.toHaveProperty('CODE_AGENT_ENV_ASSIST_BRIDGE_URL');
      expect(Object.values(result.env)).not.toContain('secret-bridge-token-64hex');
    }
  });
});
