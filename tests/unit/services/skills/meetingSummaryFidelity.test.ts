// FB-1267：会议纪要不得把未定事项写成带编造负责人/截止/动作的待办。
// static-contract：锁 meeting-summary skill prompt 的措辞；checker 单测用原会话的编造输出做反例。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  appendRemindersToMessage,
  createReminderContext,
  selectReminders,
} from '../../../../src/host/prompts/dynamicReminders';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkillsData';
import { checkMeetingMinutesFidelity } from '../../../fixtures/meeting-minutes-fidelity/checker';

const prompt = BUILTIN_SKILLS.find((s) => s.name === 'meeting-summary')?.promptContent ?? '';

describe('meeting-summary skill prompt: source fidelity', () => {
  it('不再要求每条待办必须含负责人和截止日期', () => {
    expect(prompt).not.toMatch(/每条 action item 必须含/);
    expect(prompt).not.toMatch(/截止日期（不能是/);
    expect(prompt).not.toMatch(/负责人（不能是/);
  });

  it('有待定标记、来源约束、已达成/讨论中分栏、收尾待定行', () => {
    expect(prompt).toContain('待定（来源未定）');
    expect(prompt).toContain('待指定');
    expect(prompt).toContain('只能来自来源原文');
    expect(prompt).toContain('已达成');
    expect(prompt).toContain('讨论中 / 未达成一致');
    expect(prompt).toContain('列出哪些字段因来源没写而留待定');
  });

  it('模板示例不带像真的人名和日期', () => {
    expect(prompt).not.toMatch(/20\d{2}-\d{2}-\d{2}(?!\s*HH)/);
    expect(prompt).not.toContain('@张三');
    expect(prompt).not.toContain('@李四');
    expect(prompt).not.toMatch(/YYYY-MM-DD HH/);
  });
});

const OPTS = { allowedDates: ['2026-11-18'] };
const INVENTED = `## 待办清单
| # | 事项 | 负责人 | 截止时间 |
|---|------|--------|----------|
| 1 | 首屏优化 | 小陈 | 2026-11-11（下周三）前 |
| 3 | 重新评估发票系统对接优先级，书面回复财务延期原因与新基线日期 | PM | 2026-11-11 前给出排期结论 |
| 4 | 新渠道投放数据整理成周报材料 | 运营 | 2026-11-11 周会前 |`;
const CLEAN = `## 待办清单
| # | 事项 | 负责人 | 截止时间 |
|---|------|--------|----------|
| 1 | 先解决首页 B 版首屏性能，再全量上 B 版 | 小陈 | 下周三（2026-11-18） |
| 2 | 压缩安装包 | 老王 | 下个迭代 |

## 讨论中 / 未达成一致
| # | 事项 | 说法 | 谁在跟 |
|---|---|---|---|
| D1 | 发票系统对接重排优先级 | PM 重新排 | PM |`;

describe('checkMeetingMinutesFidelity', () => {
  it('原会话的编造输出被逐项抓出', () => {
    const problems = checkMeetingMinutesFidelity(INVENTED, OPTS).join('\n');
    expect(problems).toContain('来源没有的日期：2026-11-11');
    expect(problems).toContain('发票事项截止时间应为待定');
    expect(problems).toContain('来源没有的动作');
    expect(problems).toContain('负责人不在来源里：运营');
  });

  it('忠实纪要通过', () => {
    expect(checkMeetingMinutesFidelity(CLEAN, OPTS)).toEqual([]);
  });
});

describe('原措辞触发会议纪要提醒（路由）', () => {
  const message = readFileSync('tests/fixtures/meeting-minutes-fidelity/user-message.txt', 'utf8');
  /** 复现生产注入路径：conversationRuntime 取 userMessage 的增量部分当 reminder */
  const inject = (text: string) => {
    const result = selectReminders(createReminderContext(text));
    return appendRemindersToMessage(text, result.reminders).substring(text.length);
  };

  it('FB-1267 原消息 → 注入会议纪要提醒，通用文档/数据提醒让位', () => {
    const injected = inject(message);
    expect(injected).toContain('"command": "meeting-summary"');
    expect(injected).toContain('保真底线');
    expect(injected).not.toContain('文档生成必须遵循的流程');
    expect(injected).not.toContain('先出初稿');
  });

  it('与会议纪要无关的消息不触发', () => {
    expect(inject('帮我写一份 Q3 营销季度报告')).not.toContain('meeting-summary');
  });
});
