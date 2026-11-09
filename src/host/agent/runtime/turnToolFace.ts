// ============================================================================
// Turn tool-face contract — one construction rule for required tools.
//
// Contract: tools named by the user this turn, tools declared by the role, and
// read tools needed by an unattended wake are never narrowed away; when
// narrowing is necessary the model gets reason + exit and never says
// "disabled by permission policy".
// ============================================================================

import type { ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../../agent/loopTypes';
import { CONNECTOR_TOOL_NAMES } from '../../../shared/contract/workbenchTools';
import { createLogger } from '../../services/infra/logger';
import { getConfigService } from '../../services/core/configService';
import { getConnectorRegistry } from '../../connectors/registry';
import { findConnectorIdForToolName } from '../../../shared/contract/workbenchTools';
import { isExternalSideEffectTool } from '../../tools/externalSideEffect';
import { isBashToolName } from '../../tools/toolNames';
import { resolveRoleToolBoundary } from '../../services/roleAssets/rolePersonalization';

const logger = createLogger('TurnToolFace');

const CONNECTOR_SOURCE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  calendar: ['calendar', '日历', '日程'],
  mail: ['mail', '邮件', '邮箱'],
  reminders: ['reminders', '提醒', '提醒事项', '待办'],
  photos: ['photos', '照片'],
};

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function appendUnique(target: string[], values: readonly string[] | undefined): void {
  if (!values) return;
  const seen = new Set(target.map(normalized));
  for (const value of values) {
    const name = value.trim();
    if (!name || seen.has(normalized(name))) continue;
    target.push(name);
    seen.add(normalized(name));
  }
}

/** Union a face with explicit per-turn required tools, preserving face order. */
export function mergeRequiredTurnToolNames(
  face: readonly string[] | undefined,
  required: readonly string[] | undefined,
): string[] | undefined {
  if (!face?.length && !required?.length) return face ? [...face] : undefined;
  const merged: string[] = [];
  appendUnique(merged, face);
  appendUnique(merged, required);
  return merged;
}

/** Role-chat construction: foreground face plus every declared role tool. */
export function buildRoleChatToolNames(
  foregroundToolNames: readonly string[] | undefined,
  declaredRoleTools: readonly string[] | undefined,
  roleId?: string,
): string[] | undefined {
  logUnusableDeclaredConnectorTools(declaredRoleTools);
  const merged = mergeRequiredTurnToolNames(foregroundToolNames, declaredRoleTools);
  const boundary = roleId && merged ? resolveRoleToolBoundary(roleId, merged) : null;
  return boundary ? boundary.allowedTools : merged;
}

function connectorIdForSourceName(sourceName: string): string | undefined {
  const value = normalized(sourceName);
  return Object.entries(CONNECTOR_SOURCE_ALIASES)
    .find(([, aliases]) => aliases.some((alias) => value === normalized(alias) || value.includes(normalized(alias))))?.[0];
}

function connectedSourceReadTools(
  sourceNames: readonly string[],
  definitions: readonly Pick<ToolDefinition, 'name' | 'permissionLevel'>[],
): string[] {
  const readDefinitions = definitions.filter((definition) => definition.permissionLevel === 'read');
  const names: string[] = [];
  for (const sourceName of sourceNames) {
    const connectorId = connectorIdForSourceName(sourceName);
    const sourcePrefix = `mcp__${normalized(sourceName)}__`;
    for (const definition of readDefinitions) {
      const definitionName = normalized(definition.name);
      const isNativeConnectorTool = connectorId
        ? (CONNECTOR_TOOL_NAMES[connectorId] ?? []).some((name) => normalized(name) === definitionName)
        : false;
      const isMcpSourceTool = definitionName.startsWith(sourcePrefix);
      if (isNativeConnectorTool || isMcpSourceTool) names.push(definition.name);
    }
  }
  return names;
}

/**
 * Wake construction: declared tools are the floor; connected-source read
 * tools are added for unattended inspection. Only declared tools can be write
 * tools. An empty undeclared/no-source role keeps the legacy open read face so
 * roles without a tool contract remain compatible.
 */
export function buildRoleWakeToolNames(input: {
  declaredRoleTools?: readonly string[];
  connectedSourceNames: readonly string[];
  definitions: readonly Pick<ToolDefinition, 'name' | 'permissionLevel'>[];
}): string[] | undefined {
  logUnusableDeclaredConnectorTools(input.declaredRoleTools);
  const declared = (input.declaredRoleTools ?? []).filter((name) => !isExternalSideEffectTool(name));
  const connectedReads = connectedSourceReadTools(input.connectedSourceNames, input.definitions);
  if (declared.length === 0 && connectedReads.length === 0) return undefined;
  return mergeRequiredTurnToolNames(undefined, [...declared, ...connectedReads]);
}

