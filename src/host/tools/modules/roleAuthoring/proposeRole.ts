// =====================================================================}

// propose_role — 对话式建角色：模型起草角色定义 → host 判定直接安装或弹确认卡
//
// 模型在"建角色"会话里访谈完用户后调用本工具。工具把定义落成草稿
// 用户自己的最新消息明确要求直接创建时，host 走与确认 IPC 共用的安装安全路径；
// 其余请求仍入队草稿并发射 role_draft_pending。
// 镜像 skillDraftQueue + skill_draft_pending 事件的范式（role-creation-flow §5）。
// =====================================================================}


import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { SkillCategory } from '../../../../shared/contract/skillRepository';
import type { Message, SessionOrigin } from '../../../../shared/contract';
import {
  enqueueRoleDraft,
  installRoleDraft,
  prepareRoleDraft,
  rejectRoleDraft,
} from '../../../services/roleAssets/roleDraftQueue';
import { buildRoleCreatedSummary } from '../../../services/roleAssets/roleCreatedSummary';
import { shouldCreateRoleDirectly } from '../../../services/roleAssets/roleCreationIntent';
import { diffRoleDefinition } from '../../../services/roleAssets/roleEditChange';
import { getAgentsMdDir } from '../../../config/configPaths';
import { parseAgentMd } from '../../../agent/hybrid/agentMdLoader';
import { getSessionManager } from '../../../services/infra/sessionManager';
import { getPermissionModeManager } from '../../../permissions/modes';
import { findUnknownToolNames, getKnownToolNames, hasProtocolToolRegistry } from '../../knownToolNames';
import { proposeRoleSchema } from './proposeRole.schema';

const schema: ToolSchema = proposeRoleSchema;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

function latestRealUserText(messages: readonly Message[]): string | null {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'user' && message.visibility !== 'rewound' && !message.isMeta)
    ?.content.trim() || null;
}

function isExternalOrigin(origin: SessionOrigin | undefined): boolean {
  return origin !== undefined && origin.kind !== 'manual' && origin.kind !== 'retry';
}

async function shouldInstallDirectly(ctx: ToolContext, editingRoleId: string | undefined): Promise<boolean> {
  if (editingRoleId || ctx.neoTag || getPermissionModeManager().isUnattendedSession(ctx.sessionId)) return false;
  try {
    const sessionManager = getSessionManager();
    const [messages, session] = await Promise.all([
      sessionManager.getMessages(ctx.sessionId),
      sessionManager.getSession(ctx.sessionId, 1),
    ]);
    if (isExternalOrigin(session?.origin)) return false;
    const latestUserText = latestRealUserText(messages);
    return latestUserText !== null && shouldCreateRoleDirectly(latestUserText);
  } catch (error) {
    ctx.logger.warn('propose_role direct-intent lookup failed; falling back to confirmation', {
      sessionId: ctx.sessionId,
      error: String(error),
    });
    return false;
  }
}

/**
 * 同名待确认草稿冲突：确认卡只在草稿所属会话里显示，所以失败文案要告诉模型草稿在哪。
 * 跨会话两种情形：另一会话仍在（点名）/ 所属会话已不存在（孤儿，不指路）。
 */
async function describeDraftRejection(
  ctx: ToolContext,
  result: { reason?: string; conflict?: { roleId: string; sessionId: string } },
): Promise<string> {
  const fallback = result.reason ?? 'Role draft enqueue failed';
  const conflict = result.conflict;
  if (!conflict || conflict.sessionId === ctx.sessionId) return fallback;

  let title: string | null = null;
  let found = false;
  try {
    const session = await getSessionManager().getSession(conflict.sessionId, 1);
    if (session) {
      found = true;
      title = session.title?.trim() || null;
    }
  } catch (error) {
    ctx.logger.warn('propose_role conflict-session lookup failed; using generic wording', {
      reason: 'session_lookup_error',
      error: String(error),
    });
    found = true; // 查询异常不等于会话已删：不下「孤儿」结论，用通用措辞指路
  }

  const name = conflict.roleId;
  if (!found) {
    ctx.logger.warn('propose_role same-name draft is orphaned', { reason: 'owner_session_missing', roleId: name });
    return (
      `已有一个待确认的「${name}」草稿，但它所属的对话已不存在，界面上已无法再确认它。` +
      `请如实告诉用户：之前那份「${name}」草稿已无法在界面中确认，请换一个名字，你会按新名字重新起草。` +
      `不要提确认卡，不要再用同一个名字重试。`
    );
  }
  const where = title ? `对话「${title}」` : '另一个对话';
  return (
    `已有一个待确认的「${name}」草稿，它在${where}里，尚未确认；当前这个对话里没有确认卡。` +
    `请如实告诉用户：同名专家「${name}」已在${where}起草过、还没确认，请回到那个对话确认或放弃它，或者告诉你一个新名字，你会重新起草。` +
    `不要说当前对话有确认卡或让用户在这里点确认，不要再用同一个名字重试。`
  );
}

