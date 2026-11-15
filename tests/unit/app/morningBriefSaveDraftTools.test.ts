// ============================================================================
// 存草稿轮的无邮件角色撤单，经生产入口 resolveRoleChatToolFace 验证
//
// FB-726：无邮件角色回「存草稿 N」时，旧实现只撤 mail_draft——mail_send 漏撤弹出发送
// 审批卡，delegate_task/Bash 绕后台真发信。角色聊天两个入口（agentOrchestrator、
// web 路由）都只走 resolveRoleChatToolFace，这里就从它进；编排器级真实路径
// （真 getTextForegroundToolNamesForPrompt 组成）在 tests/agent/agentOrchestrator.test.ts
// 的 morning brief save-draft role mail tool gate。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { resolveRoleChatToolFace } from '../../../src/host/app/morningBriefSaveDraftTools';

const SAVE_DRAFT_PROMPT = '存草稿 1';
// 非存草稿轮（不命中 SAVE_DRAFT_REPLY_RE 的句首判据），同样命中邮件意图语境。
const OTHER_PROMPT = '帮我发邮件给 a@b.c，说明会议改期';
const NO_MAIL_REMOVE = ['mail', 'mail_send', 'mail_draft', 'delegate_task', 'Bash'] as const;
// 组成形状对齐真实轮：allowInTextForeground 基面（节选）+ 连接器意图扩展的 mail 三件套。
const FULL_LIST = [
  'Read', 'Write', 'Grep', 'AskUserQuestion', 'delegate_session',
  'mail', 'mail_send', 'mail_draft', 'delegate_task', 'Bash',
];
// 没开邮件（未声明 mail / mail_draft）的角色：声明里即使带着 mail_send、delegate_task、Bash，
// 存草稿轮也要撤掉——声明本身挡不住这三条发信旁路。
const NO_MAIL_ROLE_TOOLS = ['Read', 'Write', 'delegate_session', 'mail_send', 'delegate_task', 'Bash'];

describe('resolveRoleChatToolFace：存草稿轮的无邮件角色撤单', () => {
  it('存草稿轮 + 无邮件角色：mail 三件套、delegate_task、Bash 全部撤下，其余声明原样保留', () => {
    const result = resolveRoleChatToolFace(SAVE_DRAFT_PROMPT, [...FULL_LIST], NO_MAIL_ROLE_TOOLS);
    expect(result).toEqual(['Read', 'Write', 'delegate_session']);
    for (const absent of NO_MAIL_REMOVE) {
      expect(result).not.toContain(absent);
    }
  });

  it.each([['mail_draft'], ['mail']] as const)(
    '存草稿轮 + 角色声明 %s：声明的工具一个不撤（mail_send 不撤，角色真有邮件面）',
    (mailTool) => {
      const declared = [...NO_MAIL_ROLE_TOOLS, mailTool];
      const result = resolveRoleChatToolFace(SAVE_DRAFT_PROMPT, [...FULL_LIST], declared);
      expect([...(result ?? [])].sort()).toEqual([...declared].sort());
    },
  );

  it('存草稿轮 + 未解析到角色：名单原样返回', () => {
    expect(resolveRoleChatToolFace(SAVE_DRAFT_PROMPT, [...FULL_LIST], undefined))
      .toEqual(FULL_LIST);
    expect(resolveRoleChatToolFace(SAVE_DRAFT_PROMPT, [...FULL_LIST], []))
      .toEqual(FULL_LIST);
  });

  it('非存草稿 prompt（即使命中邮件语境）：无邮件角色的声明一个不撤', () => {
    const result = resolveRoleChatToolFace(OTHER_PROMPT, [...FULL_LIST], NO_MAIL_ROLE_TOOLS);
    expect([...(result ?? [])].sort()).toEqual([...NO_MAIL_ROLE_TOOLS].sort());
  });

  it('名单为 undefined 且未解析到角色：返回 undefined（no-op 不造空名单）', () => {
    expect(resolveRoleChatToolFace(SAVE_DRAFT_PROMPT, undefined, undefined))
      .toBeUndefined();
  });
});
