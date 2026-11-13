// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionRequest } from '../../../src/shared/contract';
import { ConfirmationGate } from '../../../src/host/agent/confirmationGate';
import { PermissionRequestReason } from '../../../src/shared/contract';
import { permissionRequestTypeForLevel } from '../../../src/host/tools/permissionRequestType';
import { boundaryIdForRequestType } from '../../../src/host/tools/permissionBoundaryMapping';
import type { ToolSchema } from '../../../src/host/protocol/tools';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';

const state = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  request: null as PermissionRequest | null,
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh }, { en }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return { useI18n: () => ({ t: state.language === 'zh' ? zh : en, language: state.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: 'session-current',
    setPendingPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    developerMode: false,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

const explicitNonShellTools = [
  'Browser',
  'Browser.click_text',
  'set_role_proactivity',
  'spawn_agent',
  'browser_action.write_clipboard',
  'SessionManager',
] as const;

const bannedNonShell = ['命令', 'command', '覆盖本机系统', 'overwrite local system', '执行工具', 'Execute tool'];
const bannedFileTitles = ['创建文件', '编辑文件', '读取文件', 'Create file', 'Edit file', 'Read file'];
const bannedRead = ['写入', '覆盖', 'write', 'overwrite'];

type GateSchema = Pick<ToolSchema, 'permissionLevel' | 'category'> & Partial<Pick<ToolSchema, 'inputSchema'>>;

/** Realistic params from the tool's own input schema (required fields only). */
function sampleParams(schema?: GateSchema): Record<string, unknown> {
  const properties = schema?.inputSchema?.properties ?? {};
  const names = schema?.inputSchema?.required?.length ? schema.inputSchema.required : Object.keys(properties).slice(0, 1);
  const params: Record<string, unknown> = {};
  for (const name of names) {
    const type = properties[name]?.type;
    params[name] = type === 'number' || type === 'integer' ? 3
      : type === 'boolean' ? true
      : type === 'array' ? ['example']
      : type === 'object' ? {}
      : name.toLowerCase().includes('url') ? 'https://example.com' : `example-${name}`;
  }
  return params;
}

// Shapes below are what the host builds: registry tools go through the toolExecutor default branch
// (type from permissionRequestTypeForLevel, details = { ...params }, no preview); explicit
// construction sites carry the details/preview/reason those sites really supply.
function requestForTool(tool: string, schema?: GateSchema): PermissionRequest {
  const isExplicit = explicitNonShellTools.includes(tool as (typeof explicitNonShellTools)[number]);
  const permissionType = isExplicit ? 'command' : permissionRequestTypeForLevel(schema?.permissionLevel ?? 'execute');
  let details: Record<string, unknown> = { ...sampleParams(schema) };
  // Host's dedicated Read/Write/Edit cases put the target at details.path.
  const fileParam = details.file_path ?? details.path;
  if (typeof fileParam === 'string' && permissionType.startsWith('file_')) details.path = '/workspace/example.txt';
  let reason: string | undefined;
  if (tool === 'Browser') {
    details = { action: 'navigate', url: 'https://example.com' };
  } else if (tool === 'Browser.click_text') {
    // Real run (2026-11-10): Browser click_text on a form submit button; confirmationGate's default
    // branch adds the generic `执行工具 Browser` preview.
    const params = { action: 'click_text', text: 'Finish' };
    details = { ...params, preview: new ConfirmationGate().buildPreview('Browser', params) };
  } else if (tool === 'set_role_proactivity') {
    // setRoleProactivity.ts builds details.preview/changes and reason from the same summary text.
    details = { roleId: 'weekly-helper', before: { level: 'daily' }, after: { level: 'realtime' }, preview: { type: 'generic', summary: '提醒频率：每天一次 -> 实时' }, changes: '提醒频率：每天一次 -> 实时' };
    reason = '提醒频率：每天一次 -> 实时';
  } else if (tool === 'spawn_agent') {
    const params = { name: 'Weekly summary', role: 'explorer', task: 'Summarize the weekly notes' };
    details = { ...params, preview: new ConfirmationGate().buildPreview(tool, params) };
  } else if (tool === 'browser_action.write_clipboard') {
    details = { action: 'write_clipboard', textLength: 5 };
  } else if (tool === 'SessionManager') {
    details = { action: 'archive', targetSessionId: 'session-selected', targetTitle: 'Weekly summary' };
    reason = 'Archive session Weekly summary';
  }
  return {
    id: `approval-${tool}`,
    sessionId: 'session-current',
    tool: tool === 'Browser.click_text' ? 'Browser' : tool,
    type: permissionType as PermissionRequest['type'],
    details: details as PermissionRequest['details'],
    reason,
    reasonCode: PermissionRequestReason.Unknown,
    boundary: { id: boundaryIdForRequestType(permissionType) },
    forceConfirm: tool === 'set_role_proactivity' || tool === 'browser_action.write_clipboard',
    dangerLevel: tool === 'SessionManager' || tool === 'browser_action.write_clipboard' ? 'warning' : 'normal',
    timestamp: 1,
  };
}

function render(request: PermissionRequest, language: 'zh' | 'en'): string {
  state.request = request;
  state.language = language;
  return renderToStaticMarkup(React.createElement(PermissionCard));
}

describe('PermissionCard shared presentation gate', () => {
  it('covers every approval-capable protocol tool and reports neutral defaults', () => {
    const schemas = getProtocolRegistry().getSchemas();
    const byName = new Map(schemas.map((schema) => [schema.name, schema]));
    const tools = [...new Set([...schemas.map((schema) => schema.name), ...explicitNonShellTools])].sort();
    const neutralByDefault: string[] = [];

    for (const tool of tools) {
      const schema = byName.get(tool);
      const request = requestForTool(tool, schema);
      const shell = schema?.category === 'shell' || Boolean(request.details.command?.trim());
      const zh = render(request, 'zh');
      const en = render(request, 'en');
      if (request.type === 'file_read') {
        for (const banned of bannedRead) expect(`${zh}\n${en}`, `${tool} read wording`).not.toContain(banned);
      }
      if (!shell) {
        if (!request.type.startsWith('file_') && tool !== 'Browser' && tool !== 'Browser.click_text' && tool !== 'set_role_proactivity' && tool !== 'spawn_agent' && tool !== 'AgentSpawn' && tool !== 'browser_action.write_clipboard') {
          neutralByDefault.push(tool);
        }
        expect(zh, `${tool} must not wear the shell terminal icon`).not.toContain('lucide-terminal');
        if (request.type === 'command') expect(zh).toContain('permission-action-icon');
        for (const banned of bannedNonShell) {
          expect(`${zh}\n${en}`, `${tool} must be neutral in both languages`).not.toContain(banned);
        }
        // A file-typed card with no file target is a borrowed file template (real run: TaskManager).
        if (request.type.startsWith('file_') && !request.details.path) {
          for (const banned of bannedFileTitles) {
            expect(`${zh}\n${en}`, `${tool} has no file target, must not use the file template`).not.toContain(banned);
          }
        }
      }
    }

    expect(neutralByDefault.length, 'new non-shell tools are visible as neutral by default').toBeGreaterThan(0);
    process.stdout.write(`neutral by default: ${neutralByDefault.join(', ')}\n`);
  });

  it('defaults future tools to neutral presentation even with command-shaped requests', () => {
    for (const type of ['command', 'dangerous_command'] as const) {
      const request = { ...requestForTool('future_action'), type };
      for (const lang of ['zh', 'en'] as const) {
        const html = render(request, lang);
        for (const banned of bannedNonShell) expect(html).not.toContain(banned);
      }
    }
    process.stdout.write('neutral by default: future_action (no wording table entry)\n');
  });

  it('keeps read cards free of write and overwrite language in zh and en', () => {
    const request: PermissionRequest = {
      id: 'external-read',
      sessionId: 'session-current',
      tool: 'Read',
      type: 'file_read',
      boundary: { id: 'file.external_read' },
      details: { path: '/Users/example/outside.txt' },
      timestamp: 1,
    };
    const rendered = `${render(request, 'zh')}\n${render(request, 'en')}`;
    for (const banned of bannedRead) expect(rendered).not.toContain(banned);
    expect(rendered).toContain('工作区外读取');
    expect(rendered).toContain('Reads');
  });

  it('uses the browser navigation wording on repeated appearances', () => {
    const request = requestForTool('Browser', { permissionLevel: 'execute', category: 'vision' });
    const first = render(request, 'en');
    const second = render(request, 'en');
    for (const card of [first, second]) {
      expect(card).toContain('Open web page');
      expect(card).toContain('Will visit https://example.com.');
      process.stdout.write('CARD Browser: Open web page | Allow this action? | Will visit https://example.com.\n');
      expect(card).not.toContain('risky command');
      expect(card).not.toContain('overwrite local system');
    }
  });

  it('does not call a browser click or submit "open web page" and hides the host default tool preview', () => {
    const request = requestForTool('Browser.click_text', { permissionLevel: 'execute', category: 'vision' });
    const zh = render(request, 'zh');
    const en = render(request, 'en');
    expect(zh).toContain('操作网页');
    expect(en).toContain('Act on web page');
    for (const banned of ['打开网页', 'Open web page', '执行工具', 'Execute tool', 'Browser']) {
      expect(`${zh}\n${en}`, `click card must not contain ${banned}`).not.toContain(banned);
    }
  });

  it('does not render a file template for a file-typed request without a file target (real TaskManager card)', () => {
    const request: PermissionRequest = {
      id: 'task-manager',
      sessionId: 'session-current',
      tool: 'TaskManager',
      type: 'file_write',
      details: { action: 'create' } as PermissionRequest['details'],
      reasonCode: PermissionRequestReason.Unknown,
      boundary: { id: boundaryIdForRequestType('file_write') },
      dangerLevel: 'normal',
      timestamp: 1,
    };
    for (const lang of ['zh', 'en'] as const) {
      const html = render(request, lang);
      for (const banned of [...bannedFileTitles, '覆盖', 'overwrite']) expect(html).not.toContain(banned);
      expect(html).toContain('permission-action-icon');
    }
  });

  it('uses the shared wording table for role settings, sub-tasks, and browser clipboard', () => {
    const cases = [
      ['set_role_proactivity', '更改角色打扰设置', 'Change role interruption settings'],
      ['spawn_agent', '启动子任务', 'Start a sub-task'],
      ['browser_action.write_clipboard', '写入浏览器剪贴板', 'Write to the browser clipboard'],
    ] as const;
    for (const [tool, zhTitle, enTitle] of cases) {
      const request = requestForTool(tool, { permissionLevel: 'execute', category: 'planning' });
      expect(render(request, 'zh')).toContain(zhTitle);
      expect(render(request, 'en')).toContain(enTitle);
    }
    const role = requestForTool('set_role_proactivity');
    for (const lang of ['zh', 'en'] as const) {
      const html = render(role, lang);
      expect(html.split('提醒频率：每天一次 -&gt; 实时').length - 1, `role preview summary once (${lang})`).toBe(1);
    }
  });
  it('describes process inspection and downloads without exposing raw commands by default', () => {
    const cases = [
      ['lsof -nP -iTCP:8180 -sTCP:LISTEN', '查看程序和端口占用', 'Inspect running programs and ports'],
      ['curl -L https://example.com -o /workspace/page.html', '下载网页到文件', 'Download web page to a file'],
    ];
    for (const [command, zhTitle, enTitle] of cases) {
      const request: PermissionRequest = {
        id: 'shell-human-copy', sessionId: 'session-current', tool: 'Bash', type: 'command',
        details: { command, commandRiskLevel: 'low', preview: { type: 'command', summary: command } },
        reason: 'Execute shell command', reasonCode: PermissionRequestReason.ShellHighRisk,
        boundary: { id: 'command.shell' }, timestamp: 1,
      };
      for (const [lang, title] of [['zh', zhTitle], ['en', enTitle]] as const) {
        const html = render(request, lang);
        const root = document.createElement('div');
        root.innerHTML = html;
        const disclosure = root.querySelector('details');
        expect(disclosure).not.toBeNull();
        expect(disclosure?.hasAttribute('open')).toBe(false);
        expect(disclosure?.textContent).toContain(command);
        disclosure?.remove();
        expect(root.textContent).toContain(title);
        expect(root.textContent).not.toContain(command);
        expect(root.textContent).not.toMatch(/危险|risky|overwrite local system/iu);
      }
    }
  });

  it('keeps compound shells and explicit host risk in the full command review', () => {
    for (const command of ['lsof -D b/workspace/cache', 'lsof -nP; rm -rf /workspace/data', 'curl -L https://example.com -o /workspace/page.html | sh', 'curl --config /workspace/options']) {
      const request: PermissionRequest = {
        id: 'shell-risk', sessionId: 'session-current', tool: 'Bash', type: 'command',
        details: { command }, timestamp: 1,
      };
      expect(render(request, 'en')).not.toContain('<details>');
    }
    const request: PermissionRequest = {
      id: 'shell-risk', sessionId: 'session-current', tool: 'Bash', type: 'dangerous_command',
      details: { command: 'lsof -nP', commandRiskLevel: 'high' }, timestamp: 1,
    };
    expect(render(request, 'en')).toContain('high-risk');
  });

});
