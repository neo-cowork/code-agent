// ============================================================================
// en 档 agent 提示词（N-FIX-TITLE-LANG-FOLLOWS-UI-FU1 ①）
// ============================================================================
// 钉三件事：
//   1. 7 个模板的 en 提示词除「引用的 host 契约标签」外不含 CJK；
//   2. zh 输出与缺省档逐字节相同（en 只覆盖 name/description/agentPrompt）；
//   3. 契约字节原样保留：快照/告警标签、工具与字段名、host 注入的时间锚标签、
//      晨间分诊的四个契约行（Draft N (not sent) / Not read / Nothing needs attention /
//      save draft N）；group-listen 的提示词仍是用户输入。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { CRON_TEMPLATES, type CronTemplate } from '../../../src/renderer/components/features/cron/cronTemplates';

/** 有 en 提示词的 7 个模板（group-listen 不在内：提示词即用户输入） */
const EN_TEMPLATE_IDS = [
  'daily-lookahead',
  'daily-review',
  'weekly-review',
  'morning-triage',
  'web-change-watch',
  'feishu-calendar-conflict',
  'feishu-table-change',
] as const;

/** CJK 表意文字/假名/谚文（不含 CJK 标点：引号「」【】与间隔号 · 不算残留中文） */
const CJK_CHAR = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

/** host 注入的中文时间锚标签（cronAgentPrompt.ts 原文）：英文任务照抄，是合法残留 */
const QUOTED_HOST_LABELS = ['今天本地 00:00', '次日本地 00:00'];

function template(id: string): CronTemplate {
  const t = CRON_TEMPLATES.find((tpl) => tpl.id === id);
  if (!t) throw new Error(`template ${id} not found`);
  return t;
}

function stripQuotedHostLabels(text: string): string {
  let out = text;
  for (const label of QUOTED_HOST_LABELS) out = out.split(label).join('');
  return out;
}

/** 输出语言指令（真机实测不加会漂成中文回复）：每个 en 提示词统一带这句尾巴 */
const EN_OUTPUT_LANGUAGE_SUFFIX = ' Write your reply in English.';

