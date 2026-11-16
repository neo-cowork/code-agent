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
