import { describe, expect, it } from 'vitest';

import { resolveAgent } from '../../../src/host/agent/agentRegistry';
import {
  buildForegroundToolFaceNarrowingNotice,
  buildRoleWakeToolNames,
  resolveRoleWakeRequiredToolNames,
} from '../../../src/host/agent/runtime/turnToolFace';
import { withSessionCommandCenterBrain, getTextForegroundToolNamesForPrompt } from '../../../src/host/app/sessionCommandCenterBrain';
import { getAllToolDefinitions } from '../../../src/host/tools/dispatch/toolDefinitions';
import { getTextForegroundToolNames } from '../../../src/host/tools/protocolRegistry';
import { browserActionSchema } from '../../../src/host/plugins/builtin/browserControl/browserAction.schema';

describe('turn tool-face contract', () => {
  it('role chat keeps the foreground face and every declared role tool', () => {
    const role = resolveAgent('dream');
    expect(role).toBeDefined();
    const options = withSessionCommandCenterBrain({ agentOverrideId: 'dream' }, '请介绍一下当前项目');
    const allowed = new Set(options.allowedToolNames ?? []);
    expect(getTextForegroundToolNames().every((name) => allowed.has(name))).toBe(true);
    for (const name of role?.tools ?? []) expect(allowed.has(name)).toBe(true);
  });

  it('role wake unions declared tools with connected-source read tools and keeps writes declared-only', async () => {
    const definitions = getAllToolDefinitions();
    const required = await resolveRoleWakeRequiredToolNames(['MemoryWrite'], ['Calendar']);
    const names = new Set(required ?? []);
    expect(names.has('MemoryWrite')).toBe(true);
    expect(names.has('calendar')).toBe(true);
    expect(names.has('calendar_create_event')).toBe(false);
    const direct = buildRoleWakeToolNames({
      declaredRoleTools: ['MemoryWrite'],
      connectedSourceNames: ['Calendar'],
      definitions,
    });
    expect(direct).toEqual(required);
  });

  it('foreground named Bash and browser work get a reason plus background exit', () => {
    const before = [...getAllToolDefinitions(), browserActionSchema];
    const after = before.filter((tool) => !['Bash', 'browser', 'browser_action', 'browser_navigate', 'computer_use'].includes(tool.name));
    const shellNotice = buildForegroundToolFaceNarrowingNotice('用终端执行 ls', before, after);
    const browserNotice = buildForegroundToolFaceNarrowingNotice('用浏览器打开 example.com', before, after);
    expect(shellNotice).toContain('delegate_task');
    expect(shellNotice).toContain('background task');
    expect(browserNotice).toContain('delegate_task');
    expect(browserNotice).toContain('browser interaction');
    expect(shellNotice).not.toContain('disabled by permission policy');
    expect(browserNotice).not.toContain('disabled by permission policy');
  });

  it('MiMo foreground keeps delegate_task while deferred web and browser tools stay out', () => {
    const names = getTextForegroundToolNamesForPrompt('请快速回答这个问题');
    expect(names).toContain('delegate_task');
    expect(names).not.toContain('web_fetch');
    expect(names).not.toContain('computer_use');
  });
});
