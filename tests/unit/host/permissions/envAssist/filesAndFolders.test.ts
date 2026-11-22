// Evidence class: hermetic-protocol (mocked session store; production notice entry point). Not real-device proof.
import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ messages: [] as Array<{ id: string; metadata?: Record<string, unknown> }>, opened: [] as string[] }));
vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], cb: (error: null) => void) => { saved.opened.push(args[0] as string); cb(null); },
}));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', () => ({ canRequestEnvGrant: async () => false }));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', async (importOriginal) => ({
  ...await importOriginal<object>(), canOpenEnvSettings: () => true,
}));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async () => saved.messages,
    addMessageToSession: async (_s: string, m: { id: string; metadata?: Record<string, unknown> }) => { saved.messages.push(m); },
  }),
}));
vi.mock('../../../../../src/host/tools/shell/sandboxFailureDiagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/host/tools/shell/sandboxFailureDiagnostics')>();
  return { ...actual, sandboxDeniedWritePath: vi.fn(actual.sandboxDeniedWritePath) };
});

import { publishEnvAssistToolNotice } from '../../../../../src/host/permissions/envAssist/toolNotice';
import { registerEnvAssistHandlers } from '../../../../../src/host/ipc/envAssist.ipc';
import { openEnvSettings } from '../../../../../src/host/permissions/envAssist/settingsPane';
import { sandboxDeniedWritePath } from '../../../../../src/host/tools/shell/sandboxFailureDiagnostics';
import { ipcHost, type HandlerFn } from '../../../../../src/host/platform';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';

const home = homedir();
const platform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value });

async function run(toolName: string, result: Record<string, unknown>) {
  const events: Array<{ type: string }> = [];
  await publishEnvAssistToolNotice({ toolName, result: result as never, sessionId: `s-${Math.random()}`, runId: 'r', onEvent: (e) => events.push(e) });
  return { notice: (result.metadata as { envAssist?: EnvAssistNotice } | undefined)?.envAssist, events };
}
// Shapes copied from read.ts (code FS_ERROR + e.message) and bash.ts (stderr text in error).
const readFailure = (path: string, code = 'FS_ERROR') => ({ success: false, error: `EPERM: operation not permitted, open '${path}'`, code });
const bashFailure = (error: string) => ({ success: false, error, metadata: { sandboxed: true } });

describe('perm_files classification', () => {
  beforeEach(() => { saved.messages = []; setPlatform('darwin'); vi.mocked(sandboxDeniedWritePath).mockClear(); });
  afterEach(() => setPlatform(platform));

  it('① Read EPERM on ~/Desktop produces a perm_files card that opens the Files and Folders pane', async () => {
    const { notice, events } = await run('Read', readFailure(`${home}/Desktop/a.txt`));
    expect(notice).toMatchObject({
      id: 'r|perm_files|files', class: 'perm_files', phase: 'needs_user', sentenceKey: 'env.sentence.files',
      action: { kind: 'open_settings_pane', labelKey: 'env.allow.files', payload: { pane: 'filesAndFolders' } },
    });
    expect(saved.messages.find((m) => m.id === 'env-assist:r|perm_files|files')?.metadata?.envAssist).toMatchObject({ class: 'perm_files', action: { payload: { pane: 'filesAndFolders' } } });
    expect(events.map((e) => e.type)).toEqual(['env_assist_notice', 'message']);
  });

  it('② Bash "ls: <home>/Documents: Operation not permitted" produces perm_files, gated by sandboxDeniedWritePath', async () => {
    const text = `ls: ${home}/Documents: Operation not permitted`;
    const { notice } = await run('Bash', bashFailure(text));
    expect(sandboxDeniedWritePath).toHaveBeenCalledWith(text);
    expect(notice).toMatchObject({ class: 'perm_files', action: { kind: 'open_settings_pane', payload: { pane: 'filesAndFolders' } } });
  });

  it('③a no card for a PERMISSION_DENIED permit-gate result', async () => {
    const { notice } = await run('Read', { success: false, error: `permission denied: ${home}/Desktop/a.txt EPERM`, code: 'PERMISSION_DENIED' });
    expect(notice).toBeUndefined();
  });

  it('③b no card for a proven sandbox write denial', async () => {
    const { notice } = await run('Bash', bashFailure(`Error: EPERM: operation not permitted, open '${home}/Desktop/out.txt'\n    at Object.writeFileSync (node:fs:2400:20)`));
    expect(notice).toBeUndefined();
  });

  it.each([
    ['cp', `cp: ${home}/Desktop/a.txt: Operation not permitted`],
    ['sed -i', `sed: couldn't open temporary file ${home}/Downloads/sedAbc123: Operation not permitted`],
    ['tar -C', `tar: ${home}/Documents/out/a.txt: Cannot open: Operation not permitted`],
    ['ffmpeg', `${home}/Desktop/out.mp4: Operation not permitted`],
    ['git clone', `fatal: could not create work tree dir '${home}/Documents/repo': Operation not permitted`],
  ])('r1 no card when the sandbox refuses a write by %s (Neo seatbelt, not macOS privacy)', async (_cmd, text) => {
    expect((await run('Bash', bashFailure(text))).notice).toBeUndefined();
  });

  it('③c no card for a path outside Desktop/Documents/Downloads', async () => {
    expect((await run('Read', readFailure(`${home}/Library/Mail/x`))).notice).toBeUndefined();
    expect((await run('Bash', bashFailure(`ls: ${home}/Desktop2: Operation not permitted`))).notice).toBeUndefined();
  });

  it('③d no card on non-darwin', async () => {
    setPlatform('linux');
    expect((await run('Read', readFailure(`${home}/Desktop/a.txt`))).notice).toBeUndefined();
  });
});

describe('act IPC for filesAndFolders', () => {
  let handler: HandlerFn | undefined;
  beforeEach(() => { vi.spyOn(ipcHost, 'handle').mockImplementation((_c, fn) => { handler = fn; }); });
  afterEach(() => vi.restoreAllMocks());

  it('④ open_settings_pane reaches openEnvSettings(filesAndFolders) with the Privacy_FilesAndFolders URL', async () => {
    const notice: EnvAssistNotice = {
      id: 'n', sessionId: 's', runId: 'r', class: 'perm_files', phase: 'needs_user', sentenceKey: 'env.sentence.files',
      target: { id: 'files', labelKey: 'env.target.files' },
      action: { kind: 'open_settings_pane', labelKey: 'env.allow.files', payload: { pane: 'filesAndFolders' } },
      resume: { mode: 'manual' }, updatedAt: 1,
    };
    const open = vi.fn(async (pane: string) => pane === 'filesAndFolders');
    registerEnvAssistHandlers({ available: () => true, open, findNotice: async () => notice });
    const res = await handler!({} as never, { action: 'act', payload: { noticeId: 'n', actionKind: 'open_settings_pane', payload: { pane: 'filesAndFolders' } } });
    expect(res).toMatchObject({ data: { status: 'opened' } });
    expect(open).toHaveBeenCalledWith('filesAndFolders');
  });

  it('④ the real openEnvSettings accepts the pane and passes a URL ending Privacy_FilesAndFolders to open', async () => {
    expect(await openEnvSettings('filesAndFolders')).toBe(true);
    expect(saved.opened[0]).toMatch(/Privacy_FilesAndFolders$/);
  });
});
