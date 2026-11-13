/**
 * One ordered tool-face resolver: tools the user names this turn, tools the role
 * declares, and read tools an unattended wake needs are never narrowed away;
 * the hard boundary is subtracted last and never widened. A declared role's
 * result is always a subset of its declaration. ADR-059 routes foreground
 * execution tools through delegate_task; it does not put Bash/browser on that face.
 */
import { getToolSearchService } from '../../services/toolSearch/toolSearchService';
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
  /** Additional hard admission predicate, applied after all required additions. */
  hardBoundary?: (name: string) => boolean;
}

export function resolveTurnToolFace(input: TurnToolFaceInput): string[] | undefined {
  const declared = input.declaredToolNames?.length ? input.declaredToolNames : undefined;
  // undefined means unrestricted, whereas [] at the run API historically means
  // unrestricted too. Preserve that distinction with the existing deny-all sentinel.
  if (!input.baseToolNames && !declared) return undefined;
  const canonical = (name: string) => resolveToolAlias(name).toLowerCase();
  const registered = [...getProtocolToolSchemas().map((schema) => schema.name),
    ...getToolSearchService().getMCPToolsMeta().map((meta) => meta.name)];
  const known = new Map(registered.map((name) => [canonical(name), name]));
  const declaredSet = declared ? new Set(declared.map(canonical)) : undefined;
  const foreground = input.foreground && !declared;
  const names = new Map<string, string>();
  const add = (name: string) => names.set(canonical(name), resolveToolAlias(name));
  for (const name of input.baseToolNames ?? []) add(name);
  for (const name of input.requiredToolNames ?? []) add(name);
  for (const name of declared ?? []) add(name);
  // Exact registry-name tokens, not ordinary verbs ('append') or intent keywords.
  // Only this turn's text counts; alias normalization still applies to declarations.
  const tokens = new Set((input.prompt ?? '').split(/[^a-zA-Z0-9_]+/u));
  for (const [key, name] of known) {
    if (!tokens.has(name)) continue;
    add(foreground && FOREGROUND_EXECUTION_TOOLS.has(key) ? 'delegate_task' : name);
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
      && (!foreground || !FOREGROUND_EXECUTION_TOOLS.has(key))
      && (!boundarySet || boundarySet.has(key))
      && (!input.wake || !isExternalSideEffectTool(name))
      && (!input.hardBoundary || input.hardBoundary(name));
  });
  if (declared) logger.info('Role tool face resolved (declared; hard boundary last)', {
    roleId: input.roleId, wake: input.wake === true, allowedTools: result,
  });
  return toRoleBoundaryRunAllowlist(result);
}
