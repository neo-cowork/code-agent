import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { realRun, type RunnerContext } from '../../../scripts/rsi-pilot/runner';

type ValidationResult = Awaited<ReturnType<RunnerContext['validateGameArtifact']>>;

async function runTimedOutUnit(options: {
  writeFile?: boolean;
  cancelThrows?: boolean;
  validation?: ValidationResult;
  validatorThrows?: boolean;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-timeout-artifact-'));
  const casesPath = path.join(root, 'cases.json');
  await fs.writeFile(casesPath, JSON.stringify({
    version: 1,
    note: '',
    cases: [{ id: 'x', subtype: 'runner', split: 'held_in', prompt: 'make x.html' }],
  }));
  const outDir = path.join(root, 'out');
  let sendStarted!: () => void;
  const sendStartedPromise = new Promise<void>((resolve) => { sendStarted = resolve; });

  class StubAdapter {
    workingDirectory: string;

    constructor(config: { workingDirectory: string }) {
      this.workingDirectory = config.workingDirectory;
    }

    async sendMessage() {
      if (options.writeFile !== false) {
        await fs.writeFile(path.join(this.workingDirectory, 'x.html'), '<html></html>');
      }
      sendStarted();
      return new Promise<never>(() => {});
    }

    async cancelActiveRun() {
      if (options.cancelThrows) throw new Error('cancel failed');
    }

    async finalizeSession() {}
    getSessionId() { return undefined; }
  }

  const validateGameArtifact = vi.fn(async () => {
    if (options.validatorThrows) throw new Error('validator failed');
    return options.validation ?? { passed: true, failures: [] };
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const runPromise = realRun({
    casesPath,
    split: 'all',
    reps: 1,
    provider: 'longcat',
    model: 'stub-model',
    label: 'timeout-artifact',
    outDir,
    ids: undefined,
    rep: undefined,
    limit: 1,
    timeoutMs: 100,
  }, {
    StandaloneAgentAdapter: StubAdapter as unknown as RunnerContext['StandaloneAgentAdapter'],
    validateGameArtifact,
    inferArtifactRepairIssueCodesFromText: (failure) => failure.includes('canvas') ? ['canvas_missing'] : ['runtime_failed'],
    getTelemetryCollector: () => ({ getSessionData: () => null }),
    gameValidationTimeouts: { RUNTIME_SMOKE_MS: 1, BROWSER_VISUAL_SMOKE_MS: 2, LIGHT_PLAYABILITY_SMOKE_MS: 3 },
    HARNESS_KNOB_DEFAULTS: {},
    ensureEvalDatabase: async () => {},
  });
  await sendStartedPromise;
  await vi.advanceTimersByTimeAsync(100);
  await runPromise;

  return {
    record: JSON.parse((await fs.readFile(path.join(outDir, 'runs.jsonl'), 'utf8')).trim()),
    summary: JSON.parse(await fs.readFile(path.join(outDir, 'summary.json'), 'utf8')),
    validateGameArtifact,
  };
}

describe('rsi pilot timeout artifact recovery', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('validates a file written before sendMessage times out', async () => {
    const { record, summary, validateGameArtifact } = await runTimedOutUnit();

    expect(record).toMatchObject({ timedOut: true, passedFull: true, failuresRaw: [], codes: [] });
    expect(record.artifactPath).toMatch(/x\.html$/);
    expect(record.error).toBe('per-run hard timeout after 100ms');
    expect(validateGameArtifact).toHaveBeenCalledWith(record.artifactPath, expect.objectContaining({ contractLevel: 'full' }));
    expect(summary.overall.passed).toBe(1);
    expect(summary.timeoutCount).toBe(1);
  });

  it('records validator failures and their classified codes after timeout', async () => {
    const { record, summary } = await runTimedOutUnit({
      validation: {
        passed: false,
        failures: ['canvas missing'],
        runtimeSmoke: { failures: ['runtime crashed'] },
      },
    });

    expect(record.passedFull).toBe(false);
    expect(record.failuresRaw).toEqual(['canvas missing', 'runtime crashed']);
    expect(record.codes).toEqual(['canvas_missing', 'runtime_failed']);
    expect(summary.failureCodeHistogram).toEqual({
      canvas_missing: { count: 1, distinctRuns: 1 },
      runtime_failed: { count: 1, distinctRuns: 1 },
    });
  });

  it('does not locate or validate while cancellation leaves the run in flight', async () => {
    const { record, validateGameArtifact } = await runTimedOutUnit({ cancelThrows: true });

    expect(record).toMatchObject({
      timedOut: true,
      abandonedInflight: true,
      artifactPath: null,
      passedFull: null,
      failuresRaw: [],
      codes: [],
    });
    expect(validateGameArtifact).not.toHaveBeenCalled();
  });

  it('keeps the previous null validation shape when no file was written', async () => {
    const { record, validateGameArtifact } = await runTimedOutUnit({ writeFile: false });

    expect(record).toMatchObject({
      timedOut: true,
      artifactPath: null,
      passedFull: null,
      failuresRaw: [],
      codes: [],
    });
    expect(validateGameArtifact).not.toHaveBeenCalled();
  });

  it('keeps the timeout record and located path when validation throws', async () => {
    const { record, validateGameArtifact } = await runTimedOutUnit({ validatorThrows: true });

    expect(record).toMatchObject({ timedOut: true, passedFull: null, failuresRaw: [], codes: [] });
    expect(record.artifactPath).toMatch(/x\.html$/);
    expect(record.error).toBe('per-run hard timeout after 100ms');
    expect(validateGameArtifact).toHaveBeenCalledOnce();
  });
});
