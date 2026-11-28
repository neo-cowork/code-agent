import path from 'node:path';
import os from 'node:os';

export interface CoreArgs {
  repeat: number;
  out: string;
  reuseBuild: boolean;
  headed: boolean;
  /** 只跑这些流程；缺省跑全部核心流程。 */
  only: string[] | null;
  realrunBin: string;
  /** --slot N：不构建不起服务，附着到已启动的 Dev 槽 N（端口 8180+N），只跑日历流程。null = 照旧自建隔离服务。 */
  slot: number | null;
}

const DEFAULT_REALRUN_BIN = path.join(os.homedir(), 'work/fleet-console/mini/bin/neo-realrun.mjs');

/** 槽 1 留给真机批，槽 4 保留：--slot 都不接。 */
const REFUSED_SLOTS: Record<number, string> = {
  1: '槽 1 留给真机批（real-device batches），--slot 不允许附着它',
  4: '槽 4 保留，--slot 不允许附着它',
};

/** --slot 的取值合法性：1-9 里的槽，其中 1 / 4 明确拒绝并说明原因。 */
export function parseSlot(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error(`--slot 需要 1-9 的整数，收到 ${raw}`);
  const refused = REFUSED_SLOTS[n];
  if (refused) throw new Error(refused);
  return n;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv, cwd: string): CoreArgs {
  const args: CoreArgs = {
    repeat: 3,
    out: path.resolve(cwd, 'test-results/e2e-core'),
    reuseBuild: false,
    headed: false,
    only: null,
    realrunBin: env.NEO_REALRUN_BIN?.trim() || DEFAULT_REALRUN_BIN,
    slot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺少取值`);
      return v;
    };
    if (a === '--repeat') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new Error('--repeat 需要正整数');
      args.repeat = n;
    } else if (a === '--out') args.out = path.resolve(cwd, value());
    else if (a === '--reuse-build') args.reuseBuild = true;
    else if (a === '--headed') args.headed = true;
    else if (a === '--only') args.only = value().split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--slot') args.slot = parseSlot(value());
    else throw new Error(`未知参数 ${a}`);
  }
  return args;
}
