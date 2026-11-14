// @vitest-environment jsdom
/**
 * Approval card presentation gate.
 *
 * Every request below comes from a PRODUCTION host entry (ToolExecutor with a capturing
 * requestPermission, the real requestDirectory / setRoleProactivity / browser clipboard modules with a
 * capturing canUseTool/requestPermission), never from a hand-built object, and is rendered through the
 * production PermissionCard in zh and en.
 */
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionRequest } from '../../../src/shared/contract';

const state = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  request: null as unknown,
  definitions: new Map<string, Record<string, unknown>>(),
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

// Host side: only the data sources behind the request builders are replaced; the builders are production code.
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: (name: string) => state.definitions.get(name),
    execute: vi.fn(async () => ({ success: true, output: 'ok' })),
  }),
}));
vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ isCacheable: () => false, get: () => null, set: vi.fn() }),
}));
vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({ acquire: vi.fn(async () => () => {}) }),
  getWriteIsolationScope: () => null,
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});
vi.mock('../../../src/host/services/project/projectService', () => ({ getProjectService: () => ({}) }));
vi.mock('../../../src/host/security/folderTrustService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setFolderTrust: vi.fn(),
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => null }),
}));
vi.mock('../../../src/host/services/roleAssets/roleAssetService', () => ({
  isPersistentRole: async () => true,
  listPersistentRoles: async () => ['mu-zhi'],
}));
vi.mock('../../../src/host/services/roleAssets/roleProactivity', () => ({
  resolveRoleProactivityConfig: async () => ({ level: 'daily', cadence: undefined, quietHours: null, topicsInclude: [], topicsExclude: [] }),
}));
vi.mock('../../../src/host/services/roleAssets/roleProactivityWrite', () => ({ writeRoleProactivityConfig: vi.fn() }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { describeApproval } from '../../../src/renderer/components/PermissionDialog/describeApproval';
import { getPermissionConfig } from '../../../src/renderer/components/PermissionDialog/utils';
import { en } from '../../../src/renderer/i18n/en';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { requestDirectoryModule } from '../../../src/host/tools/modules/file/requestDirectory';
import { executeSetRoleProactivity } from '../../../src/host/tools/modules/roleAuthoring/setRoleProactivity';
import { maybeExecuteBrowserSurfaceInteraction } from '../../../src/host/tools/vision/browserActionSurfaceInteractions';

type Languages = 'zh' | 'en';
const LANGUAGES: Languages[] = ['zh', 'en'];

interface Captured {
  /** how the request was produced */
  origin: string;
  tool: string;
  request: PermissionRequest;
}

const captured: Captured[] = [];
const noApproval: string[] = [];
let sampleDir = '';
let sampleFile = '';
let outsideFile = '';

function toRequest(raw: Record<string, unknown>, id: string): PermissionRequest {
  return { id, sessionId: 'session-current', timestamp: 1, ...raw } as unknown as PermissionRequest;
}

function sampleParams(schema: { inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } }): Record<string, unknown> {
  const properties = schema.inputSchema?.properties ?? {};
  const names = schema.inputSchema?.required?.length ? schema.inputSchema.required : Object.keys(properties).slice(0, 1);
  const params: Record<string, unknown> = {};
  for (const name of names) {
    const type = properties[name]?.type;
    params[name] = type === 'number' || type === 'integer' ? 3
      : type === 'boolean' ? true
      : type === 'array' ? ['example']
      : type === 'object' ? {}
      : /url/iu.test(name) ? 'https://example.com'
      : /path|file|dir/iu.test(name) ? sampleFile
      : 'Weekly notes';
  }
  return params;
}

async function askThroughExecutor(tool: string, params: Record<string, unknown>, origin: string): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const executor = new ToolExecutor({
    requestPermission: async (req: unknown) => { requests.push(req as Record<string, unknown>); return false; },
    workingDirectory: sampleDir,
    // Ask for every permission-requiring tool so the request SHAPE of each registry tool is observable.
    forcePermissionHandler: true,
  });
  executor.setAuditEnabled(false);
  await executor.execute(tool, params, { sessionId: 'session-current' });
  if (requests.length === 0) { noApproval.push(tool); return; }
  captured.push({ origin, tool, request: toRequest(requests[0], `approval-${origin}-${tool}`) });
}

