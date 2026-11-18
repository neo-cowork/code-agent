// ============================================================================
// binaryNotText — 共享的「二进制不能当文本读」守卫
//
// 图片/PDF 等按 UTF-8 解码会得到数万字符乱码并永久留在上下文里。
// Read、Blob read_text、ACP readTextFile 共用本模块：只返回短重定向，不解码。
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

const SNIFF_BYTES = 16;

/** 无后缀/改名文件的魔数兜底：前 16 字节。返回等价后缀。 */
function sniffExtension(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return '.gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return '.pdf';
  return null;
}

/** 仅按后缀判定；命中返回短拒绝结果，否则 null。 */
export function binaryRefusalForExtension(filePath: string, ext: string = path.extname(filePath).toLowerCase(), extraHint = ''): ToolResult<string> | null {
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      error: `Cannot read ${ext} file as text. ${IMAGE_READ_HINT}${extraHint}\nPath: ${filePath}`,
      code: 'BINARY_FILE_NOT_TEXT',
    };
  }
  const hint = BINARY_REDIRECTS[ext];
  if (hint) {
    return {
      ok: false,
      error: `Cannot read ${ext} file as text — binary content will be garbled. Use ${hint} tool instead.\nPath: ${filePath}`,
      code: 'BINARY_FILE_NOT_TEXT',
    };
  }
  return null;
}

/** 后缀 + 魔数；只读前 16 字节。读不到（不存在等）一律放行，交给调用方的原有错误路径。 */
export async function guardBinaryNotText(filePath: string, extraHint = ''): Promise<ToolResult<string> | null> {
  const byExt = binaryRefusalForExtension(filePath, undefined, extraHint);
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
  return sniffed ? binaryRefusalForExtension(filePath, sniffed, extraHint) : null;
}
