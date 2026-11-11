import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const workflowsDir = path.join(repoRoot, '.github/workflows');
const COMPOSITE = '.github/actions/setup-playwright';

type WorkflowStep = {
  name?: string;
  run?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type WorkflowFile = {
  jobs?: Record<string, WorkflowJob>;
};

function workflowPaths(): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(workflowsDir, name));
}

function loadWorkflow(file: string): WorkflowFile {
  return loadYaml(readFileSync(file, 'utf8')) as WorkflowFile;
}

function stepsOf(doc: WorkflowFile): WorkflowStep[] {
  return Object.values(doc.jobs ?? {}).flatMap((job) => job?.steps ?? []);
}

function isSetupPlaywright(step: WorkflowStep): boolean {
  return typeof step.uses === 'string' && step.uses.includes(COMPOSITE);
}

function wantsDeps(step: WorkflowStep): boolean {
  const value = step.with?.['with-deps'];
  return value === true || value === 'true';
}

describe('Playwright install lives in the composite action', () => {
  it('fails when a workflow step outside the composite runs playwright install', () => {
    const offenders: string[] = [];
    for (const file of workflowPaths()) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      const doc = loadWorkflow(file);
      for (const step of stepsOf(doc)) {
        if (typeof step.run === 'string' && step.run.includes('playwright install')) {
          offenders.push(`${rel}: ${step.name ?? '(unnamed step)'}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('routes every former install site through setup-playwright, preserving --with-deps', () => {
    const byFile = new Map<string, WorkflowStep[]>();
    for (const file of workflowPaths()) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      byFile.set(rel, stepsOf(loadWorkflow(file)).filter(isSetupPlaywright));
    }

    const swarm = byFile.get('.github/workflows/swarm-ci.yml') ?? [];
    const main = byFile.get('.github/workflows/main-full-gate.yml') ?? [];
    const scroll = byFile.get('.github/workflows/long-session-scroll-gate.yml') ?? [];
    expect(swarm).toHaveLength(4);
    expect(swarm.every(wantsDeps)).toBe(true);
    expect(main).toHaveLength(1);
    expect(main.some(wantsDeps)).toBe(false);
    expect(scroll).toHaveLength(1);
    expect(scroll.some(wantsDeps)).toBe(false);

    const otherUses = [...byFile.entries()]
      .filter(([rel]) => ![
        '.github/workflows/swarm-ci.yml',
        '.github/workflows/main-full-gate.yml',
        '.github/workflows/long-session-scroll-gate.yml',
      ].includes(rel))
      .flatMap(([, steps]) => steps);
    expect(otherUses).toEqual([]);

    const action = readFileSync(path.join(repoRoot, COMPOSITE, 'action.yml'), 'utf8');
    expect(action).toContain('actions/cache@v4');
    expect(action).toContain('~/.cache/ms-playwright');
    expect(action).toContain('-v2');
    expect(action).toContain('npx playwright install --with-deps chromium');
    expect(action).toContain('npx playwright install chromium');
    expect(action).not.toContain('cache-hit');
  });
});


describe('Playwright install retries the real action script', () => {
  const cases = [
    { failures: 0, withDeps: true, code: 100 },
    { failures: 1, withDeps: true, code: 100 },
    { failures: 2, withDeps: true, code: 100 },
    { failures: 3, withDeps: true, code: 100 },
    { failures: 1, withDeps: false, code: 100 },
    { failures: 2, withDeps: false, code: 100 },
    { failures: 3, withDeps: false, code: 100 },
    { failures: 1, withDeps: false, code: 42 },
    { failures: 3, withDeps: true, code: 42, defaultDelay: true },
  ];

  it.each(cases)('K=$failures with-deps=$withDeps exit=$code defaultDelay=$defaultDelay', ({
    failures, withDeps, code, defaultDelay,
  }) => {
    const action = loadYaml(readFileSync(path.join(repoRoot, COMPOSITE, 'action.yml'), 'utf8')) as {
      runs: { steps: WorkflowStep[] };
    };
    const step = action.runs.steps.find((candidate) => candidate.name === 'Install Playwright browsers');
    expect(typeof step?.run).toBe('string');
    const script = (step?.run as string).replaceAll('${{ inputs.with-deps }}', String(withDeps));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'playwright-install-retry-'));
    try {
      writeFileSync(path.join(dir, 'npx'), `#!/bin/bash
set -eu
count=0
if [ -f "$RETRY_TEST_DIR/count" ]; then count=$(cat "$RETRY_TEST_DIR/count"); fi
count=$((count + 1))
echo "$count" > "$RETRY_TEST_DIR/count"
printf '%s\n' "$*" >> "$RETRY_TEST_DIR/args"
echo "fake npx call $count: $*"
if [ "$count" -le "$RETRY_TEST_FAILURES" ]; then
  echo "Temporary failure resolving azure.archive.ubuntu.com" >&2
  exit "$RETRY_TEST_EXIT_CODE"
fi
echo "Playwright install succeeded"
`, { mode: 0o755 });
      // Record requested waits without delaying this test, including the production default.
      writeFileSync(path.join(dir, 'sleep'), `#!/bin/bash
printf '%s\n' "$1" >> "$RETRY_TEST_DIR/sleeps"
`, { mode: 0o755 });
      const env = {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        RETRY_TEST_DIR: dir,
        RETRY_TEST_FAILURES: String(failures),
        RETRY_TEST_EXIT_CODE: String(code),
        PLAYWRIGHT_INSTALL_RETRY_BASE_DELAY: '0',
      };
      if (defaultDelay) delete (env as NodeJS.ProcessEnv).PLAYWRIGHT_INSTALL_RETRY_BASE_DELAY;
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
        cwd: dir, env, encoding: 'utf8', timeout: 10_000,
      });
      console.log(`K=${failures} with-deps=${withDeps} failure-exit=${code} default-delay=${!!defaultDelay}\n${result.stdout}${result.stderr}exit=${result.status}`);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(failures >= 3 ? code : 0);
      const calls = Math.min(failures + 1, 3);
      expect(Number(readFileSync(path.join(dir, 'count'), 'utf8'))).toBe(calls);
      expect(readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n')).toEqual(
        Array.from({ length: calls }, () => `playwright install ${withDeps ? '--with-deps ' : ''}chromium`),
      );
      expect(result.stdout).toContain('attempt 1/3');
      if (failures > 0) {
        expect(result.stdout).toContain(`attempt 1/3 failed (exit code ${code})`);
        expect(result.stdout).toContain('Temporary failure resolving azure.archive.ubuntu.com');
        const waits = readFileSync(path.join(dir, 'sleeps'), 'utf8').trim().split('\n');
        expect(waits).toEqual(Array.from({ length: calls - 1 }, (_, i) => String(defaultDelay ? 15 * (i + 1) : 0)));
        expect(result.stdout).toContain(`retrying in ${defaultDelay ? 15 : 0}s`);
      }
      expect(result.stdout.match(/::warning::/g) ?? []).toHaveLength(failures < 3 ? failures : 0);
      if (failures >= 3) expect(result.stdout).toContain('all 3 attempts failed');
      else expect(result.stdout).toContain('Playwright install succeeded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
