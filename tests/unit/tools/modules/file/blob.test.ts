import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/host/protocol/tools';
import { blobModule } from '../../../../../src/host/tools/modules/file/blob';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: 'blob-test-session',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('blobModule', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blob-tool-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns unified artifact metadata for stat', async () => {
    const file = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(file, 'hello blob', 'utf8');
    const handler = await blobModule.createHandler();

    const result = await handler.execute({ action: 'stat', file_path: file }, makeCtx(tmpDir), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'text',
        sourceTool: 'Blob',
        path: file,
        mimeType: 'text/plain',
        sizeBytes: 10,
      });
      expect(result.output).toContain('"sha256"');
    }
  });

  it('reads a binary slice as base64 without losing artifact metadata', async () => {
    const file = path.join(tmpDir, 'sample.bin');
    await fs.writeFile(file, Buffer.from([0, 1, 2, 3, 4, 5]));
    const handler = await blobModule.createHandler();

    const result = await handler.execute(
      { action: 'read_base64', file_path: 'sample.bin', max_bytes: 4 },
      makeCtx(tmpDir),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('AAECAw==');
      expect(result.meta?.bytesRead).toBe(4);
      expect(result.meta?.truncated).toBe(true);
      expect(result.meta?.artifact).toMatchObject({ kind: 'binary', sourceTool: 'Blob' });
    }
  });

  describe('read_text refuses binary files (no garbage in context)', () => {
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(70 * 1024, 0xfe),
    ]);
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 0xfe)]);
    const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 0xfe)]);

    async function readText(name: string, data: Buffer) {
      const file = path.join(tmpDir, name);
      await fs.writeFile(file, data);
      const handler = await blobModule.createHandler();
      const result = await handler.execute({ action: 'read_text', file_path: file }, makeCtx(tmpDir), allowAll);
      return { file, result };
    }

    it.each([
      ['shot.png', PNG, 'image_analyze'],
      ['shot-noext', PNG, 'image_analyze'],
      ['shot-renamed.txt', PNG, 'image_analyze'],
      ['photo.jpg', JPEG, 'image_analyze'],
      ['photo-renamed.txt', JPEG, 'image_analyze'],
      ['doc.pdf', PDF, 'read_pdf'],
      ['doc-noext', PDF, 'read_pdf'],
    ])('%s is refused with a short hint', async (name, data, tool) => {
      const { file, result } = await readText(name, data);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('BINARY_FILE_NOT_TEXT');
        expect(result.error.length).toBeLessThan(1024);
        expect(result.error).toContain(file);
        expect(result.error).toContain(tool);
        expect(result.error).not.toContain('\uFFFD');
      }
    });

    it('still reads a normal UTF-8 text file', async () => {
      const { result } = await readText('note.txt', Buffer.from('你好 blob', 'utf8'));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('你好 blob');
    });

    it('read_base64 of a PNG still works', async () => {
      const file = path.join(tmpDir, 'b.png');
      await fs.writeFile(file, PNG);
      const handler = await blobModule.createHandler();
      const result = await handler.execute(
        { action: 'read_base64', file_path: file, max_bytes: 8 },
        makeCtx(tmpDir),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('iVBORw0KGgo=');
    });

    // ---- 压缩包/音视频/wasm/数据库/原生库（N-FIX-READ-OTHER-BINARY-AS-TEXT-GARBLE）----
    const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4096, 0xfe)]);
    const MP4 = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
      Buffer.alloc(4096, 0xfe),
    ]);
    const WASM = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.alloc(4096, 0xfe)]);
    const SQLITE = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(4096, 0xfe)]);
    const ELFISH = Buffer.alloc(4096, 0xfe); // 后缀路径不需要魔数

    it.each([
      ['backup.zip', ZIP, 'unzip -l'],
      ['backup-noext', ZIP, 'unzip -l'],
      ['backup-renamed.txt', ZIP, 'unzip -l'],
      ['clip.mp4', MP4, 'ffprobe'],
      ['clip-noext', MP4, 'ffprobe'],
      ['mod.wasm', WASM, 'read_base64'],
      ['mod-noext', WASM, 'read_base64'],
      ['app.sqlite', SQLITE, 'sqlite3'],
      ['db-noext', SQLITE, 'sqlite3'],
      ['lib.so', ELFISH, 'Blob stat'],
      ['tool.exe', ELFISH, 'Blob stat'],
    ])('%s is refused with a short non-image hint', async (name, data, tool) => {
      const { file, result } = await readText(name, data);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('BINARY_FILE_NOT_TEXT');
        expect(result.error.length).toBeLessThan(500);
        expect(result.error).toContain(file);
        expect(result.error).toContain(tool);
        expect(result.error).not.toContain('�');
        // 非图片拒绝不能带上图片语境的补充提示
        expect(result.error).not.toContain('stat still returns size/mime for images');
      }
    });

    it('image refusals still carry the image-specific Blob hint', async () => {
      const { result } = await readText('shot.png', PNG);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Blob stat still returns size/mime for images');
      }
    });

    it('read_base64 of a zip still works', async () => {
      const file = path.join(tmpDir, 'backup.zip');
      await fs.writeFile(file, ZIP);
      const handler = await blobModule.createHandler();
      const result = await handler.execute(
        { action: 'read_base64', file_path: file, max_bytes: 4 },
        makeCtx(tmpDir),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('UEsDB');
    });
  });
});
