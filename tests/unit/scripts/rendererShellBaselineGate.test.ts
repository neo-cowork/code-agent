import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';
import { evaluateShellBaselineGate } from '../../../scripts/build-renderer-bundle.mjs';
import {
  buildRendererReleaseRecord,
  formatRendererReleaseRecordMarkdown,
} from '../../../scripts/renderer-release-record.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

type WorkflowStep = {
  name?: string;
  if?: string;
  run?: string;
};

type WorkflowFile = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

function writeStubBaseline(baselineRoot: string, capabilityIds: string[]): void {
  const capabilitiesPath = path.join(baselineRoot, 'src/host/shellCapabilities.ts');
  fs.mkdirSync(path.dirname(capabilitiesPath), { recursive: true });
  fs.writeFileSync(
    capabilitiesPath,
    `export function getShellCapabilityIds(): string[] {\n  return ${JSON.stringify(capabilityIds)};\n}\n`,
    'utf8',
  );
}

describe('renderer shell baseline publish gate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-shell-baseline-gate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks publish when a new IPC action is required without raising minShellVersion', async () => {
    const baselineRoot = path.join(tmpDir, 'baseline-0330');
    const outputDir = path.join(tmpDir, 'out-blocked');
    const summaryPath = path.join(tmpDir, 'step-summary-blocked.md');
    const warnings: string[] = [];
    const baselineIds = ['domain:mcp/listTools', 'domain:update/check'];
    writeStubBaseline(baselineRoot, baselineIds);

    const gate = await evaluateShellBaselineGate({
      shellBaselineRoot: baselineRoot,
      minShellVersion: '0.33.0',
      requiredShellCapabilities: [...baselineIds, 'domain:roles/newAction'],
      outputDir,
      stepSummaryPath: summaryPath,
      onWarning: (line: string) => warnings.push(line),
    });

    expect(gate).toEqual({
      blocked: true,
      reason: 'missing-shell-capability',
      message: '已发布的 v0.33.0 壳缺少 1 项所需能力',
      minShellVersion: '0.33.0',
      baselineTag: 'v0.33.0',
      missingShellCapabilitiesCount: 1,
      missingShellCapabilities: ['domain:roles/newAction'],
    });
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'publish-gate.json'), 'utf8'))).toEqual(gate);
    expect(warnings).toEqual([
      '::warning title=renderer-hot-update-blocked::reason=missing-shell-capability missing=1 minShellVersion=0.33.0 first=domain:roles/newAction',
    ]);
    expect(fs.readFileSync(summaryPath, 'utf8').trim()).toBe(
      'Renderer hot-update publish blocked: missing-shell-capability, 1 shell capabilities missing in v0.33.0',
    );

    const record = buildRendererReleaseRecord({
      createdAt: '2026-11-27T00:00:00.000Z',
      manifest: {
        version: '0.33.0',
        minShellVersion: '0.33.0',
        contentHash: 'b'.repeat(64),
        bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
        requiredShellCapabilities: [...baselineIds, 'domain:roles/newAction'],
      },
      publishGate: gate,
    });
    expect(record.publishBlocked).toEqual({
      reason: 'missing-shell-capability',
      message: '已发布的 v0.33.0 壳缺少 1 项所需能力',
      minShellVersion: '0.33.0',
      baselineTag: 'v0.33.0',
      missingShellCapabilitiesCount: 1,
      missingShellCapabilities: ['domain:roles/newAction'],
    });
    const markdown = formatRendererReleaseRecordMarkdown(record);
    expect(markdown).toContain('## Publish Blocked');
    expect(markdown).toContain('Reason: missing-shell-capability');
    expect(markdown).toContain('- `domain:roles/newAction`');
  });

  it('allows publish when all required capabilities exist in the baseline shell and keeps release record unchanged', async () => {
    const baselineRoot = path.join(tmpDir, 'baseline-ok');
    const outputDir = path.join(tmpDir, 'out-ok');
    const summaryPath = path.join(tmpDir, 'step-summary-ok.md');
    const warnings: string[] = [];
    writeStubBaseline(baselineRoot, [
      'domain:mcp/listTools',
      'domain:update/check',
      'native:tauri/desktop_get_capabilities',
    ]);

    const gate = await evaluateShellBaselineGate({
      shellBaselineRoot: baselineRoot,
      minShellVersion: '0.33.0',
      requiredShellCapabilities: ['domain:update/check', 'domain:mcp/listTools'],
      outputDir,
      stepSummaryPath: summaryPath,
      onWarning: (line: string) => warnings.push(line),
    });

    expect(gate).toEqual({
      blocked: false,
      reason: null,
      message: null,
      minShellVersion: '0.33.0',
      baselineTag: 'v0.33.0',
      missingShellCapabilitiesCount: 0,
      missingShellCapabilities: [],
    });
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'publish-gate.json'), 'utf8'))).toEqual(gate);
    expect(warnings).toEqual([]);
    expect(fs.existsSync(summaryPath)).toBe(false);

    const manifest = {
      version: '0.33.0',
      minShellVersion: '0.33.0',
      contentHash: 'c'.repeat(64),
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check', 'domain:mcp/listTools'],
    };
    const recordWithGate = buildRendererReleaseRecord({
      createdAt: '2026-11-27T00:00:00.000Z',
      manifest,
      publishGate: gate,
    });
    const recordWithoutGate = buildRendererReleaseRecord({
      createdAt: '2026-11-27T00:00:00.000Z',
      manifest,
    });
    expect(recordWithGate).not.toHaveProperty('publishBlocked');
    expect(recordWithGate).toEqual(recordWithoutGate);
    expect(formatRendererReleaseRecordMarkdown(recordWithGate)).toBe(
      formatRendererReleaseRecordMarkdown(recordWithoutGate),
    );
    expect(formatRendererReleaseRecordMarkdown(recordWithGate)).not.toContain('## Publish Blocked');
  });

  it('blocks with baseline-tag-missing and exact message when baseline shellCapabilities.ts is absent', async () => {
    const missingBaselineRoot = path.join(tmpDir, 'does-not-exist');
    const outputDir = path.join(tmpDir, 'out-missing-tag');
    const summaryPath = path.join(tmpDir, 'step-summary-missing.md');
    const warnings: string[] = [];

    const gate = await evaluateShellBaselineGate({
      shellBaselineRoot: missingBaselineRoot,
      minShellVersion: '0.34.0',
      requiredShellCapabilities: ['domain:update/check'],
      outputDir,
      stepSummaryPath: summaryPath,
      onWarning: (line: string) => warnings.push(line),
    });

    expect(gate).toEqual({
      blocked: true,
      reason: 'baseline-tag-missing',
      message: '尚无已发布的 v0.34.0 壳',
      minShellVersion: '0.34.0',
      baselineTag: 'v0.34.0',
      missingShellCapabilitiesCount: null,
      missingShellCapabilities: [],
    });
    expect(warnings).toEqual([
      '::warning title=renderer-hot-update-blocked::reason=baseline-tag-missing missing=unknown minShellVersion=0.34.0 first=',
    ]);
    expect(fs.readFileSync(summaryPath, 'utf8').trim()).toBe(
      'Renderer hot-update publish blocked: baseline-tag-missing, 尚无已发布的 v0.34.0 壳',
    );
  });

  it('wires RENDERER_PUBLISH_BLOCKED into the four publish and post-publish workflow steps', () => {
    const workflowPath = path.join(repoRoot, '.github/workflows/renderer-bundle.yml');
    const workflow = loadYaml(fs.readFileSync(workflowPath, 'utf8')) as WorkflowFile;
    const steps = workflow.jobs?.['publish-renderer-bundle']?.steps ?? [];
    const stepByName = (name: string) => steps.find((step) => step.name === name);

    const buildStep = stepByName('Build + sign renderer bundle');
    expect(buildStep?.run).toContain('git fetch --no-tags --depth=1 origin "+refs/tags/v${MIN}:refs/tags/v${MIN}"');
    expect(buildStep?.run).toContain('--shell-baseline-root "$RUNNER_TEMP/shell-baseline"');
    expect(buildStep?.run).toContain('RENDERER_PUBLISH_BLOCKED=true');

    const releaseRecordStep = stepByName('Generate renderer release record');
    expect(releaseRecordStep?.run).toContain('--publish-gate-json dist/renderer-bundle/publish-gate.json');

    expect(stepByName('Verify production renderer rollout control plane')?.if).not.toContain(
      'RENDERER_PUBLISH_BLOCKED',
    );
    for (const name of [
      'Install ossutil (Aliyun OSS CLI)',
      'Upload renderer bundle to Aliyun OSS',
      'Verify published renderer bundle',
      'Verify production renderer hot-update surface',
    ]) {
      expect(stepByName(name)?.if).toContain("&& env.RENDERER_PUBLISH_BLOCKED != 'true'");
    }
  });
});
