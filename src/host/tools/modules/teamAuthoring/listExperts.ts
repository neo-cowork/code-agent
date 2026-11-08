import * as fs from 'fs/promises';
import * as path from 'path';
import type { CanUseToolFn, ToolContext, ToolHandler, ToolModule, ToolResult, ToolSchema } from '../../../protocol/tools';
import { getUserConfigDir } from '../../../config/configPaths';
import { isSafeRoleId } from '../../../services/roleAssets/roleAssetPaths';
import { isPersistentRole } from '../../../services/roleAssets/roleAssetService';
import { getTeamRecipeService, type KnownTeamRole } from '../../../services/team/teamRecipeService';
import { listExpertsSchema } from './listExperts.schema';

const schema: ToolSchema = listExpertsSchema;

/**
 * 花名后面补上「他是干什么的」。roleId 保持在行首且原样——模型要拿它填
 * propose_team_recipe 的 members.roleId，格式再怎么改都不能让它变得难辨认。
 */
function roleLabelSuffix(role: KnownTeamRole): string {
  const parts = [
    role.displayName && role.displayName !== role.roleId ? role.displayName : '',
    role.profession ?? '',
  ].filter(Boolean);
  return parts.length ? `（${parts.join(' · ')}）` : '';
}

function formatRoster(roles: KnownTeamRole[]): string {
  if (roles.length === 0) return '本机还没有可用专家，请先建一个角色。';
  return roles.map((role) => `${role.roleId}${roleLabelSuffix(role)} — ${role.description}`).join('\n');
}

function notFoundError(rawName: string): string {
  const safeDisplay = isSafeRoleId(rawName) ? ` "${rawName}"` : '';
  return `Expert${safeDisplay} not found in the current slot. Ask the user to confirm the role name (or call list_experts without name to inspect the roster).`;
}

async function readRoleDefinition(rawName: string): Promise<ToolResult<string>> {
  const roleId = rawName.trim();
  if (!isSafeRoleId(roleId) || !(await isPersistentRole(roleId))) {
    return {
      ok: false,
      error: notFoundError(roleId),
      code: 'NOT_FOUND',
    };
  }
  const definitionPath = path.join(getUserConfigDir(), 'agents', `${roleId}.md`);
  try {
    const content = await fs.readFile(definitionPath, 'utf-8');
    if (!content.trim()) {
      return {
        ok: false,
        error: notFoundError(roleId),
        code: 'NOT_FOUND',
      };
    }
    return {
      ok: true,
      output: content,
      meta: { roleId, definition: content },
    };
  } catch {
    return {
      ok: false,
      error: notFoundError(roleId),
      code: 'NOT_FOUND',
    };
  }
}

class ListExpertsHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
  ): Promise<ToolResult<string>> {
    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };

    const nameArg = typeof args.name === 'string' ? args.name.trim() : '';
    if (nameArg) {
      return readRoleDefinition(nameArg);
    }

    const roles = await getTeamRecipeService().knownRoles();
    return { ok: true, output: formatRoster(roles), meta: { roles } };
  }
}

export const listExpertsModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new ListExpertsHandler(),
};