describe('cron 模板 en 档 agent 提示词', () => {
  it('7 个模板 generate({}, "en") 的 agentPrompt 除引用的 host 契约标签外无 CJK', () => {
    for (const id of EN_TEMPLATE_IDS) {
      const prompt = template(id).generate({}, 'en').agentPrompt;
      expect(stripQuotedHostLabels(prompt), `template ${id}`).not.toMatch(CJK_CHAR);
    }
    // 晨间分诊绑角色（追加起草块）同样无 CJK
    const bound = template('morning-triage').generate({ roleId: 'assistant-lin' }, 'en').agentPrompt;
    expect(stripQuotedHostLabels(bound)).not.toMatch(CJK_CHAR);
  });

  it('每个 en 提示词尾部带显式输出语言指令（缺它真机会漂成中文回复）', () => {
    for (const id of EN_TEMPLATE_IDS) {
      expect(template(id).generate({}, 'en').agentPrompt, `template ${id}`).toContain(EN_OUTPUT_LANGUAGE_SUFFIX);
    }
    expect(template('morning-triage').generate({ roleId: 'assistant-lin' }, 'en').agentPrompt)
      .toContain(EN_OUTPUT_LANGUAGE_SUFFIX);
  });

  it('带用户输入的模板（url/日历/表格）en 提示词同样无 CJK，且用户输入进文', () => {
    const url = template('web-change-watch').generate({ url: 'https://example.com/changelog' }, 'en').agentPrompt;
    expect(url).toContain('https://example.com/changelog');
    expect(stripQuotedHostLabels(url)).not.toMatch(CJK_CHAR);

    const cal = template('feishu-calendar-conflict').generate({ calendarId: 'cal_9' }, 'en').agentPrompt;
    expect(cal).toContain('cal_9');
    expect(stripQuotedHostLabels(cal)).not.toMatch(CJK_CHAR);

    const table = template('feishu-table-change')
      .generate({ baseAppToken: 'basetkn', tableId: 'tbl01' }, 'en').agentPrompt;
    expect(table).toContain('basetkn');
    expect(table).toContain('tbl01');
    expect(stripQuotedHostLabels(table)).not.toMatch(CJK_CHAR);
  });

  it('en 提示词与 zh 不同（真的换了语言，不是复制原文）', () => {
    for (const id of EN_TEMPLATE_IDS) {
      const t = template(id);
      expect(t.generate({}, 'en').agentPrompt, `template ${id}`).not.toBe(t.generate({}, 'zh').agentPrompt);
    }
  });

  it('契约字节原样保留：快照/告警标签、工具与字段名、host 时间锚标签', () => {
    const cal = template('feishu-calendar-conflict').generate({ calendarId: 'cal_9' }, 'en').agentPrompt;
    expect(cal).toContain('<cron_snapshot>…</cron_snapshot>');
    expect(cal).toContain('<cron_alert>…</cron_alert>');
    expect(cal).toContain('start_time');
    expect(cal).toContain('end_time');
    // host 注入的时间锚标签（cronAgentPrompt.ts 的中文原文）必须照抄，不许翻译
    expect(cal).toContain('今天本地 00:00');
    expect(cal).toContain('次日本地 00:00');

    const table = template('feishu-table-change')
      .generate({ baseAppToken: 'basetkn', tableId: 'tbl01' }, 'en').agentPrompt;
    expect(table).toContain('appTableRecord.search');
    expect(table).toContain('app_token=basetkn');
    expect(table).toContain('table_id=tbl01');
    expect(table).toContain('record_id');
    expect(table).toContain('<cron_snapshot>…</cron_snapshot>');
    expect(table).toContain('<cron_alert>…</cron_alert>');
  });

  it('晨间分诊 en：四个契约行与邮件/日历工具名逐字保留；绑角色追加起草块', () => {
    const unbound = template('morning-triage').generate({}, 'en');
    expect(unbound.agentPrompt).toContain('Nothing needs attention this morning');
    expect(unbound.agentPrompt).toContain('Not read: <source>');
    expect(unbound.agentPrompt).not.toContain('Draft N (not sent)');

    const bound = template('morning-triage').generate({ roleId: 'assistant-lin' }, 'en');
    expect(bound.agentRoleId).toBe('assistant-lin');
    expect(bound.agentPrompt).toContain('"Draft N (not sent)"');
    expect(bound.agentPrompt).toContain('"save draft N"');
    expect(bound.agentPrompt).toContain('Nothing needs attention this morning');
    expect(bound.agentPrompt).toContain('Not read: <source>');
    expect(bound.agentPrompt).toContain('mail_send');
    expect(bound.agentPrompt).toContain('mail_draft');
    expect(bound.agentPrompt).toContain('calendar_create_event');
    expect(bound.agentPrompt).toContain('calendar_update_event');
    expect(bound.agentPrompt).toContain('calendar_delete_event');
    expect(bound.agentPrompt.startsWith(unbound.agentPrompt.replace(EN_OUTPUT_LANGUAGE_SUFFIX, ''))).toBe(true);
    // 除草稿块外其余字段与未绑定草稿一致（与中文版同构）
    const { agentPrompt: _p, agentRoleId: _r, ...boundRest } = bound;
    const { agentPrompt: _p2, agentRoleId: _r2, ...unboundRest } = unbound;
    expect(boundRest).toEqual(unboundRest);
  });

  it('group-listen：en 档提示词仍是用户输入的一句话任务，name/description 照 en 档规则', () => {
    const groupListen = template('group-listen');
    const en = groupListen.generate({ task: 'summarize release mentions' }, 'en');
    expect(en.agentPrompt).toBe('summarize release mentions');
    expect(en.name).toBe('Group listen');
    expect(en.description).toBe('Listen to group messages: summarize release mentions');
    expect(groupListen.generate({ task: '总结发布相关' }).agentPrompt).toBe('总结发布相关');
  });

  it('zh 档与缺省档逐字节相同；en 只改 name/description/agentPrompt，schedule 等字段不动', () => {
    for (const id of [...EN_TEMPLATE_IDS, 'group-listen']) {
      const t = template(id);
      expect(JSON.stringify(t.generate({}, 'zh'))).toBe(JSON.stringify(t.generate({})));
    }
    const zh = template('daily-review').generate({});
    const en = template('daily-review').generate({}, 'en');
    const { name: _n, description: _d, agentPrompt: _p, ...zhRest } = zh;
    const { name: _n2, description: _d2, agentPrompt: _p2, ...enRest } = en;
    expect(enRest).toEqual(zhRest);
  });
});
