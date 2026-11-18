// 只读协议工具（无文件目标）的审批卡：标题说清读什么；门禁枚举真实 schema 注册表。
import { describe, expect, it } from 'vitest';
import { describeApproval } from '../../../src/renderer/components/PermissionDialog/describeApproval';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { PermissionRequest } from '../../../src/shared/contract/permission';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { buildCanUseToolFromLegacy } from '../../../src/host/tools/dispatch/shadowAdapter';
import { getProtocolToolSchemas } from '../../../src/host/tools/protocolToolRegistration';

const LANGS = [
  { language: 'zh' as const, t: zh },
  { language: 'en' as const, t: en },
];

function readRequest(tool: string, details: Record<string, unknown> = {}): PermissionRequest {
  return { id: 'r1', tool, type: 'file_read', details, timestamp: 1 } as PermissionRequest;
}

// 生产形状：协议工具体内 canUseTool(name, args) 经真实 shadowAdapter 写出的审批请求（无 path/url 时 type=command）。
async function bodyRequest(tool: string, args: Record<string, unknown>): Promise<PermissionRequest> {
  let captured: Record<string, unknown> | undefined;
  const canUseTool = buildCanUseToolFromLegacy({
    requestPermission: async (req: Record<string, unknown>) => { captured = req; return true; },
  } as never, tool);
  await canUseTool(tool, args);
  return { id: 'r1', timestamp: 1, ...captured } as PermissionRequest;
}

describe('describeApproval: production request shape from shadowAdapter', () => {
  it('body request for a path-less read tool is type command and still names the object', async () => {
    const req = await bodyRequest('meeting_records', { action: 'search', query: 'budget' });
    expect(req.type).toBe('command');
    expect(describeApproval(req, zh, 'zh').title).toBe('读取会议记录');
    expect(describeApproval(req, en, 'en').title).toBe('Read meeting records');
  });

  it('reminders body request names the object in both languages', async () => {
    const req = await bodyRequest('reminders', { action: 'list_reminders' });
    expect(describeApproval(req, zh, 'zh').title).toBe('读取提醒事项');
    expect(describeApproval(req, en, 'en').title).toBe('Read Reminders');
  });

  it('write connector tools never get a "Read …" title', async () => {
    for (const tool of ['mail_send', 'reminders_create', 'calendar_delete_event']) {
      const req = await bodyRequest(tool, { title: 'x' });
      expect(describeApproval(req, en, 'en').title, tool).toBe(en.decisionCard.permission.genericApprovalTitle);
    }
  });

  it('bash command stays a shell card', async () => {
    const req = await bodyRequest('Bash', { command: 'ls' });
    expect(describeApproval(req, en, 'en').kind).toBe('shell');
  });
});

describe('describeApproval: read-level protocol tools without a file target', () => {
  it('reminders names the object', () => {
    expect(describeApproval(readRequest('reminders', { action: 'list_reminders' }), zh, 'zh').title).toBe('读取提醒事项');
    expect(describeApproval(readRequest('reminders', { action: 'list_reminders' }), en, 'en').title).toBe('Read Reminders');
  });

  it('meeting_records names the object', () => {
    const d = { action: 'search' };
    expect(describeApproval(readRequest('meeting_records', d), zh, 'zh').title).toBe('读取会议记录');
    expect(describeApproval(readRequest('meeting_records', d), en, 'en').title).toBe('Read meeting records');
    expect(describeApproval(readRequest('meeting_records', d), zh, 'zh').question).toBe('允许 Neo 读取会议记录吗？');
    expect(describeApproval(readRequest('meeting_records', d), en, 'en').question).toBe('Let Neo read meeting records?');
  });

  it('raw tool name and parameter keys never reach title/question', () => {
    for (const { language, t } of LANGS) {
      const d = describeApproval(readRequest('meeting_records', { action: 'read', meeting_id: 'm1' }), t, language);
      for (const text of [d.title, d.question]) {
        expect(text).not.toMatch(/meeting_records|meeting_id|action/);
      }
    }
  });

  it('a read tool with a file target keeps the file card', () => {
    const d = describeApproval(readRequest('meeting_records', { filePath: '/tmp/a.txt' }), en, 'en');
    expect(d.kind).toBe('file_read');
  });

  it('an unlabelled tool stays generic (no raw name used as label)', () => {
    const d = describeApproval(readRequest('some_unknown_reader'), en, 'en');
    expect(d.title).toBe(en.decisionCard.permission.genericApprovalTitle);
  });

  it('calendar list_events keeps the dedicated calendar card', () => {
    const d = describeApproval({ ...readRequest('calendar', { action: 'list_events' }), type: 'mcp' } as PermissionRequest, en, 'en');
    expect(d.kind).toBe('calendar_read');
  });
});

