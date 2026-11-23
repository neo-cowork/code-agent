import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import type { ToolContext as LegacyToolContext } from '../../../../../src/host/tools/types';

const databaseState = vi.hoisted(() => ({
  sessions: new Map<string, { workingDirectory?: string | null }>(),
  error: null as Error | null,
}));

vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getSession: (sessionId: string) => {
      if (databaseState.error) throw databaseState.error;
      return databaseState.sessions.get(sessionId) ?? null;
    },
  }),
}));

import { getPermissionModeManager, resetPermissionModeManager } from '../../../../../src/host/permissions/modes';
import { listDirectoryModule } from '../../../../../src/host/tools/modules/file/listDirectory';
import { globModule } from '../../../../../src/host/tools/modules/file/glob';
import { readModule } from '../../../../../src/host/tools/modules/file/read';
import { grepModule } from '../../../../../src/host/tools/modules/shell/grep';
import { getProtocolRegistry } from '../../../../../src/host/tools/protocolRegistry';
import { getToolResolver } from '../../../../../src/host/tools/dispatch/toolResolver';

const NO_WORKING_FOLDER_ERROR =
  'This run has no working folder. Pick a folder for the task first; absolute paths are still allowed.';
const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(sessionId: string, workingDir: string, logger = makeLogger()): ToolContext {
  return {
    sessionId,
    workingDir,
    abortSignal: new AbortController().signal,
    logger,
    emit: vi.fn(),
  };
}

function makeDispatchCtx(sessionId: string, workingDir: string): LegacyToolContext {
  return {
    sessionId,
    workingDirectory: workingDir,
    requestPermission: vi.fn(async () => true),
    abortSignal: new AbortController().signal,
  };
}

