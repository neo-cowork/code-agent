// N-FIX-APPDATA-DISCOVERY-GLOB-GREP-PATTERN-BYPASS
// Glob/Grep started from a parent folder (stand-in for ~) must not list or
// search the app data dir root or the regular files directly in it
// (config.json, .env), while subfolders (library/) stay readable — including
// through symlinks that resolve into the data dir root.
// Entries are the production handlers (globModule/grepModule createHandler),
// with CODE_AGENT_DATA_DIR pointing at a temp .code-agent inside a temp home.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { globModule } from '../../../../../src/host/tools/modules/file/glob';
import { grepModule, __setRgBinaryPathForTest } from '../../../../../src/host/tools/modules/shell/grep';

const ROOT_SECRET = 'ROOTSECRET_Q7Z9';
const ENV_SECRET = 'ENVSECRET_W3X8';
const LIB_NOTE = 'LIBNOTE_M4N6';
const PLAIN_NOTE = 'PLAINNOTE_P2R5';
const ELSEWHERE_SECRET = 'ELSESECRET_K2L4';
const GREP_PATTERN = `${ROOT_SECRET}|${ENV_SECRET}|${LIB_NOTE}|${PLAIN_NOTE}|${ELSEWHERE_SECRET}`;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: 'sess-appdata-traversal',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

async function runGlob(args: Record<string, unknown>, workingDir: string) {
  const handler = await globModule.createHandler();
  return handler.execute(args, makeCtx(workingDir), allowAll);
}

async function runGrep(args: Record<string, unknown>, workingDir: string) {
  const handler = await grepModule.createHandler();
  return handler.execute(args, makeCtx(workingDir), allowAll);
}

function listedMatches(result: Awaited<ReturnType<typeof runGlob>>): string[] {
  return (result.meta?.matches as string[] | undefined) ?? [];
}

function grepMatchFiles(result: Awaited<ReturnType<typeof runGrep>>): string[] {
  return ((result.meta?.matches as { file: string }[] | undefined) ?? []).map((m) => m.file);
}