const EXECUTOR_OVERRIDES: Array<{ tool: string; params: Record<string, unknown>; origin: string }> = [
  { tool: 'Browser', params: { action: 'navigate', url: 'https://example.com' }, origin: 'executor:Browser navigate' },
  { tool: 'Browser', params: { action: 'click_text', text: 'Finish' }, origin: 'executor:Browser click_text' },
  { tool: 'Bash', params: { command: 'ls -la' }, origin: 'executor:Bash' },
  { tool: 'Read', params: { file_path: 'OUTSIDE_FILE' }, origin: 'executor:Read outside' },
  { tool: 'spawn_agent', params: { name: 'Weekly summary', role: 'explorer', task: 'Summarize the weekly notes' }, origin: 'executor:spawn_agent' },
];
// These tools are driven through their own production module below, not through the generic sweep.
const MODULE_DRIVEN = new Set(['request_directory', 'set_role_proactivity']);

beforeAll(async () => {
  sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-gate-'));
  sampleFile = path.join(sampleDir, 'this-week.txt');
  fs.writeFileSync(sampleFile, 'hello');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-gate-outside-'));
  outsideFile = path.join(outsideDir, 'this-week.txt');
  fs.writeFileSync(outsideFile, 'hello');

  const schemas = getProtocolRegistry().getSchemas();
  for (const schema of schemas) {
    state.definitions.set(schema.name, {
      name: schema.name,
      description: schema.description,
      inputSchema: schema.inputSchema,
      requiresPermission: true,
      permissionLevel: schema.permissionLevel,
    });
  }
  for (const name of ['Browser', 'Read', 'Write', 'Bash']) {
    if (state.definitions.has(name)) continue;
    state.definitions.set(name, {
      name, description: name, inputSchema: { type: 'object', properties: {} },
      requiresPermission: true, permissionLevel: name === 'Read' ? 'read' : name === 'Browser' ? 'execute' : name === 'Bash' ? 'execute' : 'write',
    });
  }

  for (const override of EXECUTOR_OVERRIDES) {
    const params = JSON.parse(JSON.stringify(override.params).replace('OUTSIDE_FILE', outsideFile.replaceAll('\\', '\\\\')));
    await askThroughExecutor(override.tool, params, override.origin);
  }
  for (const schema of schemas) {
    if (MODULE_DRIVEN.has(schema.name) || EXECUTOR_OVERRIDES.some((o) => o.tool === schema.name)) continue;
    await askThroughExecutor(schema.name, sampleParams(schema), `executor:${schema.name}`);
  }

  // request_directory: real module, capturing canUseTool.
  const ctx = {
    workingDir: sampleDir,
    sessionId: 'session-current',
    abortSignal: new AbortController().signal,
    workspaceScope: { projectId: 'p1', version: 1, roots: [] },
  } as never;
  for (const access of ['read_only', 'read_write'] as const) {
    let hint: Record<string, unknown> | undefined;
    await requestDirectoryModule.createHandler().execute(
      { path: sampleDir, reason: 'List the weekly reports', access },
      ctx,
      (async (name: string, _args: unknown, reason: string | undefined, req?: Record<string, unknown>) => {
        hint = { ...req, reason: req?.reason ?? reason, tool: req?.tool ?? name };
        return { allow: false, reason: 'captured' };
      }) as never,
    );
    if (hint) captured.push({ origin: `module:request_directory ${access}`, tool: 'request_directory', request: toRequest(hint, `approval-dir-${access}`) });
  }

  // set_role_proactivity: real module (quiet hours change), capturing canUseTool.
  let roleHint: Record<string, unknown> | undefined;
  await executeSetRoleProactivity(
    { roleId: 'mu-zhi', quiet_hours: { start: '22:00', end: '08:00' } },
    ctx,
    (async (name: string, _args: unknown, reason: string | undefined, req?: Record<string, unknown>) => {
      roleHint = { ...req, reason: req?.reason ?? reason, tool: req?.tool ?? name };
      return { allow: false, reason: 'captured' };
    }) as never,
  );
  if (roleHint) captured.push({ origin: 'module:set_role_proactivity', tool: 'set_role_proactivity', request: toRequest(roleHint, 'approval-role') });

  // Browser clipboard write: real surface-interaction module, capturing requestPermission.
  let clipboard: Record<string, unknown> | undefined;
  await maybeExecuteBrowserSurfaceInteraction({
    action: 'write_clipboard',
    params: { clipboardText: 'hello' },
    tabId: undefined,
    browserService: { writeClipboard: vi.fn() } as never,
    context: { requestPermission: async (req: Record<string, unknown>) => { clipboard = req; return false; } } as never,
  });
  if (clipboard) captured.push({ origin: 'module:browser_action write_clipboard', tool: 'browser_action.write_clipboard', request: toRequest(clipboard, 'approval-clipboard') });

  // A future tool nobody wrote copy for, in each command-shaped type.
  for (const type of ['command', 'file_write', 'file_read'] as const) {
    captured.push({
      origin: `future:${type}`,
      tool: 'future_unregistered_tool',
      request: toRequest({ type, tool: 'future_unregistered_tool', details: { topic: 'weekly' } }, `approval-future-${type}`),
    });
  }
}, 120_000);

