// ============================================================================
// Read × binaryNotText — 压缩包/音视频/wasm/数据库/原生二进制的短拒绝
//
// 走公开入口 readModule.createHandler().execute；suffix 路径（read.ts 的
// binaryRefusalForExtension）与魔数路径（guardBinaryNotText 兜底）分开钉。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { fileReadTracker } from '../../../../../src/host/tools/fileReadTracker';
import { readModule } from '../../../../../src/host/tools/modules/file/read';

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

// 魔数头（后接填充，超过 SNIFF_BYTES 才能证明只读了头 16 字节）
const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const GZIP_HEAD = Buffer.from([0x1f, 0x8b, 0x08]);
const MP4_HEAD = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const WASM_HEAD = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const SQLITE_HEAD = Buffer.from('SQLite format 3\0', 'latin1');

/** 文件本体标记：一旦错误文本里出现它，说明守卫把文件解码了。 */
const BODY_MARKER = 'NEVER-DECODE-BODY-MARKER';
const filler = () => Buffer.from(`${BODY_MARKER}-`.repeat(64), 'utf8');
const withHead = (head: Buffer) => Buffer.concat([head, filler()]);

async function readIt(name: string, data: Buffer) {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, data);
  const handler = await readModule.createHandler();
  return handler.execute({ file_path: file }, makeCtx(), allowAll);
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-binref-'));
  fileReadTracker.clear();
});

afterEach(async () => {
  fileReadTracker.clear();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Read refuses non-image binaries by suffix class (short hint, never decoded)', () => {
  it.each([
    // 每类至少一个后缀 + 大小写不敏感；每条都断言指路文案里的真实替代工具
    ['backup.zip', 'unzip -l'],
    ['backup.tgz', 'unzip -l'],
    ['backup.7z', 'tar -tf'],
    ['clip.mp4', 'ffprobe'],
    ['clip.mov', 'ffprobe'],
    ['song.mp3', 'Blob stat'],
    ['mod.wasm', 'read_base64'],
    ['app.sqlite', 'sqlite3'],
    ['app.db', 'sqlite3'],
    ['tool.exe', 'Blob stat'],
    ['lib.dylib', 'Blob stat'],
    ['lib.so', 'Blob stat'],
    ['BACKUP.ZIP', 'unzip -l'],
    ['SONG.MP3', 'ffprobe'],
  ])('%s -> BINARY_FILE_NOT_TEXT with a real alternative', async (name, tool) => {
    // 后缀路径：文件体故意是纯文本（无任何魔数），命中只能来自后缀判定
    const result = await readIt(name, filler());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('BINARY_FILE_NOT_TEXT');
      expect(result.error.length).toBeLessThan(500);
      expect(result.error).toContain(tool);
      expect(result.error).toContain(name);
      expect(result.error).not.toContain(BODY_MARKER);
      expect(result.error).not.toContain('�');
    }
  });

  it.each([
    // 每个魔数：无后缀 + 改名 .txt 两种形态
    ['zip-noext', withHead(ZIP_HEAD), 'unzip -l'],
    ['zip-renamed.txt', withHead(ZIP_HEAD), 'unzip -l'],
    ['gzip-noext', withHead(GZIP_HEAD), 'Bash'],
    ['gzip-renamed.txt', withHead(GZIP_HEAD), 'Bash'],
    ['mp4-noext', withHead(MP4_HEAD), 'ffprobe'],
    ['mp4-renamed.txt', withHead(MP4_HEAD), 'ffprobe'],
    ['wasm-noext', withHead(WASM_HEAD), 'read_base64'],
    ['wasm-renamed.txt', withHead(WASM_HEAD), 'read_base64'],
    ['sqlite-noext', withHead(SQLITE_HEAD), 'sqlite3'],
    ['sqlite-renamed.txt', withHead(SQLITE_HEAD), 'sqlite3'],
  ])('%s -> magic sniff refuses without decoding', async (name, data, tool) => {
    const result = await readIt(name, data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('BINARY_FILE_NOT_TEXT');
      expect(result.error.length).toBeLessThan(500);
      expect(result.error).toContain(tool);
      expect(result.error).toContain(name);
      expect(result.error).not.toContain(BODY_MARKER);
      expect(result.error).not.toContain('�');
    }
  });

  it('a real .docx keeps its read_docx redirect (extension check runs before the zip sniff)', async () => {
    // docx 本体就是 zip；必须先命中后缀重定向，而不是落到 zip 提示
    const result = await readIt('paper.docx', withHead(ZIP_HEAD));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('BINARY_FILE_NOT_TEXT');
      expect(result.error).toContain('read_docx');
    }
  });
});

describe('Read still reads text formats normally', () => {
  it.each([
    ['note.txt', 'plain note\nsecond line\n'],
    ['data.json', '{"kind": "note", "n": 1}\n'],
    ['icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n'],
    ['table.csv', 'a,b\n1,2\n'],
    ['README.md', '# title\n\nbody\n'],
  ])('%s is read as text', async (name, body) => {
    const result = await readIt(name, Buffer.from(body, 'utf8'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain(body.split('\n')[0]);
  });

  it('plain text starting with the letters "PK" is still read (zip magic needs the 03 04 bytes)', async () => {
    const result = await readIt('pk-prose.txt', Buffer.from('PK is a zip signature, but this file is plain prose.\n', 'utf8'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('plain prose');
  });

  it('plain text containing "ftyp" at offset 4 is still read (mp4 magic needs the leading size bytes)', async () => {
    const result = await readIt('ftyp-prose.txt', Buffer.from('0123ftyp8901 the rest is ordinary text.\n', 'utf8'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('ordinary text');
  });
});
