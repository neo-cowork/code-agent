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

  it('excludes both bridge env vars even under allowNetwork secureref refill and allowed_secret_vars escape hatch', () => {
    const projectDir = makeTmpDir('eval-safe-proj-');
    fs.writeFileSync(
      path.join(projectDir, 'code-agent-policy.toml'),
      [
        '[env_filter]',
        'strip_secret_vars = true',
        'allowed_secret_vars = ["CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN", "CODE_AGENT_ENV_ASSIST_BRIDGE_URL"]',
      ].join('\n'),
    );

    const allowedResult = createEvalSafeShellEnv(undefined, projectDir, undefined, {
      allowNetwork: true,
      command: 'echo $CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN',
    });
    expect(allowedResult.ok).toBe(true);
    if (allowedResult.ok) {
      expect(allowedResult.env).not.toHaveProperty('CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN');
      expect(allowedResult.env).not.toHaveProperty('CODE_AGENT_ENV_ASSIST_BRIDGE_URL');
      expect(Object.values(allowedResult.env)).not.toContain('secret-bridge-token-64hex');
    }

    // Also verify default strip_secret_vars=true (empty allowed_secret_vars) with allowNetwork refill,
    // plus strip_secret_vars=false and explicit extra overrides.
    const defaultProjectDir = makeTmpDir('eval-safe-default-proj-');
    const refillResult = createEvalSafeShellEnv(undefined, defaultProjectDir, undefined, {
      allowNetwork: true,
      command: 'echo $CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN',
    });
    expect(refillResult.ok).toBe(true);
    if (refillResult.ok) {
      expect(refillResult.env).not.toHaveProperty('CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN');
      expect(refillResult.env).not.toHaveProperty('CODE_AGENT_ENV_ASSIST_BRIDGE_URL');
      expect(Object.values(refillResult.env)).not.toContain('secret-bridge-token-64hex');
    }

    const stripDisabledProjectDir = makeTmpDir('eval-safe-strip-off-proj-');
    fs.writeFileSync(
      path.join(stripDisabledProjectDir, 'code-agent-policy.toml'),
      '[env_filter]\nstrip_secret_vars = false\n',
    );
    const stripOffResult = createEvalSafeShellEnv(
      {
        CODE_AGENT_ENV_ASSIST_BRIDGE_URL: 'http://127.0.0.1:54321',
        CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN: 'secret-bridge-token-64hex',
      },
      stripDisabledProjectDir,
      undefined,
      { allowNetwork: true, command: 'echo $CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN' },
    );
    expect(stripOffResult.ok).toBe(true);
    if (stripOffResult.ok) {
      expect(stripOffResult.env).not.toHaveProperty('CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN');
      expect(stripOffResult.env).not.toHaveProperty('CODE_AGENT_ENV_ASSIST_BRIDGE_URL');
    }
  });
});
