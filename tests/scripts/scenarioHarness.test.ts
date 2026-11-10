import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertEnv, isSameGitCommit, resolveEnv } from '../../scripts/scenario/harness.mjs';

describe('scenario harness commit identity', () => {
  const fullCommit = '5a62db1cc35f4f014da13d89b692649f4a27c8e3';

  it('matches a full build commit to the local HEAD', () => {
    expect(isSameGitCommit(fullCommit, fullCommit)).toBe(true);
  });

  it('matches stable and repository-configured abbreviations to the full commit', () => {
    expect(isSameGitCommit('5a62db1', fullCommit)).toBe(true);
    expect(isSameGitCommit('5a62db1cc', fullCommit)).toBe(true);
  });

  it('rejects different and malformed commit identities', () => {
    expect(isSameGitCommit('5a62db2', fullCommit)).toBe(false);
    expect(isSameGitCommit('5a62db', fullCommit)).toBe(false);
    expect(isSameGitCommit('', fullCommit)).toBe(false);
  });
});

vi.mock('../../scripts/verify-slotless.mjs', () => ({ readDogfoodCredentials: () => ({ email: 'dogfood@example.test' }) }));
const homes: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('scenario runner installed Dev-slot admission', () => {
  it('resolves an installed Dev slot without requiring a nonexistent alternate directory', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'scenario-slot-')); homes.push(home);
    vi.stubEnv('HOME', home); vi.stubEnv('CODE_AGENT_DATA_DIR', ''); vi.stubEnv('NEO_VERIFY_DATA_DIR', '');
    expect(() => resolveEnv({ slot: 2 })).not.toThrow();
    expect(resolveEnv({ slot: 2 })).toMatchObject({ dataDir: path.join(home, '.code-agent-dev2'), port: 8182, token: null });
  });

  it('returns NOT_RUN for an owner account before any scenario or build operations', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(new URL(url).pathname);
      return new Response(JSON.stringify(String(url).endsWith('/getStatus')
        ? { success: true, data: { isAuthenticated: true, sessionTrustState: 'verified', user: { email: 'owner@example.test', isAdmin: true } } }
        : { status: 'ok', build: { commit: 'fixture' } }));
    }));
    await expect(assertEnv({ baseUrl: 'http://127.0.0.1:8182', token: 'fixture-token' })).rejects.toMatchObject({ reason: 'dogfood_account_required' });
    expect(requests).toEqual(['/api/domain/auth/getStatus']);
  });
});
