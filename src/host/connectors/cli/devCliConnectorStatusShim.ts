// ============================================================================
// devCliConnectorStatusShim —— 仅开发 API 下的 CLI 连接器状态替身
// ============================================================================
// 真跑验收要让飞书/腾讯会议探测报告「未登录」或「已连接」，又不能改用户本机登录。
// CODE_AGENT_ENABLE_DEV_API=true 时，若数据目录有 dev-cli-connector-status.json，
// 状态列举用文件里的结果代替该连接器的 CLI 探测。文件不存在或环境未开则完全不介入。
// 形状：{ "feishu": { "connected": false, "lostReason": "cli_not_logged_in" } }
// ============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { getUserConfigDir } from '../../config/configPaths';
import { createLogger } from '../../services/infra/logger';
import type { CliConnectorStatus } from './cliConnector';

const logger = createLogger('DevCliConnectorStatusShim');
const SHIM_FILE = 'dev-cli-connector-status.json';

function parseEntry(value: unknown): CliConnectorStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.connected !== 'boolean') return undefined;
  if (record.connected) return { connected: true, identity: 'none' };
  const lostReason = record.lostReason === 'cli_not_logged_in' || record.lostReason === 'cli_missing_configuration'
    ? record.lostReason
    : undefined;
  return { connected: false, identity: 'none', ...(lostReason ? { lostReason } : {}) };
}

/** 开发 API 打开且替身文件声明了该连接器时返回替身状态；否则 undefined（走真探测）。 */
export function readDevCliConnectorStatusShim(connectorId: string): CliConnectorStatus | undefined {
  if (process.env.CODE_AGENT_ENABLE_DEV_API !== 'true') return undefined;
  const filePath = path.join(getUserConfigDir(), SHIM_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    if (missing) return undefined;
    logger.warn('Dev CLI connector status shim ignored', {
      connectorId,
      reason: 'unreadable',
    });
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn('Dev CLI connector status shim ignored', { connectorId, reason: 'not-object' });
    return undefined;
  }
  const entry = parseEntry((parsed as Record<string, unknown>)[connectorId]);
  if (!entry) return undefined;
  logger.info('Dev CLI connector status shim applied', {
    connectorId,
    connected: entry.connected,
    ...(entry.lostReason ? { lostReason: entry.lostReason } : {}),
  });
  return entry;
}
