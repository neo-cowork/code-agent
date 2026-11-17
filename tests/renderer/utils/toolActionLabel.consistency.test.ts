import { describe, expect, it } from 'vitest';
import { permissionNotice, toolUserLabel } from '../../../src/shared/utils/toolUserLabel';
import { humanizeInternalText } from '../../../src/shared/humanizeInternalText';
import { describeApproval } from '../../../src/renderer/components/PermissionDialog/describeApproval';
import type { PermissionRequest } from '../../../src/renderer/components/PermissionDialog/types';
import { en, zh } from '../../../src/renderer/i18n';

// One action name per governed tool id on every user surface.
const governed: Array<{
  tool: string; voidedKey: string; receiptKey: string; card: boolean; internal?: string;
  type: PermissionRequest['type']; details: PermissionRequest['details'];
}> = [
  { tool: 'Bash', voidedKey: 'bash', receiptKey: 'runCommand', card: true, type: 'command', details: { command: 'ls -la' } },
  { tool: 'Write', voidedKey: 'write', receiptKey: 'writeFile', card: true, internal: 'write_file', type: 'file_write', details: { path: 'notes.txt' } },
  { tool: 'Edit', voidedKey: 'edit', receiptKey: 'editFile', card: true, internal: 'edit_file', type: 'file_edit', details: { path: 'notes.txt' } },
  { tool: 'Read', voidedKey: 'read', receiptKey: 'readFile', card: true, internal: 'read_file', type: 'file_read', details: { path: 'notes.txt' } },
  { tool: 'Glob', voidedKey: 'glob', receiptKey: 'findFiles', card: false, type: 'file_read', details: {} },
  { tool: 'Grep', voidedKey: 'grep', receiptKey: '', card: false, type: 'file_read', details: {} },
  { tool: 'web_fetch', voidedKey: 'webfetch', receiptKey: 'webFetch', card: false, internal: 'web_fetch', type: 'network', details: { url: 'https://example.com' } },
  { tool: 'web_search', voidedKey: 'websearch', receiptKey: 'webSearch', card: false, type: 'network', details: {} },
  { tool: 'memory_search', voidedKey: '', receiptKey: 'memorySearch', card: false, internal: 'memory_search', type: 'file_read', details: {} },
];

// Canonical copy pinned here: editing the shared table without updating this
// (and therefore every surface that reads it) is a deliberate, visible act.
const CANONICAL: Record<string, { zh: string; en: string }> = {
  Bash: { zh: '运行命令', en: 'Run command' }, Write: { zh: '写入文件', en: 'Write file' },
  Edit: { zh: '编辑文件', en: 'Edit file' }, Read: { zh: '读取文件', en: 'Read file' },
  Glob: { zh: '查找文件', en: 'Find files' }, Grep: { zh: '搜索内容', en: 'Search contents' },
  web_fetch: { zh: '网页抓取', en: 'Web fetch' }, web_search: { zh: '联网搜索', en: 'Web search' },
  memory_search: { zh: '记忆检索', en: 'Memory search' },
};

for (const language of ['zh', 'en'] as const) {
  const t = language === 'zh' ? zh : en;
  describe(`tool action name consistency (${language})`, () => {
    for (const g of governed) {
      it(`${g.tool}: notification / approval card / parked record / receipt / inline text`, () => {
        const expected = CANONICAL[g.tool][language];
        expect(toolUserLabel(g.tool, language)).toBe(expected);
        expect(permissionNotice(g.tool, language).body).toContain(expected);
        if (g.receiptKey) expect((t.receiptPresentation.humanToolLabels.tools as Record<string, string>)[g.receiptKey]).toBe(expected);
        if (g.voidedKey) {
          expect((t.cronCenter.parkedVoided.tools as Record<string, string>)[g.voidedKey]).toBe(expected);
        }
        if (g.card) {
          const request: PermissionRequest = { id: 'a', tool: g.tool, type: g.type, details: g.details };
          expect(describeApproval(request, t, language).title).toBe(expected);
        }
        if (g.internal) {
          expect(humanizeInternalText(`'${g.internal}'`, language).text).toContain(expected);
        }
      });
    }
    it('pending-approval status bar command label matches', () => {
      expect(t.automationPresentation.runCommand).toBe(CANONICAL.Bash[language]);
    });
  });
}
