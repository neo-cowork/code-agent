import type { Page } from 'playwright';

export interface ServerInfo {
  port: number;
  token: string;
  home: string;
  dataDir: string;
  workspace: string;
  /** neo-realrun 的输出目录（state.json / server-N.log / db-N.json 都在这里）。 */
  dir: string;
  model: string;
}

export interface DbSnapshot {
  sessions: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  toolEvents: Array<Record<string, unknown>>;
  pendingApprovals: Array<Record<string, unknown>>;
  permissionDecisions: Array<Record<string, unknown>>;
  cronJobs: Array<Record<string, unknown>>;
  cronExecutions: Array<Record<string, unknown>>;
}

export interface AttemptEnv {
  page: Page;
  server: ServerInfo;
  /** 本次尝试内用到的会话 id（按出现顺序）。 */
  sessionIds: string[];
  /** 在 db-N.json 里按会话过滤时用。 */
  startedAtMs: number;
  /** run.ts 抓的本尝试事件流文件（/api/events 原始 SSE），核对回合终止 / 报错事件用。 */
  sseFile: string;
  /** 记下已知的模型分支原因，会写进 result.json 的 reason。 */
  note: (text: string) => void;
  /** 存一份新的数据库快照并解析；返回文件路径与内容。 */
  readDb: () => Promise<{ file: string; data: DbSnapshot }>;
  /** 步骤间传值。 */
  scratch: Record<string, unknown>;
}

export interface FlowStep {
  /** 与 docs/e2e/feature-map.md 流程卡 Steps 的句子一致；失败时原样打印。 */
  text: string;
  run: (env: AttemptEnv) => Promise<void>;
}

export interface FlowDef {
  id: string;
  title: string;
  /** 在 neo-realrun 起好的工作目录里放用户会交给 Neo 的文件。 */
  prepare?: (server: ServerInfo) => Promise<void>;
  /** 步骤跑完后（无论成败）执行的收尾：F17 靠它把界面语言恢复成 zh，失败也不能漏。 */
  cleanup?: (server: ServerInfo) => Promise<void>;
  /** 首启流程（F18）要用首启弹层：true 时 run.ts 不点掉首启弹层（默认照旧点掉）。 */
  requiresFirstRun?: boolean;
  steps: FlowStep[];
}
