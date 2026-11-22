// ============================================================================
// Dev 包故障注入加载器：Dev 槽数据目录 + 模块文件存在才加载，否则恒为 no-op。
// 本文件不得出现开关名或注入名——生产 bundle 里要能 grep 到 0 处（见
// scripts/check-no-dev-fault-in-release.mjs）。
// ============================================================================

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { isDevSlotRuntime } from '../core/configServiceInternal';
import { createLogger } from './logger';
import type { ConnectorLike, DevFaultHooks, FaultContext } from '../../../shared/devFaultHooks';

const logger = createLogger('DevPackage');
const MODULE_FILE = 'dev-fault-inject.cjs';

let loaded: { hooks: DevFaultHooks | null; key: string } | undefined;

function candidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.argv[1]) dirs.push(path.dirname(process.argv[1]));
  dirs.push(path.join(process.cwd(), 'dist/web'));
  return dirs;
}

function load(): DevFaultHooks | null {
  const dataDir = process.env.CODE_AGENT_DATA_DIR;
  const key = dataDir ?? '';
  if (loaded?.key === key) return loaded.hooks;
  let hooks: DevFaultHooks | null = null;
  if (isDevSlotRuntime(dataDir)) {
    const file = candidateDirs().map((dir) => path.join(dir, MODULE_FILE)).find((candidate) => fs.existsSync(candidate));
    if (!file) {
      logger.warn('dev package module file not found; fault switches disabled', { searched: candidateDirs() });
    } else {
      try {
        hooks = (createRequire(file)(file) as { devFaultHooks: DevFaultHooks }).devFaultHooks;
      } catch (error) {
        logger.warn('dev package module failed to load', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  loaded = { hooks, key };
  return hooks;
}

function context(): FaultContext {
  return {
    dataDir: process.env.CODE_AGENT_DATA_DIR ?? '',
    log: (line) => logger.warn(line),
    active: () => isDevSlotRuntime(),
  };
}

export function devFaultAtBoot(): void {
  load()?.atBoot(context());
}

export function devFaultAfterListen(): void {
  load()?.afterListen(context());
}

export function devFaultCheckOutbound(url: string): void {
  load()?.checkOutbound(url, context());
}

export function devFaultWrapConnector<T extends ConnectorLike>(connector: T): T {
  const hooks = load();
  return hooks ? hooks.wrapConnector(connector, context()) : connector;
}
