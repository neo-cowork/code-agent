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
}

export interface AttemptEnv {
  page: Page;
  server: ServerInfo;
  /** 本次尝试内用到的会话 id（按出现顺序）。 */
  sessionIds: string[];
  /** 在 db-N.json 里按会话过滤时用。 */
  startedAtMs: number;
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
  steps: FlowStep[];
}
