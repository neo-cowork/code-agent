// ============================================================================
// 个人聊天来源规则的双语档（N-FIX-TITLE-LANG-FOLLOWS-UI-FU1 rework r2）
// ============================================================================
// 钉三件事：
//   1. en 任务（英文提示词）拿英文规则行，且其中的选项/页面名与 en i18n 真实词条一致
//      （cronPersonalSkills.en.label / cronEditorChrome en tabs.action）；
//   2. zh 任务的规则行与存量字节逐字相同（不得因重构漂移）；
//   3. 提示词判不出语言时跟 UI 语言。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

const uiState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/host/session/sessionTitleHostPrompt', () => ({
  readUiLanguage: () => uiState.language,
}));

import { buildCronAgentPrompt } from '../../../src/host/cron/cronAgentPrompt';

/** 存量 zh 规则行（改动前的原文，字节钉） */
const ZH_RULE =
  '若任务涉及微信/IM 等个人聊天来源，不要搜索或调用读取个人聊天记录的工具、技能或命令行，直接在产出中单独写一行「未读取：微信/IM（定时任务默认不读个人聊天记录；想读，请在任务编辑的「执行动作」页勾选「允许本任务使用这些个人技能」）」。请逐字保留引号内的整行文字，不得改写页面或选项名称。';

const EN_PROMPT = 'Please give me a morning triage of my unread email, instant messages, and calendar changes since last night.';
const ZH_PROMPT = '请汇总我从昨晚到现在的未读邮件、即时消息和日历变动，给我一份晨间分诊。';

describe('cronAgentPrompt 个人聊天来源规则语言档', () => {
  it('zh 任务：规则行与存量字节逐字相同', () => {
    const built = buildCronAgentPrompt(ZH_PROMPT, undefined, false);
    expect(built).toContain(ZH_RULE);
  });

  it('en 任务：规则行是英文，选项/页面名与 en i18n 词条一致，无中文行', () => {
    uiState.language = 'zh'; // UI 是中文也不跟：语言跟任务提示词
    const built = buildCronAgentPrompt(EN_PROMPT, undefined, false);
    expect(built).not.toContain('未读取：微信/IM');
    expect(built).toContain('Not read: WeChat/IM (scheduled jobs don\'t read personal chats by default');
    // en i18n 真实词条（cronPersonalSkills.en.label / cronEditorChrome en tabs.action）
    expect(built).toContain('"Allow this task to use these personal skills" on the "Action" page of the task editor');
    expect(built).toContain('Keep that quoted line verbatim');
    uiState.language = 'zh';
  });

  it('提示词判不出语言（纯数字）时跟 UI 语言', () => {
    uiState.language = 'en';
    expect(buildCronAgentPrompt('12345', undefined, false)).toContain('Not read: WeChat/IM');
    uiState.language = 'zh';
    expect(buildCronAgentPrompt('12345', undefined, false)).toContain(ZH_RULE);
  });

  it('已允许个人技能的任务不出现该规则行（两语都不出现）', () => {
    // 第 8 参才是 allowedPersonalSkillIds（第 7 参是 timeZone）
    expect(buildCronAgentPrompt(ZH_PROMPT, undefined, false, undefined, undefined, undefined, undefined, ['wechat-reader']))
      .not.toContain('未读取：微信/IM');
    expect(buildCronAgentPrompt(EN_PROMPT, undefined, false, undefined, undefined, undefined, undefined, ['wechat-reader']))
      .not.toContain('Not read: WeChat/IM');
  });
});
