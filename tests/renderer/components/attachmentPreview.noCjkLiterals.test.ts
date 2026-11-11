import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// N-FIX-ATTACHMENT-ONLY-SEND-MISSING-PROMPT-FU1：附件卡的用户可见文案一律走
// src/renderer/i18n/attachmentPreview.ts。该守卫防止 AttachmentPreview.tsx 重新
// 长出裸 CJK 字面量（JSX 文本 / 字符串返回值）。注释不算——只查去掉注释后的正文。
const here = dirname(fileURLToPath(import.meta.url));
const componentPath = resolve(
  here,
  '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview.tsx',
);
const utilsPath = resolve(here, '../../../src/renderer/components/features/chat/MessageBubble/utils.ts');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function cjkLines(stripped: string): Array<{ no: number; line: string }> {
  return stripped
    .split('\n')
    .map((line, index) => ({ no: index + 1, line: line.trim() }))
    .filter(({ line }) => /[一-鿿]/.test(line));
}

describe('AttachmentPreview CJK literal guard (N-FIX-ATTACHMENT-ONLY-SEND-MISSING-PROMPT-FU1)', () => {
  it('AttachmentPreview.tsx has no CJK outside comments (appshot suffix regex excepted)', () => {
    const offenders = cjkLines(stripComments(readFileSync(componentPath, 'utf8')))
      // 唯一豁免：Appshot 文件名后缀匹配正则（/\s*(截图|screenshot)\.png$/i）——
      // 它匹配用户文件名，不是展示文案，无法搬进 i18n。
      .filter(({ line }) => !line.includes('(截图|screenshot)'));
    expect(
      offenders,
      '裸 CJK 回流到 AttachmentPreview.tsx：用户可见文案请进 src/renderer/i18n/attachmentPreview.ts（zh/en 同文件维护）；若确属豁免场景，请在守卫里显式记录理由',
    ).toEqual([]);
  });

  it('MessageBubble/utils.ts keeps no CJK at all (categoryLabels 已删，勿回填中文标签表)', () => {
    const offenders = cjkLines(stripComments(readFileSync(utilsPath, 'utf8')));
    expect(
      offenders,
      'MessageBubble/utils.ts 出现裸 CJK：附件分类/类型标签请用 src/renderer/i18n/attachmentPreview.ts 的 category*/type* 键',
    ).toEqual([]);
  });
});