/** 改已有角色时，把新草稿与当前定义的差异写成给模型看的清单；读不到当前定义要明说并留 warn。 */
async function buildChangeBlock(
  ctx: ToolContext,
  roleId: string,
  next: { description: string; tools: string[]; systemPrompt: string },
): Promise<string> {
  const header = '\n本次相对当前定义的改动：\n';
  try {
    const file = path.join(getAgentsMdDir().user, `${roleId}.md`);
    const previous = parseAgentMd(await fs.readFile(file, 'utf-8'), file);
    if (!previous) throw new Error('Invalid agent definition frontmatter');
    const change = diffRoleDefinition(
      { description: previous.description, tools: previous.tools, systemPrompt: previous.prompt },
      next,
    );
    const items: string[] = [];
    if (change.addedTools.length) items.push(`- 新增工具：${change.addedTools.join('、')}`);
    if (change.removedTools.length) items.push(`- 移除工具：${change.removedTools.join('、')}`);
    if (change.descriptionChanged) items.push('- 描述有改动');
    if (change.promptLinesAdded || change.promptLinesRemoved) {
      items.push(`- 系统提示词：新增 ${change.promptLinesAdded} 行、删除 ${change.promptLinesRemoved} 行`);
    }
    const body = items.length ? items.join('\n') : '- 与当前定义完全一致（没有任何改动）';
    return `${header}${body}\n` +
      '对照用户这次点名要改的内容：清单里凡是用户没提的改动，都要从草稿里去掉并重新调用本工具；回复用户时只如实说清单里的改动，不要多说也不要少说。\n';
  } catch (error) {
    ctx.logger.warn('propose_role could not read current definition for change list', {
      roleId,
      reason: String(error),
    });
    return `${header}- 读不到当前定义，无法核对改动范围；请如实告诉用户这一点，并只说你确实改了的部分。\n`;
  }
}

class ProposeRoleHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const roleId = typeof args.roleId === 'string' ? args.roleId.trim() : '';
    const systemPrompt = typeof args.systemPrompt === 'string' ? args.systemPrompt : '';
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    const category = typeof args.category === 'string' ? (args.category as SkillCategory) : undefined;
    const tools = toStringArray(args.tools);
    const userExpectation = typeof args.userExpectation === 'string' ? args.userExpectation.trim() : '';
    const editingRoleId =
      typeof args.editingRoleId === 'string' && args.editingRoleId.trim() ? args.editingRoleId.trim() : undefined;

    if (!roleId) {
      return { ok: false, error: 'roleId is required', code: 'INVALID_ARGS' };
    }
    if (!systemPrompt.trim()) {
      return { ok: false, error: 'systemPrompt is required', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    // 工具名必须真实存在：模型编造的名字不能落进 agents/*.md（此前只在启动期记 error，专家已建好）
    if (tools.length > 0) {
      if (hasProtocolToolRegistry()) {
        const unknown = findUnknownToolNames(tools, getKnownToolNames());
        if (unknown.length > 0) {
          ctx.logger.warn('propose_role rejected unknown tool names', { roleId, unknown: unknown.map((u) => u.name) });
          const lines = unknown.map((u) => {
            const near = u.suggestion ? [u.suggestion] : (u.nearest ?? []);
            return near.length ? `- ${u.name} (nearest real tools: ${near.join(', ')})` : `- ${u.name} (no similar real tool)`;
          },
          );
          return {
            ok: false,
            code: 'UNKNOWN_TOOLS',
            error:
              `These tool names do not exist, so no draft was created:\n${lines.join('\n')}\n` +
              'Fix the names using real tool names and call propose_role again. ' +
              'If no real tool provides the needed ability, tell the user in plain Chinese which ability is unavailable, ' +
              'and submit the draft without that tool.',
          };
        }
      } else {
        ctx.logger.warn('propose_role skipped tool-name validation: protocol tool registry not ready', { roleId });
      }
    }

    onProgress?.({ stage: 'starting', detail: `起草角色「${roleId}」` });

    const draftInput = {
      roleId,
      description,
      category,
      tools,
      systemPrompt,
      userExpectation,
      sessionId: ctx.sessionId,
      editingRoleId,
    };

    const direct = await shouldInstallDirectly(ctx, editingRoleId);
    if (direct) {
      const prepared = await prepareRoleDraft(draftInput);
      if (!prepared.draft || prepared.agentMd === undefined) {
        return { ok: false, error: await describeDraftRejection(ctx, prepared), code: 'DRAFT_REJECTED' };
      }
      const installed = await installRoleDraft(prepared.draft, prepared.agentMd);
      if (!installed.success) {
        return { ok: false, error: installed.error ?? 'Role installation failed', code: 'DRAFT_REJECTED' };
      }

      for (const id of prepared.supersededDraftIds ?? []) {
        const removed = await rejectRoleDraft(id);
        if (!removed.success) throw new Error(removed.error);
      }

      const summary = buildRoleCreatedSummary(prepared.draft);
      ctx.emit({
        type: 'role_created_direct',
        data: {
          sessionId: ctx.sessionId,
          roleId: prepared.draft.roleId,
          displayName: prepared.draft.roleId,
          canDo: summary.canDo,
          willNotDo: summary.willNotDo,
        },
      });
      ctx.logger.info('propose_role installed directly from explicit user intent', {
        roleId: prepared.draft.roleId,
      });
      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output:
          'The host already installed this role and queued its first wake. ' +
          'Do not announce that it was created, do not repeat its name, and do not add a confirmation message. ' +
          'End this role-authoring turn so the first-wake message can take over.',
        meta: {
          roleId: prepared.draft.roleId,
          sessionId: ctx.sessionId,
          displayName: prepared.draft.roleId,
          canDo: summary.canDo,
          willNotDo: summary.willNotDo,
          category: prepared.draft.category,
          tools: prepared.draft.tools,
          directCreated: true,
          endRunWithoutAssistant: true,
        },
      };
    }

    const enqueued = await enqueueRoleDraft(draftInput);
    const { draft } = enqueued;

    if (!draft) {
      // 入队被拒（重名/非法）——把原因回给模型，让它换名或调整后重试
      return { ok: false, error: await describeDraftRejection(ctx, enqueued), code: 'DRAFT_REJECTED' };
    }

    // 发射事件 → 聊天渲染确认卡（RoleDraftNotifications 订阅 role_draft_pending）
    ctx.emit({
      type: 'role_draft_pending',
      data: {
        sessionId: ctx.sessionId,
        drafts: [
          {
            id: draft.id,
            roleId: draft.roleId,
            description: draft.description,
            category: draft.category,
            tools: draft.tools,
            editingRoleId: draft.editingRoleId,
          },
        ],
      },
    });

    ctx.logger.info('propose_role drafted', { roleId: draft.roleId, draftId: draft.id });
    onProgress?.({ stage: 'completing', percent: 100 });

    const toolsLine = tools.length > 0 ? tools.join(', ') : '（默认全集）';
    const verb = editingRoleId ? '修改' : '创建';
    const changeBlock = editingRoleId
      ? await buildChangeBlock(ctx, draft.roleId, { description: draft.description, tools: draft.tools, systemPrompt })
      : '';
    return {
      ok: true,
      output:
        `已为「${draft.roleId}」生成${editingRoleId ? '修改' : ''}草稿，确认卡已弹出，等待用户点击确认。\n` +
        `- 描述：${draft.description || '（无）'}\n` +
        `- 工具：${toolsLine}\n` +
        changeBlock +
        `请告诉用户：可以直接确认${verb}，或继续提出修改（你会重新起草）。在用户确认前不要重复调用本工具，除非用户要求改动。`,
      meta: {
        draftId: draft.id,
        roleId: draft.roleId,
        category: draft.category,
        tools: draft.tools,
        editingRoleId: draft.editingRoleId,
      },
    };
  }
}

export const proposeRoleModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ProposeRoleHandler();
  },
};
