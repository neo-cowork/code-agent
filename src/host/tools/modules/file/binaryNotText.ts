// ============================================================================
// binaryNotText — 共享的「二进制不能当文本读」守卫
//
// 图片/PDF/压缩包/音视频/wasm/数据库/原生二进制按 UTF-8 解码会得到数万字符乱码
// 并永久留在上下文里。Read、Blob read_text、ACP readTextFile 共用本模块：
// 只返回短重定向，不解码。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolResult } from '../../../protocol/tools';

const BINARY_REDIRECTS: Record<string, string> = {
  '.xlsx': 'read_xlsx',
  '.xls': 'read_xlsx',
  '.docx': 'read_docx',
  '.pdf': 'read_pdf',
  '.pptx': 'read_file 不支持此格式',
};

/** 图片按文本读会得到数十万字符乱码并永久留在历史里；改为短重定向。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const IMAGE_READ_HINT =
  'This is an image, not text. For what is on a web page use browser_action get_content / get_dom_snapshot; ' +
  'to understand a picture use image_analyze (a deferred tool: load it first with ToolSearch select:image_analyze).';

/**
 * 其余二进制后缀按类拒绝：每类一句短提示，只指路（真实可用的替代工具），
 * 绝不解码文件。刻意不含文本格式（.svg/.csv/.json/.txt/.md/.ts 等）。
 */
const BINARY_SUFFIX_CLASSES: ReadonlyArray<{ extensions: readonly string[]; hint: string }> = [
  {
    extensions: ['.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.bz2', '.xz'],
    hint: 'List its contents with Bash instead (unzip -l <file> / tar -tf <file>); never Read it.',
  },
  {
    extensions: ['.mp4', '.mov', '.mp3', '.wav', '.m4a', '.avi', '.mkv', '.webm'],
    hint: 'Use Blob stat for size/mime and Bash ffprobe (if installed) for duration/metadata.',
  },
  {
    extensions: ['.wasm'],
    hint: 'WebAssembly binary with no text form; Blob stat gives size/mime, Blob read_base64 a small byte slice.',
  },
  {
    extensions: ['.sqlite', '.sqlite3', '.db'],
    hint: 'Query it with Bash instead, e.g. sqlite3 <file> ".tables" then a SELECT.',
  },
  {
    extensions: ['.exe', '.dll', '.dylib', '.so', '.o'],
    hint: 'Use Blob stat for size/mime; do not Read.',
  },
];

const SUFFIX_CLASS_HINTS: ReadonlyMap<string, string> = new Map(
  BINARY_SUFFIX_CLASSES.flatMap(({ extensions, hint }) => extensions.map((ext) => [ext, hint] as const)),
);

const SNIFF_BYTES = 16;

/** 无后缀/改名文件的魔数兜底：前 16 字节。返回等价后缀。 */
function sniffExtension(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return '.gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return '.pdf';
  // zip（PK\x03\x04；无后缀/改名的 docx/xlsx 也会落到这里，按 zip 提示列出内容即可）
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return '.zip';
  // gzip
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return '.gz';
  // mp4/mov：ftyp box。要求头两字节是 box 长度的高位零，避免命中「第 4 字节起恰好是 ftyp」的纯文本
  if (head.length >= 8 && head[0] === 0x00 && head[1] === 0x00 && head.subarray(4, 8).toString('latin1') === 'ftyp') return '.mp4';
  // wasm（\0asm）
  if (head.length >= 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d) return '.wasm';
  // sqlite（"SQLite format 3\0" 恰好 16 字节）
  if (head.length >= 16 && head.subarray(0, 16).toString('latin1') === 'SQLite format 3\0') return '.sqlite';
  return null;
}

/**
 * 仅按后缀判定；命中返回短拒绝结果，否则 null。
 * imageExtraHint 只拼进图片分支：调用方（Blob）传的补充提示是图片语境，
 * 不能贴到压缩包/音视频等其它拒绝上。
 */
export function binaryRefusalForExtension(filePath: string, ext: string = path.extname(filePath).toLowerCase(), imageExtraHint = ''): ToolResult<string> | null {
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      error: `Cannot read ${ext} file as text. ${IMAGE_READ_HINT}${imageExtraHint}\nPath: ${filePath}`,
      code: 'BINARY_FILE_NOT_TEXT',
    };
  }
  const redirect = BINARY_REDIRECTS[ext];
  if (redirect) {
    return {
      ok: false,
      error: `Cannot read ${ext} file as text — binary content will be garbled. Use ${redirect} tool instead.\nPath: ${filePath}`,
      code: 'BINARY_FILE_NOT_TEXT',
    };
  }
  const classHint = SUFFIX_CLASS_HINTS.get(ext);
  if (classHint) {
    return {
      ok: false,
      error: `Cannot read ${ext} file as text — binary content will be garbled. ${classHint}\nPath: ${filePath}`,
      code: 'BINARY_FILE_NOT_TEXT',
    };
  }
  return null;
}

/** 后缀 + 魔数；只读前 16 字节。读不到（不存在等）一律放行，交给调用方的原有错误路径。 */
export async function guardBinaryNotText(filePath: string, imageExtraHint = ''): Promise<ToolResult<string> | null> {
  const byExt = binaryRefusalForExtension(filePath, undefined, imageExtraHint);
  if (byExt) return byExt;
  let head: Buffer;
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const sniffed = sniffExtension(head);
  return sniffed ? binaryRefusalForExtension(filePath, sniffed, imageExtraHint) : null;
}