function renderCard(request: PermissionRequest, language: Languages): { html: string; text: string } {
  state.request = request;
  state.language = language;
  const html = renderToStaticMarkup(React.createElement(PermissionCard));
  const root = document.createElement('div');
  root.innerHTML = html;
  return { html, text: root.textContent ?? '' };
}

/** User values (URL / path / reason / summary text) are not product copy; strip them before wording checks. */
function stripUserValues(text: string, request: PermissionRequest): string {
  const details = request.details as Record<string, unknown>;
  const preview = details.preview as { summary?: string; diff?: string } | undefined;
  // preview.diff of spawn_agent is the host's own task/permission statement ("permissions: may run commands"), i.e. a fact about the sub-task, not card template wording.
  const values = [details.path, details.filePath, details.url, details.roleId, preview?.summary, ...(preview?.diff?.split('\n') ?? []), details.changes, request.reason, request.tool];
  let out = text;
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) out = out.split(value).join('');
  }
  for (const part of String(details.path ?? '').split('/')) if (part.length > 2) out = out.split(part).join('');
  return out;
}

/** The production Browser request minus the host-only session-grant marker: the shape a surface without grants (CLI/relay) shows. */
function withoutBrowserGrant(request: PermissionRequest): PermissionRequest {
  const { browserSessionGrant: _grant, ...details } = request.details as Record<string, unknown>;
  return { ...request, details } as unknown as PermissionRequest;
}

const isShell = (c: Captured) => c.tool === 'Bash' || Boolean((c.request.details as Record<string, unknown>).command);

