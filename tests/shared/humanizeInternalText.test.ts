import { presentReplyBody } from '../../src/shared/replyBodyPresentation';
import { ROLE_PROACTIVITY } from '../../src/shared/constants/memory';
import { describe, expect, it } from 'vitest';
import { humanizeInternalText } from '../../src/shared/humanizeInternalText';
import { detectInternalTextLeaks, type InternalTextFormat } from '../../src/shared/internalTextLeakDetect';

describe('humanizeInternalText', () => {
  const formatCases: Array<{
    format: InternalTextFormat;
    raw: string;
    expectedZhSubstring: string;
    expectedEnSubstring: string;
    expectCollapse: boolean;
  }> = [
    {
      format: 'uuid',
      raw: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      expectedZhSubstring: '内部记录',
      expectedEnSubstring: 'Internal record',
      expectCollapse: true,
    },
    {
      format: 'session_id',
      raw: 'session_1762451092123_abcd12',
      expectedZhSubstring: '当前会话',
      expectedEnSubstring: 'Current session',
      expectCollapse: true,
    },
    {
      format: 'call_id',
      raw: 'toolu_01A2B3C4D5E6F7G8H9',
      expectedZhSubstring: '工具操作',
      expectedEnSubstring: 'Tool operation',
      expectCollapse: true,
    },
    {
      format: 'ou_id',
      raw: 'ou_98a7b6c5d4e3f2a1',
      expectedZhSubstring: '外部联系人',
      expectedEnSubstring: 'External contact',
      expectCollapse: true,
    },
    {
      format: 'internal_tool_name',
      raw: '正在使用 memory_search 配合 mcp__feishu__send_message 和 AskUserQuestion',
      expectedZhSubstring: '检索记忆',
      expectedEnSubstring: 'Search memory',
      expectCollapse: false,
    },
    {
      format: 'english_state_word',
      raw: 'accepted：任务已入队 · [running] id=bg_42 · interrupted: process crashed · tool call was cancelled · result was recorded · mail message · account work · mailbox INBOX · no outbound action attempted · run result carried no eventDecisions',
      expectedZhSubstring: '已接收：',
      expectedEnSubstring: 'Received: ',
      expectCollapse: false,
    },
    {
      format: 'sandbox_exec',
      raw: 'Command failed: sandbox-exec -f /tmp/seatbelt-profile.sb sh -c "echo hi"',
      expectedZhSubstring: '系统安全沙箱',
      expectedEnSubstring: 'macOS system sandbox',
      expectCollapse: true,
    },
    {
      format: 'temp_path',
      raw: 'Output written to /private/tmp/neo-run-98123/report.pdf and /var/folders/xx/abc1234567890/T/scratch',
      expectedZhSubstring: '临时文件（report.pdf）',
      expectedEnSubstring: 'temporary file (report.pdf)',
      expectCollapse: true,
    },
    {
      format: 'raw_json',
      raw: '{"status":"failed","code":"E_TIMEOUT","retryable":false}',
      expectedZhSubstring: '结构化技术详情已折叠',
      expectedEnSubstring: 'Structured details collapsed',
      expectCollapse: true,
    },
  ];

  it.each(formatCases)(
    'detects and humanizes format "$format" in both zh and en without leaving raw leak tokens',
    ({ format, raw, expectedZhSubstring, expectedEnSubstring, expectCollapse }) => {
      const leaks = detectInternalTextLeaks(raw);
      expect(leaks.map((l) => l.format)).toContain(format);

      const zhResult = humanizeInternalText(raw, 'zh');
      expect(zhResult.detectedFormats).toContain(format);
      expect(zhResult.text).toContain(expectedZhSubstring);
      expect(detectInternalTextLeaks(zhResult.text)).toEqual([]);

      const enResult = humanizeInternalText(raw, 'en');
      expect(enResult.detectedFormats).toContain(format);
      expect(enResult.text).toContain(expectedEnSubstring);
      expect(detectInternalTextLeaks(enResult.text)).toEqual([]);

      if (expectCollapse) {
        expect(zhResult.collapseIntoDetails).toEqual({
          action: 'collapse_into_details',
          label: '技术详情',
          details: raw.trim(),
        });
      } else {
        expect(zhResult.collapseIntoDetails).toBeUndefined();
      }
    },
  );

  it('recognizes additional variants across the 9 formats (session-work-*, call_*, oc_*, etc.)', () => {
    expect(detectInternalTextLeaks('session-work-20261107-alpha')[0]?.format).toBe('session_id');
    expect(detectInternalTextLeaks('call_abc123xyz789')[0]?.format).toBe('call_id');
    expect(detectInternalTextLeaks('oc_feishu_chat_998877')[0]?.format).toBe('ou_id');
    expect(detectInternalTextLeaks('/tmp/playwright-trace-123.zip')[0]?.format).toBe('temp_path');
    expect(detectInternalTextLeaks('read_file')[0]?.format).toBe('internal_tool_name');
    expect(detectInternalTextLeaks('NotebookEdit')[0]?.format).toBe('internal_tool_name');

    expect(detectInternalTextLeaks(humanizeInternalText('session-work-20261107-alpha', 'zh').text)).toEqual([]);
    expect(detectInternalTextLeaks(humanizeInternalText('call_abc123xyz789', 'zh').text)).toEqual([]);
    expect(detectInternalTextLeaks(humanizeInternalText('oc_feishu_chat_998877', 'zh').text)).toEqual([]);
  });

  it('passes ordinary Chinese and English prose through unchanged with zero false positives', () => {
    const proseSamples = [
      '已整理好本周的周报草稿，包含 3 个重点项目的交付进度与下周计划。',
      '定时任务将在每天早上 09:00 自动检查收件箱并汇总重要邮件。',
      'All 12 slides have been exported to your workspace folder.',
      'Please review the generated table and let me know if any column needs adjustment.',
      '正在读取项目文档并生成对比摘要',
      '任务已完成，共处理 8 封邮件（无需额外操作）。',
    ];

    for (const sample of proseSamples) {
      expect(detectInternalTextLeaks(sample)).toEqual([]);
      const zh = humanizeInternalText(sample, 'zh');
      expect(zh.text).toBe(sample);
      expect(zh.detectedFormats).toEqual([]);
      expect(zh.collapseIntoDetails).toBeUndefined();
    }
  });
});

