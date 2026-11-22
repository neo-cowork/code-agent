// ============================================================================
// Dev 测试包专用故障注入（单文件，独立编译为 dist/web/dev-fault-inject.cjs）
// ----------------------------------------------------------------------------
// 只经 tauri.dev.conf.json 的 bundle resources 进入 Dev 包；生产包没有这个文件，
// webServer 的加载器（src/host/services/infra/devFaultLoader.ts）只在 Dev 槽数据目录 + 文件存在
// 时才 require 它。开关名与全部实现只存在于本文件，不得被 webServer bundle 引用。
// 自包含：只用 node 内置模块，不 import 宿主代码（独立 bundle 里的单例与宿主不是同一份）。
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DevFaultHooks, FaultContext } from '../shared/devFaultHooks';

const DEFAULT_BOOT_FAIL_COUNT = 3;
const DEFAULT_CONNECTOR_ID = 'mail';
// 只支持走 Apple Events 的连接器：它们的授权失败形状是同一种（-1743）。日历走 EventKit，
// 失败形状与卡片判据不同，包成这种形状会得到错的卡片，所以不在支持范围。
const APPLE_EVENTS_CONNECTORS: Record<string, string> = { mail: 'Mail', reminders: 'Reminders' };
const EXIT_ONCE_DELAY_MS = 4000;
const STATE_DIR = 'dev-fault';

function parseFaults(env: NodeJS.ProcessEnv = process.env): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const part of (env.NEO_DEV_FAULT ?? '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) out.set(trimmed, undefined);
    else out.set(trimmed.slice(0, idx), trimmed.slice(idx + 1) || undefined);
  }
  return out;
}

function stateFile(dataDir: string, name: string): string {
  return path.join(dataDir, STATE_DIR, name);
}

function readCount(file: string): number {
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeState(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function hit(ctx: FaultContext, name: string, detail?: string): void {
  ctx.log(`dev_fault_inject ${name}${detail ? ` ${detail}` : ''}`);
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function offlineError(url: string): Error {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* keep empty */ }
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: host });
}

function authInvalidError(label: string): Error {
  const text = `Not authorized to send Apple events to ${label}. (-1743)`;
  return Object.assign(new Error(text), { stderr: text });
}

const unsupportedLogged = new Set<string>();
let globalFetchPatched = false;

function patchGlobalFetch(ctx: FaultContext): void {
  if (globalFetchPatched) return;
  globalFetchPatched = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isLoopback(url)) {
      hit(ctx, 'offline', 'global_fetch');
      throw new TypeError('fetch failed', { cause: offlineError(url) });
    }
    return original(input, init);
  }) as typeof fetch;
}

export const devFaultHooks: DevFaultHooks = {
  atBoot(ctx) {
    const faults = parseFaults();
    if (faults.has('offline')) patchGlobalFetch(ctx);
    if (!faults.has('webserver_boot_fail')) return;
    // 与 webserver_exit_once 同列时，等它先触发（先「正常打开 → 挂一次」，之后重启才连败 N 次）
    if (faults.has('webserver_exit_once') && !fs.existsSync(stateFile(ctx.dataDir, 'exit_once.done'))) return;
    const limit = parseInt(faults.get('webserver_boot_fail') ?? '', 10) || DEFAULT_BOOT_FAIL_COUNT;
    const file = stateFile(ctx.dataDir, 'boot_fail.count');
    const count = readCount(file);
    if (count < limit) {
      writeState(file, String(count + 1));
      hit(ctx, 'webserver_boot_fail', `boot ${count + 1}/${limit} exiting`);
      process.exit(1);
    }
    writeState(file, '0');
  },

  afterListen(ctx) {
    const faults = parseFaults();
    if (!faults.has('webserver_exit_once')) return;
    const file = stateFile(ctx.dataDir, 'exit_once.done');
    if (fs.existsSync(file)) return;
    setTimeout(() => {
      writeState(file, String(Date.now()));
      hit(ctx, 'webserver_exit_once', 'exiting');
      process.exit(1);
    }, EXIT_ONCE_DELAY_MS).unref();
  },

  checkOutbound(url, ctx) {
    if (!parseFaults().has('offline') || isLoopback(url)) return;
    hit(ctx, 'offline', 'outbound_request');
    throw offlineError(url);
  },

  wrapConnector(connector, ctx) {
    const faults = parseFaults();
    if (!faults.has('connector_auth_invalid')) return connector;
    const targetId = faults.get('connector_auth_invalid') ?? DEFAULT_CONNECTOR_ID;
    if (targetId !== connector.id) return connector;
    const label = APPLE_EVENTS_CONNECTORS[connector.id];
    if (!label) {
      if (!unsupportedLogged.has(targetId)) {
        unsupportedLogged.add(targetId);
        hit(ctx, 'connector_auth_invalid', `unsupported:${targetId}`);
      }
      return connector;
    }
    const failedStatus = () => ({
      connected: false,
      readiness: 'failed',
      error: authInvalidError(label).message,
      errorCode: 'not_authorized',
      checkedAt: Date.now(),
      capabilities: connector.capabilities,
    });
    return new Proxy(connector, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return async () => {
            hit(ctx, 'connector_auth_invalid', connector.id);
            throw authInvalidError(label);
          };
        }
        if (prop === 'getStatus') {
          return async () => {
            hit(ctx, 'connector_auth_invalid', connector.id);
            return failedStatus();
          };
        }
        if (prop === 'getCachedStatus') return failedStatus;
        return Reflect.get(target, prop, receiver);
      },
    });
  },
};

