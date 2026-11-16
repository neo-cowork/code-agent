import { describe, expect, it } from 'vitest';
import { permissionNotice, toolUserLabel } from '../../../src/shared/utils/toolUserLabel';
import { getBackgroundTaskToolLabel, getHumanToolLabel } from '../../../src/renderer/utils/toolHumanLabel';
import { describeApproval } from '../../../src/renderer/components/PermissionDialog/describeApproval';
import { getPermissionConfig } from '../../../src/renderer/components/PermissionDialog/utils';
import type { PermissionRequest } from '../../../src/renderer/components/PermissionDialog/types';
import { en, zh } from '../../../src/renderer/i18n';

// Shapes emitted by ToolExecutor.buildPermissionRequest / computer-use / browser modules.
// Read-level tools without a file target deliberately retain their generic question.
const cases: Array<{
  aliases: string[];
  type: PermissionRequest['type'];
  details: PermissionRequest['details'];
  zh: string;
  en: string;
}> = [
  { aliases: ['Bash', 'bash', 'BASH'], type: 'command', details: { command: 'ls -la' }, zh: '运行命令', en: 'Run command' },
  { aliases: ['Write', 'write', 'write_file', 'write-file', 'WriteFile'], type: 'file_write', details: { path: 'notes.txt' }, zh: '写入文件', en: 'Write file' },
  { aliases: ['Edit', 'edit', 'edit_file', 'edit-file', 'EditFile'], type: 'file_edit', details: { path: 'notes.txt' }, zh: '编辑文件', en: 'Edit file' },
  { aliases: ['Read', 'read', 'read_file', 'read-file', 'ReadFile'], type: 'file_read', details: { path: 'notes.txt' }, zh: '读取文件', en: 'Read file' },
  { aliases: ['Glob', 'glob'], type: 'file_read', details: {}, zh: '查找文件', en: 'Find files' },
  { aliases: ['Grep', 'grep'], type: 'file_read', details: {}, zh: '搜索内容', en: 'Search contents' },
  { aliases: ['web_fetch', 'WebFetch', 'web-fetch'], type: 'network', details: { url: 'https://example.com' }, zh: '网页抓取', en: 'Web fetch' },
  { aliases: ['web_search', 'WebSearch', 'web-search'], type: 'network', details: {}, zh: '联网搜索', en: 'Web search' },
  { aliases: ['memory_search', 'MemorySearch', 'memory-search'], type: 'file_read', details: {}, zh: '记忆检索', en: 'Memory search' },
  { aliases: ['browser_action', 'BrowserAction', 'browser-action'], type: 'command', details: { action: 'click' }, zh: '浏览器操作', en: 'Browser action' },
  { aliases: ['computer_use', 'ComputerUse', 'computer-use'], type: 'command', details: { targetApp: { name: 'Notes' } }, zh: '电脑操作', en: 'Computer action' },
];

for (const language of ['zh', 'en'] as const) {
  const t = language === 'zh' ? zh : en;
  describe(`tool action consistency gate (${language})`, () => {
    for (const entry of cases) {
      it.each(entry.aliases)('%s: notification / parked inbox / approval / receipt / background', (tool) => {
        const expected = entry[language];
        const request: PermissionRequest = { id: 'approval', tool, type: entry.type, details: entry.details };
        expect(toolUserLabel(tool, language)).toBe(expected);
        expect(getHumanToolLabel({ toolName: tool, labels: t.receiptPresentation.humanToolLabels })).toBe(expected);
        expect(getBackgroundTaskToolLabel({ toolName: tool, labels: t.receiptPresentation.humanToolLabels })).toBe(expected);
        expect(describeApproval(request, t, language).title).toBe(expected);
        if (language === 'zh') expect(permissionNotice(tool, 'zh').body).toBe(`需要授权：${expected}`);
      });
    }
    it('file and command translation/configuration consumers share the canonical names', () => {
      const p = t.decisionCard.permission;
      expect(p.titleFileRead).toBe(toolUserLabel('Read', language));
      expect(p.titleFileWrite).toBe(toolUserLabel('Write', language));
      expect(p.titleFileEdit).toBe(toolUserLabel('Edit', language));
      for (const [type, tool] of [['command', 'Bash'], ['file_read', 'Read'], ['file_write', 'Write'], ['file_edit', 'Edit']] as const) {
        expect(getPermissionConfig(type, language).title).toBe(toolUserLabel(tool, language));
      }
      expect(p.titleFileDelete).toBe(language === 'zh' ? '删除文件' : 'Delete file');
      expect(p.questionCommand).toBe(language === 'zh' ? '允许执行这条命令？' : 'Allow running this command?');
    });
    it('preserves unknown and non-action permission fallbacks', () => {
      expect(toolUserLabel('unregistered_tool', language)).toBe(language === 'zh' ? '操作' : 'Action');
      expect(getHumanToolLabel({ toolName: 'unregistered_tool', labels: t.receiptPresentation.humanToolLabels })).toBe('unregistered_tool');
      const request: PermissionRequest = { id: 'unknown', tool: 'unregistered_tool', type: 'command', details: {} };
      expect(describeApproval(request, t, language).title).toBe(t.decisionCard.permission.genericApprovalTitle);
      expect(describeApproval({ ...request, tool: 'Bash', type: 'dangerous_command', details: { command: 'rm notes.txt' } }, t, language).title).toBe(getPermissionConfig('dangerous_command', language).title);
    });
  });
}