/** Resolve the connected-source read floor for an unattended role wake. */
export async function resolveRoleWakeRequiredToolNames(
  declaredRoleTools: readonly string[] | undefined,
  connectedSourceNames: readonly string[],
  definitions?: readonly Pick<ToolDefinition, 'name' | 'permissionLevel'>[],
): Promise<string[] | undefined> {
  if (connectedSourceNames.length === 0) {
    return buildRoleWakeToolNames({ declaredRoleTools, connectedSourceNames, definitions: [] });
  }
  if (definitions) return buildRoleWakeToolNames({ declaredRoleTools, connectedSourceNames, definitions });
  const { getAllToolDefinitions } = await import('../../tools/dispatch/toolDefinitions');
  return buildRoleWakeToolNames({
    declaredRoleTools,
    connectedSourceNames,
    definitions: getAllToolDefinitions(),
  });
}

/** Keep an observable reason when a declared native connector cannot be used. */
export function logUnusableDeclaredConnectorTools(declaredTools: readonly string[] | undefined): void {
  if (!declaredTools?.length) return;
  const connectorIds = new Set(
    declaredTools
      .map((name) => findConnectorIdForToolName(name))
      .filter((id): id is string => Boolean(id)),
  );
  for (const connectorId of connectorIds) {
    try {
      const enabled = getConfigService().getSettings().connectors?.enabledNative?.includes(connectorId) === true;
      const connector = getConnectorRegistry().get(connectorId);
      const readiness = connector?.getCachedStatus?.().readiness;
      const reason = !enabled
        ? 'not-enabled'
        : !connector
          ? 'not-registered'
          : readiness === 'failed' || readiness === 'unavailable'
            ? `readiness-${readiness}`
            : undefined;
      if (reason) {
        logger.warn('[TurnToolFace] Declared connector tool retained but connector is unusable', {
          connectorId,
          reason,
        });
      }
    } catch (error) {
      logger.warn('[TurnToolFace] Declared connector tool retained but readiness is unavailable', {
        connectorId,
        reason: 'config-unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function userNamedToolNames(prompt: string, removed: readonly string[]): string[] {
  const lower = prompt.toLowerCase();
  return removed.filter((toolName) => {
    const name = normalized(toolName);
    if (isBashToolName(toolName)) {
      return ['bash', 'shell', 'terminal', '命令行', '终端', '脚本执行'].some((word) => lower.includes(word));
    }
    if (['browser', 'browser_action', 'browser_navigate', 'computer_use'].includes(name)) {
      return ['browser', '浏览器', '网页', 'computer_use', 'browser_action'].some((word) => lower.includes(word));
    }
    return lower.includes(name);
  });
}

/** Short model-facing exit for a named tool removed by the foreground face. */
export function buildForegroundToolFaceNarrowingNotice(
  prompt: string,
  before: readonly { name: string }[],
  after: readonly { name: string }[],
): string | undefined {
  const kept = new Set(after.map((tool) => normalized(tool.name)));
  const removed = before.filter((tool) => !kept.has(normalized(tool.name))).map((tool) => tool.name);
  const named = userNamedToolNames(prompt, removed);
  if (named.length === 0) return undefined;
  const browser = named.some((name) => ['browser', 'browser_action', 'browser_navigate', 'computer_use'].includes(normalized(name)));
  if (browser) {
    return '<tool-face-narrowing>\nReason: the foreground face defers browser interaction to a background task. The user asked for browser work. Do not retry the removed browser tool. Exit: call delegate_task with the complete request and report that it is running in the background.\n</tool-face-narrowing>';
  }
  return '<tool-face-narrowing>\nReason: the foreground face defers shell commands to a background task. The user asked for a shell command. Do not retry the removed Bash tool. Exit: call delegate_task with the complete command and report that it is running in the background; the command has not run in this turn.\n</tool-face-narrowing>';
}

export function appendToolFaceNotice(
  messages: readonly ModelMessage[],
  notice: string | undefined,
): ModelMessage[] {
  if (!notice) return [...messages];
  return [
    ...messages,
    { role: 'system', content: notice, transient: true },
  ];
}

export function buildForegroundToolFaceNarrowingNoticeForRuntime(
  runtime: { turn: { runUserPrompt: string }; messages: readonly { role: string; content: string }[] },
  before: readonly { name: string }[],
  after: readonly { name: string }[],
): string | undefined {
  const prompt = runtime.turn.runUserPrompt || runtime.messages.filter((message) => message.role === 'user').at(-1)?.content || '';
  return buildForegroundToolFaceNarrowingNotice(prompt, before, after);
}