describe('app-data root files hidden during parent-folder traversal', () => {
  let home: string;
  let dataDir: string;
  let elsewhere: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'appdata-home-'));
    dataDir = path.join(home, '.code-agent');
    fs.mkdirSync(path.join(dataDir, 'library'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      `{\n  "pre": "before",\n  "token": "${ROOT_SECRET}",\n  "post": "after"\n}\n`,
    );
    fs.writeFileSync(path.join(dataDir, '.env'), `KEY=${ENV_SECRET}\n`);
    fs.writeFileSync(path.join(dataDir, 'library', 'note.md'), `${LIB_NOTE} hello\n`);
    fs.writeFileSync(path.join(home, 'plain.md'), `${PLAIN_NOTE} hello\n`);
    // Symlink bypass attempts: one straight at a root file, one at the data dir.
    fs.symlinkSync(path.join('.code-agent', 'config.json'), path.join(home, 'configlink'));
    fs.symlinkSync('.code-agent', path.join(home, 'link'));
    // Control tree outside any data dir.
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'appdata-elsewhere-'));
    fs.mkdirSync(path.join(elsewhere, 'proj'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'proj', 'config.json'), `{"token":"${ELSEWHERE_SECRET}"}\n`);

    process.env.CODE_AGENT_DATA_DIR = dataDir;
    __setRgBinaryPathForTest(undefined);
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_DATA_DIR;
    __setRgBinaryPathForTest(undefined);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  describe('Glob from the parent folder', () => {
    it('pattern .code-agent/* returns no root file', async () => {
      const result = await runGlob({ pattern: '.code-agent/*', path: home }, home);
      expect(result.ok).toBe(true);
      expect(result.meta?.totalMatches).toBe(0);
      expect(listedMatches(result)).toEqual([]);
      expect(result.output).not.toContain('config.json');
    });

    it('pattern **/.code-agent/** keeps library/ but drops root files', async () => {
      const result = await runGlob({ pattern: '**/.code-agent/**', path: home }, home);
      expect(result.ok).toBe(true);
      expect(listedMatches(result)).toEqual(['.code-agent/library/note.md']);
      expect(result.meta?.totalMatches).toBe(1);
      expect(result.output).not.toContain('config.json');
      expect(result.output).not.toContain('.env');
    });

    it('pattern * drops symlinks that resolve into the data dir', async () => {
      const result = await runGlob({ pattern: '*', path: home }, home);
      expect(result.ok).toBe(true);
      expect(listedMatches(result)).toEqual(['plain.md']);
      expect(result.output).not.toContain('link');
    });

    it('pattern link/* and link/**/* do not surface root files through the symlinked dir', async () => {
      const direct = await runGlob({ pattern: 'link/*', path: home }, home);
      expect(direct.ok).toBe(true);
      expect(direct.meta?.totalMatches).toBe(0);
      expect(direct.output).not.toContain('config.json');

      const deep = await runGlob({ pattern: 'link/**/*', path: home }, home);
      expect(deep.ok).toBe(true);
      expect(listedMatches(deep)).toEqual(['link/library/note.md']);
      expect(deep.output).not.toContain('config.json');
    });

    it('pattern configlink (symlink at a root file) returns nothing', async () => {
      const result = await runGlob({ pattern: 'configlink', path: home }, home);
      expect(result.ok).toBe(true);
      expect(result.meta?.totalMatches).toBe(0);
    });

    it('leaves results unchanged when the data dir is not under the search path', async () => {
      const result = await runGlob({ pattern: '**/*', path: elsewhere }, home);
      expect(result.ok).toBe(true);
      expect(listedMatches(result)).toEqual(['proj/config.json']);
      expect(result.meta?.totalMatches).toBe(1);
    });
  });

  describe('Grep from the parent folder', () => {
    it('system-grep fallback: no include — finds library/ note, never the root files', async () => {
      __setRgBinaryPathForTest(null);
      const result = await runGrep({ pattern: GREP_PATTERN, path: home }, home);
      expect(result.ok).toBe(true);
      expect(result.meta?.engine).toBe('grep');
      expect(result.output).toContain('note.md');
      expect(result.output).toContain('plain.md');
      expect(result.output).not.toContain('config.json');
      expect(result.output).not.toContain('.env');
      expect(result.output).not.toContain(ROOT_SECRET);
      expect(result.output).not.toContain(ENV_SECRET);
      expect(grepMatchFiles(result).every((f) => !f.endsWith('config.json'))).toBe(true);
    });

    it('system-grep fallback: include * — same filtering', async () => {
      __setRgBinaryPathForTest(null);
      const result = await runGrep({ pattern: GREP_PATTERN, path: home, include: '*' }, home);
      expect(result.ok).toBe(true);
      expect(result.meta?.engine).toBe('grep');
      expect(result.output).toContain('note.md');
      expect(result.output).not.toContain('config.json');
      expect(result.output).not.toContain(ROOT_SECRET);
      expect(result.output).not.toContain(ENV_SECRET);
    });

    it('system-grep fallback: context lines of a root file are dropped too', async () => {
      __setRgBinaryPathForTest(null);
      const result = await runGrep({ pattern: GREP_PATTERN, path: home, context: 2 }, home);
      expect(result.ok).toBe(true);
      expect(result.meta?.engine).toBe('grep');
      expect(result.output).toContain('note.md');
      // config.json is multi-line: unfiltered context output would emit
      // "config.json-N-<ctx>" lines naming the root file.
      expect(result.output).not.toContain('config.json');
      expect(result.output).not.toContain(ROOT_SECRET);
      expect(result.output).not.toContain('"pre": "before"');
      expect(result.output).not.toContain('"post": "after"');
    });

    it('rg engine: include * still filters root files and keeps library/', async () => {
      const result = await runGrep({ pattern: GREP_PATTERN, path: home, include: '*' }, home);
      expect(result.ok).toBe(true);
      expect(result.output).toContain('note.md');
      expect(result.output).not.toContain('config.json');
      expect(result.output).not.toContain(ROOT_SECRET);
      expect(result.output).not.toContain(ENV_SECRET);
      expect(grepMatchFiles(result).every((f) => !f.endsWith('config.json'))).toBe(true);
    });

    it('grep through a symlinked search root filters by canonical path', async () => {
      __setRgBinaryPathForTest(null);
      const plink = path.join(os.tmpdir(), `appdata-plink-${process.pid}-${Date.now()}`);
      fs.symlinkSync(home, plink);
      try {
        // Trailing slash: BSD grep -r only follows a symlinked search root when
        // the arg ends in '/'; rg follows it either way. Result lines then name
        // "plink/.code-agent/config.json" — filtered only via realpath.
        const result = await runGrep({ pattern: GREP_PATTERN, path: `${plink}/` }, home);
        expect(result.ok).toBe(true);
        expect(result.output).toContain('note.md');
        expect(result.output).not.toContain('config.json');
        expect(result.output).not.toContain(ROOT_SECRET);
        expect(result.output).not.toContain(ENV_SECRET);
      } finally {
        fs.rmSync(plink, { force: true });
      }
    });

    it('rg through a symlinked search root with include * filters by canonical path', async () => {
      const rgAvailable = [
        '/opt/homebrew/bin/rg',
        '/usr/local/bin/rg',
        `${os.homedir()}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin/rg`,
        `${os.homedir()}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-darwin/rg`,
        `${os.homedir()}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-linux/rg`,
        '/usr/bin/rg',
      ].some((candidate) => fs.existsSync(candidate));
      if (!rgAvailable) return;
      const plink = path.join(os.tmpdir(), `appdata-plink-${process.pid}-${Date.now()}`);
      fs.symlinkSync(home, plink);
      try {
        const result = await runGrep({ pattern: GREP_PATTERN, path: plink, include: '*' }, home);
        expect(result.ok).toBe(true);
        expect(result.meta?.engine).toBe('rg');
        expect(result.output).toContain('note.md');
        expect(result.output).not.toContain('config.json');
        expect(result.output).not.toContain(ROOT_SECRET);
        expect(result.output).not.toContain(ENV_SECRET);
      } finally {
        fs.rmSync(plink, { force: true });
      }
    });

    it('leaves results unchanged when the data dir is not under the search path', async () => {
      __setRgBinaryPathForTest(null);
      const result = await runGrep({ pattern: GREP_PATTERN, path: elsewhere }, home);
      expect(result.ok).toBe(true);
      expect(result.output).toContain('config.json');
      expect(result.output).toContain(ELSEWHERE_SECRET);
    });
  });
});
