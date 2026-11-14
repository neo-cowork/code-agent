/**
 * One ordered tool-face resolver: tools the user names this turn, tools the role
 * declares, and read tools an unattended wake needs are never narrowed away;
 * the hard boundary is subtracted last and never widened.
 * - "Names" covers only the execution tools this resolver exists for: shell, browser
 *   and desktop control. On the command-center foreground they keep their exit,
 *   delegate_task (ADR-059), and never land on that face themselves. No other word
 *   in the prompt adds a tool: many registered names are ordinary words, and
 *   connector tools enter only through the connector-scoped intent path.
 * - A declared role's result is a subset of its declaration plus the turn's own
 *   additions (turnExtraToolNames), with the role boundary still subtracted last.
 */
import { resolveToolAlias } from '../../services/toolSearch/deferredTools';
import { resolveRoleToolBoundary, toRoleBoundaryRunAllowlist } from '../../services/roleAssets/rolePersonalization';
import { isExternalSideEffectTool } from '../../tools/externalSideEffect';
import { getProtocolToolSchemas } from '../../tools/protocolToolRegistration';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('TurnToolFace');
const FOREGROUND_EXECUTION_TOOLS = new Set(['bash', 'browser', 'computer_use']);

interface TurnToolFaceInput {
  baseToolNames?: readonly string[];
  prompt?: string;
  requiredToolNames?: readonly string[];
  declaredToolNames?: readonly string[];
  roleId?: string;
  foreground?: boolean;
  wake?: boolean;
  /** Turn-level additions admitted alongside a role's declarations; the boundary still applies. */
  turnExtraToolNames?: readonly string[];
  /** Additional hard admission predicate, applied after all required additions. */
  hardBoundary?: (name: string) => boolean;
}

export function resolveTurnToolFace(input: TurnToolFaceInput): string[] | undefined {
  const declared = input.declaredToolNames?.length ? input.declaredToolNames : undefined;
  // undefined means unrestricted, whereas [] at the run API historically means
  // unrestricted too. Preserve that distinction with the existing deny-all sentinel.
  if (!input.baseToolNames && !declared) return undefined;
  const canonical = (name: string) => resolveToolAlias(name).toLowerCase();
  const schemas = getProtocolToolSchemas();
  const executionTools = new Set(FOREGROUND_EXECUTION_TOOLS);
  for (const schema of schemas) {
    if (schema.category === 'vision' && schema.permissionLevel === 'execute') executionTools.add(canonical(schema.name));
  }
  const declaredSet = declared
    ? new Set([...declared, ...(input.turnExtraToolNames ?? [])].map(canonical)) : undefined;
  const foreground = input.foreground && !declared;
  const names = new Map<string, string>();
  const add = (name: string) => names.set(canonical(name), resolveToolAlias(name));
  for (const name of input.baseToolNames ?? []) add(name);
  for (const name of input.requiredToolNames ?? []) add(name);
  for (const name of declared ?? []) add(name);
  for (const name of input.turnExtraToolNames ?? []) add(name);
  // Only an execution tool named by its exact registry name counts, and only in this
  // turn's text. Every other registered name is ignored here on purpose.
  const tokens = new Set((input.prompt ?? '').split(/[^a-zA-Z0-9_]+/u));
  for (const { name } of schemas) {
    if (!tokens.has(name) || !executionTools.has(canonical(name))) continue;
    add(foreground ? 'delegate_task' : name);
  }
  if (input.wake) {
    for (const schema of getProtocolToolSchemas()) {
      if (schema.permissionLevel === 'read') add(schema.name);
    }
  }
  const boundary = input.roleId
    ? resolveRoleToolBoundary(input.roleId, [...names.values()]) : null;
  const boundarySet = boundary ? new Set(boundary.allowedTools.map(canonical)) : undefined;
  // Subtract LAST. Neither user naming, deferred preload nor a role declaration
  // can undo a role boundary, an unattended send restriction or caller admission.
  const result = [...names.values()].filter((name) => {
    const key = canonical(name);
    return (!declaredSet || declaredSet.has(key))
      && (!foreground || !executionTools.has(key))
      && (!boundarySet || boundarySet.has(key))
      && (!input.wake || !isExternalSideEffectTool(name))
      && (!input.hardBoundary || input.hardBoundary(name));
  });
  if (declared) logger.info('Role tool face resolved (declared; hard boundary last)', {
    roleId: input.roleId, wake: input.wake === true, allowedTools: result,
  });
  return toRoleBoundaryRunAllowlist(result);
}