describe('reply body display projection', () => {
  it.each(['zh', 'en'] as const)('separates role tags and deduplicates reasons in %s', (lang) => {
    const raw = 'Your report is ready.\n<decision>report</decision><rationale>Review the report</rationale><evidence>notes.md</evidence>';
    const projected = presentReplyBody(raw, lang);
    expect(projected.text).toBe('Your report is ready.');
    expect(projected.rationale).toBe('Review the report');
    expect(projected.evidence).toBe('notes.md');
    expect(projected.technicalDetails).toContain('<decision>report</decision>');
    expect(ROLE_PROACTIVITY.DECISION_TAG_PATTERN.exec(raw)?.[1]).toBe('report');
    expect(raw).toContain('<rationale>Review the report</rationale>');
  });

  it('hides scheduled event attributes and shows each reason only once', () => {
    const tag = '<cron_event_decision id="om_event123" action="ignore" rule="mail">No reply needed</cron_event_decision>';
    const raw = `Mailbox checked.\n${tag}\n${tag}`;
    const projected = presentReplyBody(raw, 'en');
    expect(projected.text).toBe('Mailbox checked.');
    expect(projected.rationale).toBe('No reply needed');
    expect(projected.technicalDetails).toBe(`${tag}\n${tag}`);
  });

  it('humanizes reason text, hides incomplete streaming tags and preserves ordinary content', () => {
    expect(presentReplyBody('<rationale>read_file call_export123</rationale>', 'en').rationale).toBe('Read file tool operation');
    for (const suffix of ['<decision>rep', '<rationale>Wait', '<cron_event_decision id="om_one"', '<cron_event_dec', '<rat']) {
      expect(presentReplyBody(`Report ready.\n${suffix}`).text).toBe('Report ready.');
    }
    for (const text of ['Report <strong>ready</strong>.', 'a < b', 'A decision about the report', 'Use <custom>tags</custom>.']) {
      expect(presentReplyBody(text).text).toBe(text);
    }
  });
});


describe('background status and sandbox command exits', () => {
  it('localizes the stored background-empty state without changing normal Chinese copy', () => {
    const raw = '当前会话还没有后台任务。';
    expect(humanizeInternalText(raw, 'en').text).toBe('There are no background tasks in this conversation.');
    expect(humanizeInternalText(raw, 'zh').text).toBe(raw);
  });
  it('keeps a sandbox command entirely behind details', () => {
    const raw = 'Command failed: sandbox-exec -f /tmp/profile.sb sh -c "python export.py"';
    const result = humanizeInternalText(raw, 'en');
    expect(result.text).toBe('macOS system sandbox');
    expect(result.collapseIntoDetails?.details).toBe(raw);
    expect(result.text).not.toContain('python');
  });
});


describe('tool labels in native approval notices', () => {
  it.each(['zh', 'en'] as const)('humanizes aliases at label boundaries without changing English prose in %s', (lang) => {
    expect(humanizeInternalText('Bash: 请求执行权限', lang).text).toBe(lang === 'en' ? 'Run command needs your approval' : '运行命令需要你批准');
    expect(humanizeInternalText('需要授权', 'en').text).toBe('Approval needed');
    for (const raw of ['Bash', 'Read:', 'Write:', 'Grep:', 'Glob:', 'Edit:']) {
      const result = humanizeInternalText(raw, lang);
      expect(result.detectedFormats).toContain('internal_tool_name');
      expect(detectInternalTextLeaks(result.text)).toEqual([]);
    }
    for (const prose of ['Read the weekly report.', 'Write a summary.', 'Edit the document after review.']) {
      expect(humanizeInternalText(prose, lang).text).toBe(prose);
    }
  });
});


it('localizes a host completion state while retaining the original diagnostic input', () => {
  expect(humanizeInternalText('任务已完成 Duration: 10 sec', 'en').text).toBe('Task completed Duration: 10 sec');
  const raw = '任务已完成 call_export123';
  const result = humanizeInternalText(raw, 'en');
  expect(result.text).toBe('Task completed tool operation');
  expect(result.collapseIntoDetails?.details).toBe(raw);
});
