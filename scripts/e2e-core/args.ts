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
}

const DEFAULT_REALRUN_BIN = path.join(os.homedir(), 'work/fleet-console/mini/bin/neo-realrun.mjs');

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv, cwd: string): CoreArgs {
  const args: CoreArgs = {
    repeat: 3,
    out: path.resolve(cwd, 'test-results/e2e-core'),
    reuseBuild: false,
    headed: false,
    only: null,
    realrunBin: env.NEO_REALRUN_BIN?.trim() || DEFAULT_REALRUN_BIN,
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
    else throw new Error(`未知参数 ${a}`);
  }
  return args;
}
