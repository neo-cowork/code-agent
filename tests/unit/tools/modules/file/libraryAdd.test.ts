import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../../../src/host/services/core/database/schema';

let rawDb: BetterSqlite3.Database;
let projectId: string | null = 'proj_1';

vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => rawDb,
    getSession: () => ({ projectId }),
  }),
}));

import { ConfirmationGate } from '../../../../../src/host/agent/confirmationGate';
import { globModule } from '../../../../../src/host/tools/modules/file/glob';
import { libraryAddModule } from '../../../../../src/host/tools/modules/file/libraryAdd';
import { listDirectoryModule } from '../../../../../src/host/tools/modules/file/listDirectory';
import { grepModule } from '../../../../../src/host/tools/modules/shell/grep';
import { getLibraryService } from '../../../../../src/host/services/library/libraryService';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string, logger: Logger = makeLogger()): ToolContext {
  return {
    sessionId: 'sess-1',
    workingDir,
    abortSignal: new AbortController().signal,
    logger,
    emit: () => void 0,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('library_add and app-data discovery refusal', () => {
  let root: string;
  let dataDir: string;
  let incoming: string;
  let logger: Logger;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-add-'));
    dataDir = path.join(root, 'data');
    incoming = path.join(root, 'incoming');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(incoming, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{"library":false}\n');
    fs.writeFileSync(path.join(dataDir, '.env'), 'SECRET=do-not-leak\n');
    fs.mkdirSync(path.join(dataDir, 'library'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'library', 'note.txt'), 'hello from library\n');
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    rawDb = new Database(':memory:');
    applySchema(rawDb, makeLogger() as never);
    projectId = 'proj_1';
    logger = makeLogger();
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_DATA_DIR;
    rawDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function add(args: Record<string, unknown>, canUseTool: CanUseToolFn = allowAll) {
    const handler = await libraryAddModule.createHandler();
    return handler.execute(args, makeCtx(incoming, logger), canUseTool);
  }

  function writeIncoming(name: string, content: string | Buffer): string {
    const file = path.join(incoming, name);
    fs.writeFileSync(file, content);
    return file;
  }

  it('copies the file into the Library and list shows it', async () => {
    const source = writeIncoming('cadence.md', '# cadence\n- ship monthly\n');
    const calls: unknown[][] = [];
    const canUse: CanUseToolFn = async (...args) => {
      calls.push(args);
      return { allow: true };
    };
    const result = await add({ file_path: source, tags: ['memo', 'plans/secret'] }, canUse);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toBe('Saved "cadence.md" to the Library. It is visible in the Library panel.');
    expect(result.output).not.toContain(dataDir);
    expect(result.output).not.toContain(incoming);
    const items = getLibraryService().list({ projectId: 'proj_1' });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('cadence.md');
    expect(items[0]?.tags).toEqual(['memo']);
    expect(items[0]?.sourceSessionId).toBe('sess-1');
    expect(fs.readFileSync(items[0]!.pathOrUri, 'utf8')).toBe('# cadence\n- ship monthly\n');
    expect(JSON.stringify(calls)).not.toContain(dataDir);
    expect(JSON.stringify(calls)).not.toContain(source);
    expect(calls[0]?.[0]).toBe('library_add');
    expect(calls[0]?.[1]).toEqual({ title: 'cadence.md' });
  });

  it('uses the requested title and dedupes the same bytes', async () => {
    const first = writeIncoming('a.md', 'same-bytes');
    const named = await add({ file_path: first, title: 'Next quarter' });
    expect(named.ok && named.output).toContain('Saved "Next quarter"');
    const second = writeIncoming('b.md', 'same-bytes');
    const again = await add({ file_path: second });
    expect(again.ok && again.output).toContain('Saved "Next quarter"');
    const items = getLibraryService().list({ projectId: 'proj_1' });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Next quarter');
    const stored = fs.readdirSync(path.join(dataDir, 'library', 'proj_1')).filter((name) => name !== '.extracted');
    expect(stored).toHaveLength(1);
  });

  it('says the item was saved when its text cannot be read', async () => {
    const source = writeIncoming('blob.bin', Buffer.from([0, 1, 2, 3]));
    const result = await add({ file_path: source });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('Saved "blob.bin"');
    expect(result.output).toContain('text could not be read');
    expect(result.output).toContain('Library panel');
    expect(getLibraryService().list({ projectId: 'proj_1' })[0]?.learnStatus).toBe('failed');
  });

  it('refuses an empty file and does not ask for approval', async () => {
    const source = writeIncoming('empty.md', '');
    const canUse = vi.fn(allowAll);
    const result = await add({ file_path: source }, canUse);
    expect(result).toMatchObject({
      ok: false,
      code: 'EMPTY_FILE',
    });
    if (result.ok) return;
    expect(result.error).toContain('Open the Library panel and upload it.');
    expect(result.error).not.toContain(source);
    expect(canUse).not.toHaveBeenCalled();
    expect(getLibraryService().list({ projectId: 'proj_1' })).toHaveLength(0);
  });

  it('refuses a missing file without repeating the path', async () => {
    const missing = path.join(incoming, 'nope.md');
    const result = await add({ file_path: missing });
    expect(result).toMatchObject({ ok: false, code: 'FILE_NOT_FOUND' });
    if (result.ok) return;
    expect(result.error).toContain('Library panel');
    expect(result.error).not.toContain(missing);
  });

  it('refuses a file over the 50MB limit', async () => {
    const source = path.join(incoming, 'huge.bin');
    const fd = fs.openSync(source, 'w');
    fs.ftruncateSync(fd, 50 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    const result = await add({ file_path: source });
    expect(result).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' });
    if (result.ok) return;
    expect(result.error).toContain('Library panel');
    expect(result.error).not.toContain(dataDir);
    expect(getLibraryService().list({ projectId: 'proj_1' })).toHaveLength(0);
  });

  it('refuses a source inside the app data folder', async () => {
    const inside = path.join(dataDir, 'config.json');
    const nested = path.join(dataDir, 'library', 'note.txt');
    const canUse = vi.fn(allowAll);
    const rootFile = await add({ file_path: inside }, canUse);
    const nestedFile = await add({ file_path: nested }, canUse);
    expect(rootFile).toMatchObject({ ok: false, code: 'DATA_DIR_SOURCE' });
    expect(nestedFile).toMatchObject({ ok: false, code: 'DATA_DIR_SOURCE' });
    if (!rootFile.ok) expect(rootFile.error).not.toContain(dataDir);
    expect(canUse).not.toHaveBeenCalled();
    expect(getLibraryService().list()).toHaveLength(0);
  });

  it('does not copy when approval is denied', async () => {
    const source = writeIncoming('cadence.md', 'keep me out');
    const result = await add({ file_path: source }, async () => ({ allow: false, reason: 'no' }));
    expect(result).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(getLibraryService().list({ projectId: 'proj_1' })).toHaveLength(0);
  });

  it('approval preview names the file and not its path', () => {
    const preview = new ConfirmationGate().buildPreview('library_add', {
      file_path: path.join(dataDir, 'config.json'),
      title: 'Quarter memo',
    });
    expect(preview).toMatchObject({ type: 'generic', summary: 'library_add', diff: 'Quarter memo' });
    expect(JSON.stringify(preview)).not.toContain(dataDir);
  });

  async function discover(
    tool: 'ListDirectory' | 'Glob' | 'Grep',
    target: string | undefined,
    workingDir = incoming,
    grepPattern = 'SECRET',
  ) {
    const ctx = makeCtx(workingDir, logger);
    if (tool === 'ListDirectory') {
      const handler = await listDirectoryModule.createHandler();
      return handler.execute(target === undefined ? {} : { path: target }, ctx, allowAll);
    }
    if (tool === 'Glob') {
      const handler = await globModule.createHandler();
      return handler.execute(target === undefined ? { pattern: '**/*' } : { pattern: '**/*', path: target }, ctx, allowAll);
    }
    const handler = await grepModule.createHandler();
    return handler.execute(
      target === undefined ? { pattern: grepPattern } : { pattern: grepPattern, path: target },
      ctx,
      allowAll,
    );
  }

  it.each(['ListDirectory', 'Glob', 'Grep'] as const)(
    '%s refuses the data dir root, config.json, and .env',
    async (tool) => {
      for (const target of [dataDir, path.join(dataDir, 'config.json'), path.join(dataDir, '.env')]) {
        const result = await discover(tool, target);
        expect(result.ok, target).toBe(false);
        if (result.ok) continue;
        expect(result.code).toBe('APP_DATA_DISCOVERY_REFUSED');
        expect(result.error).toContain('library_add');
        expect(result.error).toContain('Library panel');
        expect(result.error).not.toContain(dataDir);
        expect(result.error).not.toContain('SECRET');
        expect(result.error).not.toContain('config.json');
      }
      expect(logger.info).toHaveBeenCalledWith('APP_DATA_DISCOVERY_REFUSED', { code: 'APP_DATA_DISCOVERY_REFUSED' });
    },
  );

  it.each(['ListDirectory', 'Glob', 'Grep'] as const)(
    '%s refuses the data dir when it is the working folder and no path is given',
    async (tool) => {
      const result = await discover(tool, undefined, dataDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('APP_DATA_DISCOVERY_REFUSED');
      expect(result.error).not.toContain(dataDir);
    },
  );

  it.each(['ListDirectory', 'Glob', 'Grep'] as const)(
    '%s still reads a subfolder of the data dir',
    async (tool) => {
      const libraryDir = path.join(dataDir, 'library');
      const result = await discover(tool, libraryDir, incoming, 'hello');
      expect(result.ok, tool).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('note.txt');
      expect(result.output).not.toContain('SECRET');
    },
  );
});
