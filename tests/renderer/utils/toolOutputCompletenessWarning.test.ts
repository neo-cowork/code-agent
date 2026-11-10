import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { writeModule } from '../../../src/host/tools/modules/file/write';
import { editModule } from '../../../src/host/tools/modules/file/multiEdit';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import type { ToolContext, CanUseToolFn } from '../../../src/host/protocol/tools';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import {
  hasCompletenessIssues,
  replaceCompletenessWarningInOutput,
} from '../../../src/renderer/utils/toolOutputCompletenessWarning';

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: 'test-completeness-helper',
    agentId: 'test-agent',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    emit: () => {},
  };
}

describe('toolOutputCompletenessWarning', () => {
  it('replaces the AI-facing completeness warning block on a real Write result while keeping prefix intact', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completeness-write-'));
    try {
      const target = path.join(tmpDir, 'index.html');
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: target, content: '<!DOCTYPE html><html><body><div>hello' },
        makeCtx(tmpDir),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.output).toContain('⚠️ **代码完整性警告**');
      expect(result.output).toContain('edit_file');
      expect(result.output).toContain('重新生成完整文件');
      expect(hasCompletenessIssues(result.meta)).toBe(true);

      const zhCleaned = replaceCompletenessWarningInOutput(
        'Write',
        result.output,
        result.meta,
        zh.rendererHumanPipe.toolDetails.completenessWarningNote,
      );
      expect(zhCleaned).toContain('检测到文件可能没写完整。如果内容有缺，告诉 Neo「继续补全」即可。');
      expect(zhCleaned).toContain(`Created file: ${target}`);
      expect(zhCleaned).not.toContain('⚠️ **代码完整性警告**');
      expect(zhCleaned).not.toContain('edit_file');
      expect(zhCleaned).not.toContain('重新生成完整文件');

      const enCleaned = replaceCompletenessWarningInOutput(
        'Write',
        result.output,
        result.meta,
        en.rendererHumanPipe.toolDetails.completenessWarningNote,
      );
      expect(enCleaned).toContain(en.rendererHumanPipe.toolDetails.completenessWarningNote);
      expect(enCleaned).not.toContain('⚠️ **代码完整性警告**');
      expect(enCleaned).not.toContain('edit_file');
      expect(enCleaned).not.toContain('重新生成完整文件');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('replaces the AI-facing completeness warning block on a real Edit result', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completeness-edit-'));
    try {
      const target = path.join(tmpDir, 'config.json');
      await fs.writeFile(target, '{\n  "a": 1,\n  "b": 2\n}\n', 'utf-8');
      await fileReadTracker.recordReadWithStats(target);

      const handler = await editModule.createHandler();
      const result = await handler.execute(
        {
          file_path: target,
          edits: [{ old_text: '"a": 1,', new_text: '"a": 1' }],
        },
        makeCtx(tmpDir),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.output).toContain('⚠️ **代码完整性警告**');
      expect(result.output).toContain('重新生成完整文件');
      expect(hasCompletenessIssues(result.meta)).toBe(true);

      const zhCleaned = replaceCompletenessWarningInOutput(
        'Edit',
        result.output,
        result.meta,
        zh.rendererHumanPipe.toolDetails.completenessWarningNote,
      );
      expect(zhCleaned).toContain('检测到文件可能没写完整。如果内容有缺，告诉 Neo「继续补全」即可。');
      expect(zhCleaned).not.toContain('⚠️ **代码完整性警告**');
      expect(zhCleaned).not.toContain('重新生成完整文件');
      expect(zhCleaned).not.toContain('请再次使用 Edit 工具');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves output untouched when metadata has no completenessIssues', () => {
    const raw = 'Created file: /tmp/demo.ts (20 chars)\n\n⚠️ **代码完整性警告**: something';
    expect(replaceCompletenessWarningInOutput('Write', raw, undefined, 'REPLACED')).toBe(raw);
    expect(replaceCompletenessWarningInOutput('Edit', raw, { completenessIssues: [] }, 'REPLACED')).toBe(raw);
    expect(replaceCompletenessWarningInOutput('Bash', raw, { completenessIssues: ['issue'] }, 'REPLACED')).toBe(raw);
  });

  it('accepts completenessIssues from nested artifact metadata', () => {
    const raw = 'Created file: /tmp/demo.ts\n\n⚠️ **代码完整性警告**: hidden';
    const metadata = { artifact: { metadata: { completenessIssues: ['issue'] } } };
    expect(replaceCompletenessWarningInOutput('Write', raw, metadata, 'REPLACED')).toBe(
      'Created file: /tmp/demo.ts\n\nREPLACED',
    );
  });
});