// 不会以「无目标 file_read 卡」出现的只读工具：内部记账 / 终端会话 / 子 Agent 协调 / 带路径参数的工具走文件卡。
const INTERNAL_PLANNING = '内部任务/计划记账，自动放行不弹卡';
const AGENT_COORD = '子 Agent 协调，内部调度不弹卡';
const TERMINAL = '终端会话读取，属 shell 类审批而非读取卡';
const NOT_FILE_READ = '读到的是工具自身元数据/技能，不是用户数据';
const READ_ALLOWLIST: Record<string, string> = {
  task_status: INTERNAL_PLANNING, wake_noop: INTERNAL_PLANNING, task_list: INTERNAL_PLANNING,
  task_get: INTERNAL_PLANNING, plan_read: INTERNAL_PLANNING, plan_review: INTERNAL_PLANNING,
  plan_recover_recent_work: INTERNAL_PLANNING, recommend_capability: INTERNAL_PLANNING,
  declare_deliverables: INTERNAL_PLANNING, attempt_completion: INTERNAL_PLANNING,
  schedule_task: INTERNAL_PLANNING, space_list: INTERNAL_PLANNING, space_query: INTERNAL_PLANNING,
  wait_agent: AGENT_COORD, collect_agent: AGENT_COORD, exit_role_flow: AGENT_COORD,
  task_output: TERMINAL, terminal_open: TERMINAL, terminal_list: TERMINAL,
  terminal_read: TERMINAL, terminal_wait: TERMINAL,
  ToolSearch: NOT_FILE_READ, Skill: NOT_FILE_READ, list_experts: NOT_FILE_READ,
  read_tool_result_archive: '读本轮自己的工具结果归档，内部引用',
  memory_search: '已有「记忆搜索」动作标签与专属展示，不走读取卡',
  Blob: '参数含 file_path，走文件卡',
};
const PATH_LIKE = /^(path|file_path|filePath|url|file)$/;

describe('gate: every read-level protocol tool without a path/url parameter names its object', () => {
  getProtocolRegistry();
  const schemas = getProtocolToolSchemas().filter((s) => {
    if (s.permissionLevel !== 'read') return false;
    const props = Object.keys((s.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    return !props.some((k) => PATH_LIKE.test(k));
  });

  it('enumerates a non-empty set including the known targets', () => {
    const names = schemas.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['reminders', 'meeting_records', 'mail']));
  });

  for (const schema of schemas.filter((s) => !(s.name in READ_ALLOWLIST))) {
    for (const { language, t } of LANGS) {
      it(`${schema.name} (${language}) is titled by object, not the generic title`, async () => {
        const props = (schema.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties ?? {};
        const actions = props.action?.enum;
        const d = describeApproval(await bodyRequest(schema.name, actions ? { action: actions[0] } : {}), t, language);
        expect(d.title, `${schema.name} has no human label — add one to receiptPresentation.humanToolLabels`)
          .not.toBe(t.decisionCard.permission.genericApprovalTitle);
        expect(`${d.title}\n${d.question}`).not.toContain(schema.name);
      });
    }
  }

  it('allowlist has no stale entries', () => {
    const known = new Set(getProtocolToolSchemas().map((s) => s.name));
    expect(Object.keys(READ_ALLOWLIST).filter((n) => !known.has(n))).toEqual([]);
  });
});
