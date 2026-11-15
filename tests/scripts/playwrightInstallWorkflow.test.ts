import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // smoke/unit/full run inside the Playwright image; perf-journey-ratchet stays on the plain runner.
    expect(swarm).toHaveLength(1);
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


describe('swarm-ci Playwright jobs use the pinned Playwright image instead of apt', () => {
  const containerJobs = ['smoke', 'unit', 'full'];
  const doc = loadYaml(readFileSync(path.join(workflowsDir, 'swarm-ci.yml'), 'utf8')) as {
    jobs: Record<string, {
      container?: string | { image?: string; options?: string; volumes?: string[] };
      env?: Record<string, string>;
      needs?: string | string[];
      steps?: WorkflowStep[];
    }>;
  };
  const lockVersion = (JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version: string }>;
  }).packages['node_modules/playwright'].version;

  it('perf-journey-ratchet stays on the plain runner with setup-playwright --with-deps', () => {
    const perfJob = doc.jobs['perf-journey-ratchet'];
    expect(perfJob.container).toBeUndefined();
    expect(perfJob.env?.HOME).toBeUndefined();
    const needs = ([] as string[]).concat(perfJob.needs ?? []);
    expect(needs).not.toContain('container-tools');
    const steps = perfJob.steps ?? [];
    expect(steps.some((step) => String(step.uses ?? '') === './.github/actions/container-tools')).toBe(false);
    expect(steps.some((step) => String(step.run ?? '').includes('safe.directory'))).toBe(false);
    const installIdx = steps.findIndex((step) => String(step.run ?? '').includes('npm ci'));
    const setupIdx = steps.findIndex(isSetupPlaywright);
    const probeIdx = steps.findIndex((step) => String(step.run ?? '').includes('scripts/perf-journey-ratchet.mjs'));
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeGreaterThan(installIdx);
    expect(probeIdx).toBeGreaterThan(setupIdx);
    expect(wantsDeps(steps[setupIdx])).toBe(true);
  });

  it.each(containerJobs)('%s runs in mcr playwright image matching package-lock', (name) => {
    const container = doc.jobs[name].container;
    const image = typeof container === 'string' ? container : container?.image;
    expect(image).toBe(`mcr.microsoft.com/playwright:v${lockVersion}-noble`);
  });

  it.each(containerJobs)('%s runs as non-root with an init process and host tools', (name) => {
    const container = doc.jobs[name].container;
    const options = typeof container === 'string' ? '' : String(container?.options ?? '');
    expect(options).toContain('--user 1001');
    expect(options).toContain('--init');
    // HOME=/github/home breaks /home/<user> redaction assertions and is not writable as uid 1001.
    const job = doc.jobs[name] as { env?: Record<string, string> };
    expect(job.env?.HOME).toBe('/home/runner');
    expect(typeof container === 'string' ? [] : container?.volumes).toContain('/home/runner:/home/runner');
    const steps = doc.jobs[name].steps ?? [];
    expect(steps.some((step) => String(step.uses ?? '') === './.github/actions/container-tools')).toBe(true);
    expect(steps.some((step) => String(step.uses ?? '').startsWith('actions/setup-node'))).toBe(true);
    const needs = ([] as string[]).concat((doc.jobs[name] as { needs?: string | string[] }).needs ?? []);
    expect(needs).toContain('container-tools');
  });

  it.each(containerJobs)('%s trusts the workspace for git right after checkout', (name) => {
    const steps = doc.jobs[name].steps ?? [];
    const checkout = steps.findIndex((step) => String(step.uses ?? '').startsWith('actions/checkout'));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(String(steps[checkout + 1].run ?? '')).toContain('git config --global --add safe.directory "$GITHUB_WORKSPACE"');
  });

  it.each(containerJobs)('%s never runs apt or playwright install', (name) => {
    for (const step of doc.jobs[name].steps ?? []) {
      expect(String(step.uses ?? '')).not.toContain(COMPOSITE);
      expect(String(step.run ?? '')).not.toMatch(/apt(-get)?\s|playwright install|sudo /);
    }
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
    { failures: 1, withDeps: true, code: 100, missingSources: true },
    { failures: 2, withDeps: true, code: 100, aptUpdateCode: 100 },
    { failures: 3, withDeps: true, code: 42, defaultDelay: true },
  ];

  it.each(cases)('K=$failures with-deps=$withDeps exit=$code defaultDelay=$defaultDelay', ({
    failures, withDeps, code, defaultDelay, missingSources, aptUpdateCode,
  }) => {
    const action = loadYaml(readFileSync(path.join(repoRoot, COMPOSITE, 'action.yml'), 'utf8')) as {
      runs: { steps: WorkflowStep[] };
    };
    const step = action.runs.steps.find((candidate) => candidate.name === 'Install Playwright browsers');
    expect(typeof step?.run).toBe('string');
    const run = step?.run as string;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'playwright-install-retry-'));
    try {
      // Redirect only the apt filesystem root; execute the real rewrite code via fake sudo.
      const aptDir = path.join(dir, 'apt');
      const script = run.replaceAll('${{ inputs.with-deps }}', String(withDeps))
        .replaceAll('/etc/apt', aptDir);
      mkdirSync(path.join(aptDir, 'sources.list.d'), { recursive: true });
      const fixtures: Record<string, string> = {
        'apt-mirrors.txt': 'http://azure.archive.ubuntu.com/ubuntu/\n',
        'sources.list': 'deb http://azure.archive.ubuntu.com/ubuntu noble main\n',
        'sources.list.d/ubuntu.sources': 'URIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble\n',
        'sources.list.d/security.sources': 'URIs: https://azure.archive.ubuntu.com/ubuntu/\n',
        'sources.list.d/other.sources': 'URIs: http://security.ubuntu.com/ubuntu/\n',
      };
      for (const [file, content] of Object.entries(fixtures)) {
        if (!missingSources) writeFileSync(path.join(aptDir, file), content);
      }
      writeFileSync(path.join(dir, 'sudo'), `#!/bin/bash
printf 'sudo %s\\n' "$*" >> "$RETRY_TEST_DIR/events"
exec "$@"
`, { mode: 0o755 });
      writeFileSync(path.join(dir, 'apt-get'), `#!/bin/bash
printf 'apt-get %s\\n' "$*" >> "$RETRY_TEST_DIR/events"
echo "fake apt-get $* (exit $RETRY_TEST_APT_UPDATE_CODE)"
exit "$RETRY_TEST_APT_UPDATE_CODE"
`, { mode: 0o755 });
      writeFileSync(path.join(dir, 'npx'), `#!/bin/bash
set -eu
count=0
if [ -f "$RETRY_TEST_DIR/count" ]; then count=$(cat "$RETRY_TEST_DIR/count"); fi
count=$((count + 1))
echo "$count" > "$RETRY_TEST_DIR/count"
echo "npx $count" >> "$RETRY_TEST_DIR/events"
if [ -f "$RETRY_TEST_DIR/apt/apt-mirrors.txt" ]; then
  cat "$RETRY_TEST_DIR/apt/apt-mirrors.txt" > "$RETRY_TEST_DIR/mirror-$count"
fi
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
        RETRY_TEST_APT_UPDATE_CODE: String(aptUpdateCode ?? 0),
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
      const switchesMirror = withDeps && failures > 0;
      const events = readFileSync(path.join(dir, 'events'), 'utf8').trim().split('\n');
      const expectedEvents = ['npx 1'];
      if (switchesMirror) expectedEvents.push('sudo python3 -', 'sudo apt-get update', 'apt-get update');
      for (let call = 2; call <= calls; call++) expectedEvents.push(`npx ${call}`);
      expect(events).toEqual(expectedEvents);
      expect(run).toContain('sudo python3');
      expect(run).toContain('sudo apt-get update');
      expect(run).toContain("apt / 'apt-mirrors.txt'");
      expect(run).toContain("apt / 'sources.list'");
      expect(run).toContain("apt.glob('sources.list.d/*.sources')");
      console.log(`mirror execution order: ${events.join(' -> ')}`);
      expect(result.stdout).toContain('attempt 1/3 (apt source: runner-configured)');
      if (switchesMirror) {
        expect(result.stdout).toContain('Switching apt source to http://archive.ubuntu.com/ubuntu/ before attempt 2/3');
        expect(result.stdout).toContain(`apt source: ${aptUpdateCode ? 'fallback attempted: ' : ''}http://archive.ubuntu.com/ubuntu/`);
        if (aptUpdateCode) expect(result.stdout).toContain(`apt mirror refresh failed (exit code ${aptUpdateCode})`);
      } else {
        expect(result.stdout).not.toContain('Switching apt source');
      }
      for (const [file, original] of Object.entries(fixtures)) {
        const fixture = path.join(aptDir, file);
        if (missingSources) expect(existsSync(fixture)).toBe(false);
        else expect(readFileSync(fixture, 'utf8')).toBe(switchesMirror && !file.endsWith('other.sources')
          ? original.replace(/https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?/g, 'http://archive.ubuntu.com/ubuntu/')
          : original);
      }
      if (!missingSources) {
        expect(readFileSync(path.join(dir, 'mirror-1'), 'utf8')).toBe(fixtures['apt-mirrors.txt']);
        for (let call = 2; call <= calls; call++) {
          expect(readFileSync(path.join(dir, `mirror-${call}`), 'utf8')).toBe(switchesMirror
            ? 'http://archive.ubuntu.com/ubuntu/\n' : fixtures['apt-mirrors.txt']);
        }
      }
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
