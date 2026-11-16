// 工具错误码补登记（N-UX-HUMAN-LANGUAGE-CORPUS-AUDIT-FU1）：每个新 code 的 zh/en 人话文案。
import { describe, expect, it } from 'vitest';
import { humanizeToolError } from '../../../src/renderer/utils/toolExecutionPresentation';
import { toolErrorCodesZh, toolErrorCodesEn } from '../../../src/renderer/i18n/toolErrorCodes';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const NEW_CODES = [
  'BINARY_FILE_NOT_TEXT',
  'MAIL_CONNECTOR_FAILED',
  'ARG_VALIDATION_FAILED',
  'STALE_FILE',
  'READ_DIGEST_MISMATCH',
  'READ_REQUIRED_AFTER_SEARCH',
] as const;

const RAW = 'Cannot read .pdf file as text — binary content will be garbled. Use read_pdf tool instead.\nPath: /tmp/contract.pdf';

describe('newly registered tool error codes', () => {
  it.each(NEW_CODES)('%s has zh and en copy with no leftover placeholder or tool name', (code) => {
    for (const [t, bundle] of [[zh, toolErrorCodesZh], [en, toolErrorCodesEn]] as const) {
      const humanized = humanizeToolError(RAW, 'Read', t, { code });
      expect(humanized?.summary).toBe(bundle[code].summary);
      expect(humanized?.detail).toBe(bundle[code].detail);
      expect(humanized?.summary.length).toBeGreaterThan(0);
      expect(`${humanized?.summary}${humanized?.detail}`).not.toMatch(/[{}]|read_pdf|Read\b|undefined|rephras|换个说法/);
    }
  });

  it('binary-file copy does not blame the user in zh', () => {
    const humanized = humanizeToolError(RAW, 'Read', zh, { code: 'BINARY_FILE_NOT_TEXT' });
    expect(humanized?.summary).toBe('这类文件不能当纯文本直接读取');
  });
});
