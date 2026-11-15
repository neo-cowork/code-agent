import fs from 'fs/promises';
import path from 'path';

/**
 * response_contains 的 `text_from_json: { path, field }`：期望文本取自被测工作目录里
 * 某个 JSON 文件的顶层字段（例如 package.json 的 version），答案不再写死会过期的值。
 * 文件缺失 / 越出工作目录 / 字段不是非空字符串或数字，一律抛错，由调用方记为未通过。
 */
export async function readExpectedTextFromJson(
  source: unknown,
  workingDirectory: string,
): Promise<string> {
  const record = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>;
  const relativePath = record.path;
  const field = record.field;
  if (typeof relativePath !== 'string' || !relativePath || typeof field !== 'string' || !field) {
    throw new Error('text_from_json requires non-empty string "path" and "field"');
  }

  const root = path.resolve(workingDirectory);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`text_from_json path escapes the working directory: ${relativePath}`);
  }

  const parsed: unknown = JSON.parse(await fs.readFile(target, 'utf8'));
  const value = parsed && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)[field]
    : undefined;
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`text_from_json field "${field}" in ${relativePath} is not a non-empty string or number`);
  }
  return value;
}
