// --slot N 模式：附着到已安装、已启动的 Dev 槽（打包壳），不构建、不起停、不重启任何东西。
// 槽 N 在 8180+N 服务（scripts/run-dev-slot.sh），数据目录 ~/.code-agent-devN（scripts/lib/verificationAccount.ts
// 的 resolveDevVerificationDataDir 同一条规则），令牌在 <数据目录>/.dev-token（src/web/middleware/auth.ts 的
// resolveDevAuthTokenPath 同一条规则），库是 <数据目录>/code-agent.db。
// DB 快照照 neo-realrun dump（~/work/fleet-console/mini/bin/neo-realrun.mjs）同样的表与排序，
// 只读打开（better-sqlite3 readonly: true），写 db-N.json 进 --out。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DbSnapshot, ServerInfo } from './types';

/** 槽 N 的数据目录：槽 1 无后缀（与 resolveDevVerificationDataDir 同规则）。 */
export function slotDataDir(slot: number): string {
  return path.join(os.homedir(), slot === 1 ? '.code-agent-dev' : `.code-agent-dev${slot}`);
}

/** 槽 N 的 webServer 端口（run-dev-slot.sh：8180 + N）。 */
export const slotPort = (slot: number): number => 8180 + slot;

/** 槽 config.json 里配置的模型路由，provider/model 形式（与 neo-realrun state.model 同形）。 */
function slotModel(dataDir: string): string {
  try {
    const models = (JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as {
      models?: { routing?: { code?: { provider?: string; model?: string } }; default?: string; providers?: Record<string, { model?: string }> };
    }).models;
    const code = models?.routing?.code;
    if (code?.provider && code?.model) return `${code.provider}/${code.model}`;
    const provider = models?.default;
    const model = provider ? models?.providers?.[provider]?.model : undefined;
    return provider && model ? `${provider}/${model}` : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 附着到已启动的 Dev 槽：只读端口 / 数据目录 / 令牌 / 配置，起不出健康检查就报清楚怎么拉起槽。
 * 不做任何写操作——起服务、重启、杀进程都不是这里的事。
 */
export async function attachSlot(slot: number, out: string): Promise<ServerInfo> {
  const dataDir = slotDataDir(slot);
  const tokenFile = path.join(dataDir, '.dev-token');
  if (!fs.existsSync(tokenFile)) {
    throw new Error(`槽 ${slot} 没有令牌文件 ${tokenFile}：槽没装过或数据目录不对（先 bash scripts/run-dev-slot.sh ${slot} --open-only --background）`);
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const port = slotPort(slot);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
  }).then((r) => r.ok, () => false);
  if (!health) {
    throw new Error(`槽 ${slot} 没在 127.0.0.1:${port} 服务（/api/health 无响应）：先 bash scripts/run-dev-slot.sh ${slot} --open-only --background`);
  }
  console.log(`attached slot ${slot} port ${port} dataDir ${dataDir} model ${slotModel(dataDir)} out ${out}`);
  return {
    port, token, home: os.homedir(), dataDir,
    workspace: path.join(dataDir, 'workspace'), dir: out, model: slotModel(dataDir),
  };
}

function all(db: Database.Database, table: string, order: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table}${order ? ` ORDER BY ${order}` : ''}`).all() as Array<Record<string, unknown>>;
}

/**
 * 只读快照：<数据目录>/code-agent.db 以 readonly 打开，db-N.json（N = 槽号）写进 out。
 * 表与排序照 neo-realrun dump：sessions(created_at)、messages(timestamp,rowid)、
 * tool_execution_events(recorded_at,id)、pending_approvals / permission_decisions / cron_jobs / cron_executions（不排序）。
 */
export function dumpSlotDb(server: ServerInfo, slot: number, out: string): { file: string; data: DbSnapshot } {
  const dbPath = path.join(server.dataDir, 'code-agent.db');
  if (!fs.existsSync(dbPath)) throw new Error(`槽库不存在：${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let snap: DbSnapshot;
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    const has = (t: string) => tables.includes(t);
    snap = {
      sessions: has('sessions') ? all(db, 'sessions', 'created_at') : [],
      messages: has('messages') ? all(db, 'messages', 'timestamp, rowid') : [],
      toolEvents: has('tool_execution_events') ? all(db, 'tool_execution_events', 'recorded_at, id') : [],
      pendingApprovals: has('pending_approvals') ? all(db, 'pending_approvals', '') : [],
      permissionDecisions: has('permission_decisions') ? all(db, 'permission_decisions', '') : [],
      cronJobs: has('cron_jobs') ? all(db, 'cron_jobs', '') : [],
      cronExecutions: has('cron_executions') ? all(db, 'cron_executions', '') : [],
    };
  } finally {
    db.close();
  }
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `db-${slot}.json`);
  fs.writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
  return { file, data: snap };
}
