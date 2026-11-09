// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionRequest } from '../../../src/shared/contract';
import { PermissionRequestReason } from '../../../src/shared/contract';
import { permissionRequestTypeForLevel } from '../../../src/host/tools/permissionRequestType';
import { boundaryIdForRequestType } from '../../../src/host/tools/permissionBoundaryMapping';
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
  'set_role_proactivity',
  'spawn_agent',
  'browser_action.write_clipboard',
  'SessionManager',
] as const;

const bannedNonShell = ['命令', 'command', '覆盖本机系统', 'overwrite local system'];
const bannedRead = ['写入', '覆盖', 'write', 'overwrite'];

type GateSchema = {
  permissionLevel: string;
  category: string;
  inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] };
};

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
  let reason: string | undefined;
  if (tool === 'Browser') {
    details = { action: 'navigate', url: 'https://example.com' };
  } else if (tool === 'set_role_proactivity') {
    details = { preview: { type: 'generic', summary: '提醒频率：每天一次 -> 实时' } };
  } else if (tool === 'spawn_agent') {
    details = { role: 'explorer', task: 'Inspect the repository' };
  } else if (tool === 'browser_action.write_clipboard') {
    details = { action: 'write_clipboard', textLength: 5 };
  } else if (tool === 'SessionManager') {
    details = {};
    reason = 'Archive the selected session';
  }
  return {
    id: `approval-${tool}`,
    sessionId: 'session-current',
    tool,
    type: permissionType as PermissionRequest['type'],
    details: details as PermissionRequest['details'],
    reason,
    reasonCode: PermissionRequestReason.Unknown,
    boundary: { id: boundaryIdForRequestType(permissionType) },
    dangerLevel: 'normal',
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
    const schemas = getProtocolRegistry().getSchemas().filter((schema) => schema.permissionLevel !== 'read');
    const byName = new Map(schemas.map((schema) => [schema.name, schema]));
    const tools = [...new Set([...schemas.map((schema) => schema.name), ...explicitNonShellTools])].sort();
    const neutralByDefault: string[] = [];

    for (const tool of tools) {
      const schema = byName.get(tool);
      const request = requestForTool(tool, schema);
      const shell = schema?.category === 'shell';
      const zh = render(request, 'zh');
      const en = render(request, 'en');
      if (!shell) {
        if (tool !== 'Browser' && tool !== 'set_role_proactivity' && tool !== 'spawn_agent' && tool !== 'browser_action.write_clipboard') {
          neutralByDefault.push(tool);
        }
        expect(zh, `${tool} must not wear the shell terminal icon`).not.toContain('lucide-terminal');
        if (request.type === 'command') expect(zh).toContain('permission-action-icon');
        for (const banned of bannedNonShell) {
          expect(`${zh}\n${en}`, `${tool} must be neutral in both languages`).not.toContain(banned);
        }
      }
    }

    expect(neutralByDefault.length, 'new non-shell tools are visible as neutral by default').toBeGreaterThan(0);
    console.info(`neutral by default: ${neutralByDefault.join(', ')}`);
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
      expect(card).not.toContain('risky command');
      expect(card).not.toContain('overwrite local system');
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
});
