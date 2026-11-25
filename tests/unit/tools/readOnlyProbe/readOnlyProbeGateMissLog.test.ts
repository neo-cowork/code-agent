// readonly_probe_plan_miss 必须带可区分的 cause（闸门变量名），降级路径不得无痕。
import { describe, expect, it, vi, beforeEach } from 'vitest';

const infoCalls = vi.hoisted(() => [] as Array<[string, Record<string, unknown>?]>);
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      return new Proxy(real, {
        get: (target, prop, receiver) => prop === 'info'
          ? (msg: string, meta?: Record<string, unknown>) => { infoCalls.push([msg, meta]); }
          : Reflect.get(target, prop, receiver),
      });
    },
  };
});

import { tryReadOnlyProbeBehindGates } from '../../../../src/host/tools/readOnlyProbeGate';

const input = { command: 'command -v ls; command -v node', workingDirectory: process.cwd() };

describe('readonly_probe_plan_miss cause', () => {
  beforeEach(() => { infoCalls.length = 0; });

  it('names the blocking gate variable', async () => {
    const result = await tryReadOnlyProbeBehindGates({ readOnlyForcesConfirmation: true, boundaryViolation: false }, input);
    expect(result).toBeNull();
    expect(infoCalls).toContainEqual(['readonly_probe_plan_miss', { cause: 'gate:readOnlyForcesConfirmation', gates: ['readOnlyForcesConfirmation'] }]);
  });

  it('stays quiet for commands the compiler cannot prove read-only', async () => {
    await tryReadOnlyProbeBehindGates({ readOnlyForcesConfirmation: true }, { ...input, command: 'rm -rf /tmp/x' });
    expect(infoCalls.filter(([m]) => m === 'readonly_probe_plan_miss')).toEqual([]);
  });

  it('runs the probe when every gate is false', async () => {
    const result = await tryReadOnlyProbeBehindGates({ readOnlyForcesConfirmation: false }, input);
    expect(result?.programs).toEqual(['command']);
  });
});
