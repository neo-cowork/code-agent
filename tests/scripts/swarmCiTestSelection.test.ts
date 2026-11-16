import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const testsRoot = resolve(repoRoot, 'tests');
const workflowsRoot = resolve(repoRoot, '.github/workflows');

type WorkflowStep = { run?: string };
type WorkflowJob = {
  if?: string;
  needs?: string[];
  'runs-on'?: string;
  steps?: WorkflowStep[];
};
type Workflow = {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(name: string): Workflow {
  return loadYaml(readFileSync(resolve(workflowsRoot, name), 'utf8')) as Workflow;
}

function containsVitestFile(directory: string): boolean {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .some((entry) => entry.isFile() && /\.test\.tsx?$/.test(entry.name));
}

const intentionalExclusions: Record<string, string> = {
  e2e: 'Playwright tests run through the full job, not Vitest.',
  manual: 'Manual tests require an explicit operator-driven run.',
  smoke: 'Desktop-mutating smoke tests are excluded in vitest.config.ts.',
};

const platformRoutes = [
  {
    file: 'tests/integration/delegate-reminders/delegateRemindersCreateFaultInjection.test.ts',
    job: 'darwin',
    reason: 'reminders_create is registered only on Darwin; #3526 Ubuntu shard 3 failed before the injected tool call.',
  },
  {
    file: 'tests/integration/sandbox/bubblewrapWrap.test.ts',
    job: 'linux-sandbox',
    reason: 'Real Linux user/network namespaces need a host with bubblewrap, absent in the Playwright container (#3526 shard 1).',
  },
];

const preMergeRunCommands = readdirSync(workflowsRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
  .flatMap((entry) => {
    const workflow = readWorkflow(entry.name);
    if (!workflow.on || (!('pull_request' in workflow.on) && !('merge_group' in workflow.on))) return [];
    return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  })
  .map((step) => step.run ?? '')
  .filter((run) => run.includes('vitest'));

describe('pre-merge Vitest selection', () => {
  it('keeps platform-routed files selected by required jobs after excluding them from Ubuntu shards', () => {
    const swarm = readWorkflow('swarm-ci.yml');
    const unitRun = swarm.jobs?.unit?.steps?.find((step) => step.run?.includes('npx vitest run'))?.run ?? '';
    const gate = swarm.jobs?.['merge-queue-gate'];
    const gateRun = gate?.steps?.[0]?.run ?? '';
    for (const { file, job, reason } of platformRoutes) {
      expect(reason).not.toBe('');
      expect(unitRun, file).toContain(`--exclude '${file}'`);
      const platformRun = swarm.jobs?.[job]?.steps?.find((step) => step.run?.includes('npx vitest run'))?.run ?? '';
      expect(platformRun, file).toContain(file);
      expect(platformRun, file).not.toContain(`--exclude '${file}'`);
      expect(gate?.needs, file).toContain(job);
      expect(gateRun, file).toContain(`test "\${{ needs.${job}.result }}" = success`);
    }
    const linux = swarm.jobs?.['linux-sandbox'];
    expect(linux?.['runs-on']).toBe('ubuntu-22.04');
    expect(linux?.if).toBeUndefined();
    expect(linux?.steps?.some((step) => step.run?.includes('apt-get install -y bubblewrap'))).toBe(true);
  });

  it('covers every top-level test directory or records why it is excluded', () => {
    const directories = readdirSync(testsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && containsVitestFile(resolve(testsRoot, entry.name)))
      .map((entry) => entry.name)
      .sort();
    const uncovered = directories.filter((directory) => {
      if (intentionalExclusions[directory]) return false;
      const wholeDirectory = new RegExp(`(?<![\\w/-])tests/${directory}(?![\\w/-])`);
      return !preMergeRunCommands.some((run) => wholeDirectory.test(run));
    });

    expect(uncovered, `uncovered directories: ${uncovered.join(', ')}`).toEqual([]);
    expect(Object.keys(intentionalExclusions).sort()).toEqual(
      Object.keys(intentionalExclusions).filter((directory) => directories.includes(directory)).sort(),
    );
  });

  it('runs every Darwin-gated Vitest file on macOS and gates the merge queue on it', () => {
    const swarm = readWorkflow('swarm-ci.yml');
    const darwin = swarm.jobs?.darwin;
    expect(darwin?.if).toBe("github.event_name == 'merge_group'");
    expect(darwin?.['runs-on']).toBe('macos-latest');
    const run = darwin?.steps?.find((step) => step.run?.includes('npx vitest run'))?.run ?? '';
    const darwinGatedFiles = readdirSync(testsRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.test\.tsx?$/.test(entry.name))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter((file) => file !== import.meta.filename)
      .filter((file) => /(?:skipIf|runIf)\([^\n]*darwin|darwin[^\n]*(?:skipIf|runIf)/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(testsRoot.length + 1))
      .filter((file) => !file.startsWith('smoke/'));
    for (const file of darwinGatedFiles) expect(run, file).toContain(`tests/${file}`);

    expect(swarm.jobs?.['merge-queue-gate']?.needs).toContain('darwin');
    const gateRun = swarm.jobs?.['merge-queue-gate']?.steps?.[0]?.run ?? '';
    expect(gateRun).toContain('test "${{ needs.darwin.result }}" = success');
  });
});
