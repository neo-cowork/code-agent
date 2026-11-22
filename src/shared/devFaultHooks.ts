// Dev 包故障注入模块与宿主加载器之间的契约（仅类型）。

export interface FaultContext {
  dataDir: string;
  /** 宿主 logger 的 warn；每次注入命中恰好写一行，含注入名 */
  log: (line: string) => void;
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
}