describe('read-only tools without a session working folder', () => {
  let home: string;
  let absoluteFolder: string;
  const savedHome = process.env.HOME;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'no-working-folder-home-'));
    absoluteFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'no-working-folder-absolute-'));
    await fs.writeFile(path.join(home, 'home-secret.txt'), 'do not expose this', 'utf8');
    await fs.writeFile(path.join(absoluteFolder, 'allowed.txt'), 'allowed', 'utf8');
    process.env.HOME = home;
    databaseState.sessions.clear();
    databaseState.error = null;
    databaseState.sessions.set('unattended-no-folder', { workingDirectory: null });
    databaseState.sessions.set('unattended-empty-folder', { workingDirectory: '' });
    databaseState.sessions.set('interactive-no-folder', { workingDirectory: null });
    getPermissionModeManager().markUnattendedSession('unattended-no-folder');
    getPermissionModeManager().markUnattendedSession('unattended-empty-folder');
    getProtocolRegistry();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(absoluteFolder, { recursive: true, force: true });
  });

  it('ListDirectory refuses omitted and relative paths through createHandler and production dispatch when no folder is selected', async () => {
    const logger = makeLogger();
    const handler = await listDirectoryModule.createHandler();
    const omitted = await handler.execute({}, makeCtx('unattended-no-folder', home, logger), allowAll);
    const relative = await handler.execute(
      { path: '.' },
      makeCtx('unattended-no-folder', home, logger),
      allowAll,
    );
    const dispatched = await getToolResolver().execute(
      'ListDirectory',
      {},
      makeDispatchCtx('unattended-no-folder', home),
    );

    console.log(`ListDirectory omitted result: ${JSON.stringify(omitted)}`);
    console.log(`ListDirectory relative result: ${JSON.stringify(relative)}`);
    console.log(`ListDirectory dispatch result: ${JSON.stringify(dispatched)}`);
    for (const call of vi.mocked(logger.info).mock.calls) {
      console.log(`logger.info ${call[0]} ${JSON.stringify(call[1])}`);
    }

    expect([omitted, relative]).toEqual([
      { ok: false, code: 'WORKING_DIRECTORY_REQUIRED', error: NO_WORKING_FOLDER_ERROR },
      { ok: false, code: 'WORKING_DIRECTORY_REQUIRED', error: NO_WORKING_FOLDER_ERROR },
    ]);
    expect(dispatched).toMatchObject({
      success: false,
      error: NO_WORKING_FOLDER_ERROR,
      metadata: { code: 'WORKING_DIRECTORY_REQUIRED' },
    });
  });

  it('ListDirectory keeps absolute and tilde paths on the existing permission path without resolving the session folder', async () => {
    databaseState.error = new Error('session lookup must not be needed for explicit paths');
    const permission = vi.fn<CanUseToolFn>(async () => ({ allow: true }));
    const handler = await listDirectoryModule.createHandler();
    const absolute = await handler.execute(
      { path: absoluteFolder },
      makeCtx('unattended-no-folder', home),
      permission,
    );
    const tilde = await handler.execute(
      { path: '~' },
      makeCtx('unattended-no-folder', home),
      permission,
    );

    expect(absolute.ok).toBe(true);
    expect(tilde.ok).toBe(true);
    if (absolute.ok) expect(absolute.output).toContain('allowed.txt');
    if (tilde.ok) expect(tilde.output).toContain('home-secret.txt');
    expect(permission).toHaveBeenCalledTimes(2);
  });

  it('ListDirectory keeps output byte-identical for an unattended session with a working folder', async () => {
    databaseState.sessions.set('unattended-with-folder', { workingDirectory: home });
    getPermissionModeManager().markUnattendedSession('unattended-with-folder');
    const handler = await listDirectoryModule.createHandler();
    const result = await handler.execute(
      {},
      makeCtx('unattended-with-folder', home),
      allowAll,
    );
    const baseline = await handler.execute(
      { path: home },
      makeCtx('unattended-with-folder', home),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(baseline.ok).toBe(true);
    if (result.ok && baseline.ok) {
      expect(result.output).toBe(baseline.output);
      expect(result.meta?.dirPath).toBe(baseline.meta?.dirPath);
      expect(result.output).toContain('home-secret.txt');
    }
  });

  it('ListDirectory keeps output byte-identical for an interactive session without a working folder', async () => {
    const handler = await listDirectoryModule.createHandler();
    const result = await handler.execute(
      { path: '.' },
      makeCtx('interactive-no-folder', home),
      allowAll,
    );
    const baseline = await handler.execute(
      { path: home },
      makeCtx('interactive-no-folder', home),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(baseline.ok).toBe(true);
    if (result.ok && baseline.ok) {
      expect(result.output).toBe(baseline.output);
      expect(result.meta?.dirPath).toBe(baseline.meta?.dirPath);
      expect(result.output).toContain('home-secret.txt');
    }
  });

  it.each([
    { tool: 'Glob', shape: 'omitted', args: { pattern: '*' } },
    { tool: 'Glob', shape: 'relative', args: { pattern: '*', path: '.' } },
    { tool: 'Grep', shape: 'omitted', args: { pattern: 'do not expose' } },
    { tool: 'Grep', shape: 'relative', args: { pattern: 'do not expose', path: '.' } },
    { tool: 'Read', shape: 'relative', args: { file_path: 'home-secret.txt' } },
  ])('$tool refuses an $shape path in the same unattended no-folder session', async ({ tool, args }) => {
    const module = tool === 'Glob' ? globModule : tool === 'Grep' ? grepModule : readModule;
    const handler = await module.createHandler();
    const result = await handler.execute(
      args,
      makeCtx('unattended-empty-folder', home),
      allowAll,
    );
    console.log(`${tool} ${args.path ?? args.file_path ?? 'omitted'} result: ${JSON.stringify(result)}`);
    expect(result).toEqual({
      ok: false,
      code: 'WORKING_DIRECTORY_REQUIRED',
      error: NO_WORKING_FOLDER_ERROR,
    });
  });

  it('fails closed and logs the reason when the session folder lookup throws', async () => {
    databaseState.error = new Error('session database unavailable');
    const logger = makeLogger();
    const handler = await listDirectoryModule.createHandler();
    const result = await handler.execute(
      {},
      makeCtx('unattended-no-folder', home, logger),
      allowAll,
    );

    expect(result).toEqual({
      ok: false,
      code: 'WORKING_DIRECTORY_REQUIRED',
      error: NO_WORKING_FOLDER_ERROR,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not resolve the session working folder for an unattended read',
      expect.objectContaining({
        sessionId: 'unattended-no-folder',
        reason: 'session database unavailable',
      }),
    );
  });
});
