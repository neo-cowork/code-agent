// Dev 包故障注入模块与宿主加载器之间的契约（仅类型）。

export interface FaultContext {
  dataDir: string;
  /** 宿主 logger 的 warn；每次注入命中恰好写一行，含注入名 */
  log: (line: string) => void;
  /** 调用时刻的身份判断：补丁常驻进程，每次命中前复核当前数据目录仍是 Dev 槽 */
  active: () => boolean;
}

export interface ConnectorLike {
  id: string;
  capabilities: string[];
  getCachedStatus?: () => unknown;
  getStatus(): Promise<unknown>;
  execute(action: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface DevFaultHooks {
  /** main() 最早处：webserver_boot_fail 在此退出 */
  atBoot(ctx: FaultContext): void;
  /** server.listen 成功后：webserver_exit_once 在此排期退出 */
  afterListen(ctx: FaultContext): void;
  /** 出站请求闸口：offline 在此抛网络错误 */
  checkOutbound(url: string, ctx: FaultContext): void;
  /** 连接器注册表出口：connector_auth_invalid 在此改写目标连接器 */
  wrapConnector<T extends ConnectorLike>(connector: T, ctx: FaultContext): T;
  /** Override the authorization card's passive automation read for the affected connector. */
  isAutomationDenied?(connectorId: string, ctx: FaultContext): boolean;
  /** 当前登录用户读出口：注入可在此把读到的身份短时改写（如返回 null）。 */
  overrideCurrentUser?<T>(user: T | null, ctx: FaultContext): T | null;
}

