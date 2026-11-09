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
import { DEFERRED_TOOLS_META } from '../../services/toolSearch/deferredToolsData';
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

export interface UnusableDeclaredConnector {
  connectorId: string;
  reason: string;
}

/** Declared native connectors that cannot serve a call right now, with a distinguishable reason. */
export function findUnusableDeclaredConnectors(declaredTools: readonly string[] | undefined): UnusableDeclaredConnector[] {
  if (!declaredTools?.length) return [];
  const connectorIds = new Set(
    declaredTools
      .map((name) => findConnectorIdForToolName(name))
      .filter((id): id is string => Boolean(id)),
  );
  const unusable: UnusableDeclaredConnector[] = [];
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
      if (reason) unusable.push({ connectorId, reason });
    } catch (error) {
      logger.warn('[TurnToolFace] Declared connector tool retained but readiness is unavailable', {
        connectorId,
        reason: 'config-unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return unusable;
}

/** Keep an observable reason when a declared native connector cannot be used. */
export function logUnusableDeclaredConnectorTools(declaredTools: readonly string[] | undefined): void {
  for (const { connectorId, reason } of findUnusableDeclaredConnectors(declaredTools)) {
    logger.warn('[TurnToolFace] Declared connector tool retained but connector is unusable', { connectorId, reason });
  }
}

const CONNECTOR_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  calendar: '日历',
  mail: '邮件',
  reminders: '提醒事项',
  photos: '照片',
};

/**
 * Model-facing line for declared/wake-required connectors the user must fix.
 * Only user-fixable states (not enabled / not authorised / not ready) are
 * surfaced, each with where to fix it; never framed as a capability fault.
 */
export function buildUnusableConnectorNotice(allowedToolNames: readonly string[] | undefined): string | undefined {
  const unusable = findUnusableDeclaredConnectors(allowedToolNames);
  if (unusable.length === 0) return undefined;
  const names = unusable.map(({ connectorId }) => CONNECTOR_DISPLAY_NAMES[connectorId] ?? connectorId).join('、');
  return `<connector-not-ready>\nThe user's ${names} connector is not connected or not authorised, so its tools cannot return data right now. If the task needs it, tell the user in one plain sentence to reconnect it under Settings > Connectors (设置 > 连接器), then continue with whatever else you can do. Do not call this a capability error, a bug or an "abnormal capability".\n</connector-not-ready>`;
}

const BROWSER_FACE_TOOLS = new Set(['browser', 'browser_action', 'browser_navigate', 'computer_use']);
const SHELL_PROMPT_WORDS = ['bash', 'shell', '终端', '命令行'];

/**
 * Words by which the user names browser work, taken from the tool registry
 * (tool name + the Chinese head of its short description) rather than a
 * private list. Bash is not a deferred tool and has no registry entry, so it
 * keeps the tool name plus the plain shell/terminal words.
 */
function browserPromptWords(): string[] {
  const meta = DEFERRED_TOOLS_META.find((entry) => normalized(entry.name) === 'browser');
  if (!meta) return [];
  const head = meta.shortDescription.split(/[（(]/)[0].replace(/自动化$/, '').trim();
  return [normalized(meta.name), head].filter(Boolean);
}

function exitToolName(after: readonly { name: string }[]): string | undefined {
  const names = new Set(after.map((tool) => normalized(tool.name)));
  return ['delegate_task', 'spawn_agent'].find((name) => names.has(name));
}

/**
 * Short model-facing reason + exit when the user names Bash or browser work
 * and the final foreground tool table has no such tool. Fires on absence, not
 * on removal: deferred browser tools are never in the pre-narrowing table.
 */
export function buildForegroundToolFaceNarrowingNotice(
  prompt: string,
  after: readonly { name: string }[],
): string | undefined {
  const exit = exitToolName(after);
  if (!exit) return undefined;
  const lower = prompt.toLowerCase();
  const present = after.map((tool) => tool.name);
  const namesBrowser = browserPromptWords().some((word) => lower.includes(word));
  if (namesBrowser && !present.some((name) => BROWSER_FACE_TOOLS.has(normalized(name)))) {
    return `<tool-face-narrowing>\nReason: the foreground face defers browser interaction to a background task. The user asked for browser work. Do not retry a browser tool. Exit, only if the user wants the browser operated now: call ${exit} with the complete request and tell the user in one plain sentence that it runs in the background browser and a task card will show the result. If the user is only asking how to do something, answer directly and do not delegate.\n</tool-face-narrowing>`;
  }
  const namesShell = SHELL_PROMPT_WORDS.some((word) => lower.includes(word));
  if (namesShell && !present.some((name) => isBashToolName(name))) {
    return `<tool-face-narrowing>\nReason: the foreground face defers shell commands to a background task. The user asked for a shell command. Do not retry Bash. Exit, only if the user wants a command run now: call ${exit} with the complete command and report that it is running in the background; the command has not run in this turn. If the user is only asking how to do something, answer directly and do not delegate.\n</tool-face-narrowing>`;
  }
  return undefined;
}

export function appendToolFaceNotice(
  messages: readonly ModelMessage[],
  notices: readonly (string | undefined)[],
): ModelMessage[] {
  const present = notices.filter((notice): notice is string => Boolean(notice));
  return [
    ...messages,
    ...present.map((notice) => ({ role: 'system' as const, content: notice, transient: true })),
  ];
}

export function buildTurnToolFaceNotices(
  runtime: {
    turn: { runUserPrompt: string };
    messages: readonly { role: string; content: string; toolCalls?: readonly { name: string }[] }[];
    allowedToolNames?: readonly string[];
  },
  after: readonly { name: string }[],
): string[] {
  const prompt = runtime.turn.runUserPrompt || runtime.messages.filter((message) => message.role === 'user').at(-1)?.content || '';
  const lastUser = runtime.messages.map((m) => m.role).lastIndexOf('user');
  const delegatedThisTurn = runtime.messages.slice(lastUser + 1).some((m) =>
    m.toolCalls?.some((call) => ['delegate_task', 'spawn_agent'].includes(normalized(call.name))));
  const narrowing = delegatedThisTurn ? undefined : buildForegroundToolFaceNarrowingNotice(prompt, after);
  const connector = buildUnusableConnectorNotice(runtime.allowedToolNames);
  if (narrowing) logger.info('[TurnToolFace] tool-face-narrowing note injected', { toolCount: after.length });
  if (connector) logger.info('[TurnToolFace] connector-not-ready note injected', { toolCount: after.length });
  return [narrowing, connector].filter((notice): notice is string => Boolean(notice));
}