describe('PermissionCard presentation gate (production host request shapes)', () => {
  it('lists every approval-capable entry with its resolved kind and neutral defaults', () => {
    const lines = captured.map((c) => `${c.origin} -> type=${c.request.type} kind=${describeApproval(c.request as never, en, 'en').kind}`);
    process.stdout.write(`approval-capable entries (${captured.length}):\n${lines.join('\n')}\n`);
    process.stdout.write(`no approval requested by executor: ${noApproval.join(', ')}\n`);
    expect(captured.map((c) => c.tool)).toEqual(expect.arrayContaining([
      'Browser', 'spawn_agent', 'request_directory', 'set_role_proactivity', 'browser_action.write_clipboard', 'Bash',
    ]));
    const neutral = captured.filter((c) => describeApproval(c.request as never, en, 'en').kind === 'generic');
    for (const c of neutral) process.stdout.write(`neutral by default: ${c.tool}${c.origin.startsWith('future:') ? ` (${c.origin})` : ''}\n`);
    expect(neutral.map((c) => c.tool)).toContain('future_unregistered_tool');
  });

  it('non-shell cards never wear the shell template, in zh and en', () => {
    for (const c of captured.filter((x) => !isShell(x))) {
      for (const language of LANGUAGES) {
        const { html, text } = renderCard(c.request, language);
        const copy = stripUserValues(text, c.request);
        const label = `${c.origin} ${language}`;
        expect(html, `${label}: terminal icon`).not.toContain('lucide-terminal');
        expect(copy, `${label}: shell wording`).not.toMatch(/命令|command|覆盖本机系统|overwrite local system|执行工具|Execute tool/iu);
        expect(copy, `${label}: snake_case identifier`).not.toMatch(/\b[a-z]+(?:_[a-z]+)+\b/u);
        if (c.request.type === 'file_read') {
          expect(copy, `${label}: read card write wording`).not.toMatch(/写入|覆盖|write|overwrite/iu);
        }
      }
    }
  });

  it('keeps the shell template for a real shell command (positive control)', () => {
    const bash = captured.find((c) => c.origin === 'executor:Bash');
    expect(bash).toBeDefined();
    expect(renderCard(bash!.request, 'zh').html).toContain('lucide-terminal');
  });

  it('shows the fact the user must decide on (URL / path / folder) on the card', () => {
    const navigate = captured.find((c) => c.origin === 'executor:Browser navigate')!;
    expect((navigate.request.details as Record<string, unknown>).browserSessionGrant, 'production Browser request carries the grant marker').toBeDefined();
    for (const language of LANGUAGES) {
      expect(renderCard(withoutBrowserGrant(navigate.request), language).text, `navigate ${language}`).toContain('https://example.com');
    }
    for (const access of ['read_only', 'read_write']) {
      const folder = captured.find((c) => c.origin === `module:request_directory ${access}`)!;
      for (const language of LANGUAGES) {
        expect(renderCard(folder.request, language).text, `folder ${access} ${language}`).toContain(path.basename(sampleDir));
      }
    }
  });

  it('request_directory comes from the production module and states the granted access truthfully', () => {
    const readOnly = captured.find((c) => c.origin === 'module:request_directory read_only')!;
    const readWrite = captured.find((c) => c.origin === 'module:request_directory read_write')!;
    expect((readWrite.request.details as Record<string, unknown>).requestedAccess).toBe('read_write');
    const lines: string[] = [];
    for (const [label, c] of [['read_only', readOnly], ['read_write', readWrite]] as const) {
      for (const language of LANGUAGES) {
        const { text } = renderCard(c.request, language);
        lines.push(`${label} ${language}: ${text}`);
        expect(text).not.toMatch(/创建文件|Create file/u);
        expect(text).toContain(language === 'zh' ? '访问其他文件夹' : 'Access another folder');
        expect(text).not.toMatch(/path:|requestedAccess:/u);
        if (label === 'read_write') {
          expect(text).toContain(language === 'zh' ? '查看和修改' : 'view and change');
          expect(text).not.toMatch(/仅查看|only view/u);
        } else {
          expect(text).toContain(language === 'zh' ? '仅查看' : 'only view');
          expect(text).not.toMatch(/修改|change/u);
        }
      }
    }
    process.stdout.write(`rendered request_directory cards:\n${lines.join('\n')}\n`);
  });

  it('role setting shows the old -> new line exactly once, without a terminal icon', () => {
    const role = captured.find((c) => c.tool === 'set_role_proactivity')!;
    const summary = (role.request.details as { preview: { summary: string } }).preview.summary;
    const line = summary.split('\n').find((l) => l.includes('22:00'))!;
    for (const language of LANGUAGES) {
      const { html, text } = renderCard(role.request, language);
      expect(text.split(line).length - 1, `${language} old->new line count`).toBe(1);
      expect(html).not.toContain('lucide-terminal');
      expect(text).toContain(language === 'zh' ? '更改角色打扰设置' : 'Change role interruption settings');
    }
  });

  it('outside-workspace read says read-only, never write/overwrite', () => {
    const read = captured.find((c) => c.origin === 'executor:Read outside')!;
    for (const language of LANGUAGES) {
      const { text } = renderCard(read.request, language);
      expect(text).toContain(language === 'zh' ? '不会修改' : 'will not modify');
      expect(stripUserValues(text, read.request)).not.toMatch(/写入|覆盖|write|overwrite/iu);
    }
  });

  it('browser navigation and page actions use web wording (grant-free shape) and keep the dedicated card with a grant', () => {
    const navigate = captured.find((c) => c.origin === 'executor:Browser navigate')!;
    const click = captured.find((c) => c.origin === 'executor:Browser click_text')!;
    const grantFree = [withoutBrowserGrant(navigate.request), withoutBrowserGrant(click.request)];
    expect(renderCard(grantFree[0], 'zh').text).toContain('打开网页');
    expect(renderCard(grantFree[0], 'en').text).toContain('Open web page');
    expect(renderCard(grantFree[0], 'en').text).toContain('Will visit https://example.com.');
    expect(renderCard(grantFree[1], 'en').text).toContain('Operate on a web page');
    // With the host session-grant marker the dedicated browser card keeps precedence and is still not a shell card.
    for (const c of [navigate, click]) expect(renderCard(c.request, 'zh').html).not.toContain('lucide-terminal');
  });

  it('a future tool nobody wrote copy for is neutral in both languages, for every command-shaped type', () => {
    for (const c of captured.filter((x) => x.origin.startsWith('future:'))) {
      for (const [language, title] of [['zh', '需要你确认'], ['en', 'Needs your approval']] as const) {
        const { html, text } = renderCard(c.request, language);
        expect(text, `${c.origin} ${language}`).toContain(title);
        expect(html).not.toContain('lucide-terminal');
        expect(stripUserValues(text, c.request)).not.toMatch(/命令|command|创建文件|Create file|Read file|读取文件|写入|write/iu);
      }
    }
    // The type table itself must not fall back to the command template either.
    expect(getPermissionConfig('future_type' as never).title).not.toBe(getPermissionConfig('command').title);
  });
});
