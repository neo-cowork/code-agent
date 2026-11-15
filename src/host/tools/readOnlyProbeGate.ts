// ============================================================================
// ReadOnlyProbe 闸门：把 toolExecutor 里「哪些强制确认信号为真就不跑探测」收成一处，
// 并在被某个信号挡下时留痕（降级路径必须可诊断：是哪一个变量挡的）。
//
// 拓扑 ask（async_agent 的 Bash 默认 ask，2026-07-13 拍板）不算强制确认信号：
// 它防的是后台任意命令，而探测计划已由编译器证明只读、在进程内执行。
// 用户 ask 规则不受影响——tryReadOnlyProbe 内部仍对整条命令与每个片段复核。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { matchEffectiveExecPolicy } from '../permissions/runPolicySnapshot';
import { compileReadOnlyProbePlan } from '../security/readOnlyProbePlan';
import { tryReadOnlyProbe, type ReadOnlyProbeInput } from './readOnlyProbeHook';
import * as os from 'os';

const logger = createLogger('ToolExecutor');

export type ReadOnlyProbeGates = Record<string, boolean>;

/** 任一闸门为真 → 不执行探测，并以闸门变量名为 cause 记 miss；全假才进入 tryReadOnlyProbe。 */
export async function tryReadOnlyProbeBehindGates(
  gates: ReadOnlyProbeGates,
  input: ReadOnlyProbeInput,
  detail?: Record<string, unknown>,
): Promise<{ output: string; programs: string[] } | null> {
  const blocking = Object.keys(gates).filter((name) => gates[name]);
  try {
    if (matchEffectiveExecPolicy(input.command, input.sessionId) === 'forbidden') blocking.push('execPolicyForbidden');
  } catch {
    // exec policy 未初始化：与主链一致，视为无规则
  }
  if (blocking.length === 0) return tryReadOnlyProbe(input);
  logProbeMiss(blocking, input, detail);
  return null;
}

/**
 * 探测根本没被尝试（外层 P0 块被跳过 / 命令已被 safe-command 短路）时的留痕：
 * 只记「某个强制确认信号为真」的情形，不改任何决策。
 */
export function noteReadOnlyProbeSkipped(
  gates: ReadOnlyProbeGates,
  input: ReadOnlyProbeInput,
  detail?: Record<string, unknown>,
): void {
  const blocking = Object.keys(gates).filter((name) => gates[name]);
  if (blocking.length > 0) logProbeMiss(blocking, input, detail);
}

function logProbeMiss(blocking: string[], input: ReadOnlyProbeInput, detail?: Record<string, unknown>): void {
  // 只在命令本可被证明只读、却被闸门挡下时记 info；不可编译的命令走审批是常态，不刷屏。
  if (compileReadOnlyProbePlan(input.command, { homeDir: os.homedir(), platform: process.platform })) {
    logger.info('readonly_probe_plan_miss', { cause: `gate:${blocking[0]}`, gates: blocking, ...detail });
  }
}
