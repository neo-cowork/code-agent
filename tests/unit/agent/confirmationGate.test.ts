// ============================================================================
// ConfirmationGate Tests [E2]
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as hostUiLocale from '../../../src/host/config/hostUiLocale';
import {
  ConfirmationGate,
  getConfirmationGate,
  resetConfirmationGate,
} from '../../../src/host/agent/confirmationGate';

describe('ConfirmationGate', () => {
  let gate: ConfirmationGate;

  beforeEach(() => {
    resetConfirmationGate();
    gate = new ConfirmationGate();
  });

  // --------------------------------------------------------------------------
  // shouldConfirm
  // --------------------------------------------------------------------------
  describe('shouldConfirm', () => {
    it('should not confirm read operations', () => {
      const result = gate.shouldConfirm(
        { toolName: 'read_file', params: { file_path: '/tmp/a.ts' }, riskLevel: 'low' },
        'session-1'
      );
      expect(result).toBe(false);
    });

    it('should not confirm medium-risk write operations with ask_if_dangerous', () => {
      // ask_if_dangerous 只在 riskLevel=high 时确认
      const result = gate.shouldConfirm(
        { toolName: 'write_file', params: { file_path: '/tmp/a.ts' }, riskLevel: 'medium' },
        'session-1'
      );
      expect(result).toBe(false);
    });

    it('should confirm high-risk write operations', () => {
      const result = gate.shouldConfirm(
        { toolName: 'write_file', params: { file_path: '/etc/passwd' }, riskLevel: 'high' },
        'session-1'
      );
      expect(result).toBe(true);
    });

    it('should confirm dangerous bash commands', () => {
      const result = gate.shouldConfirm(
        { toolName: 'bash', params: { command: 'rm -rf /' }, riskLevel: 'high' },
        'session-1'
      );
      expect(result).toBe(true);
    });

    it('should not confirm safe bash commands', () => {
      const result = gate.shouldConfirm(
        { toolName: 'bash', params: { command: 'ls -la' }, riskLevel: 'low' },
        'session-1'
      );
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Policy: always_approve
  // --------------------------------------------------------------------------
  describe('always_approve policy', () => {
    it('should skip confirmation for all tools', () => {
      const autoGate = new ConfirmationGate({ policy: 'always_approve' });
      const result = autoGate.shouldConfirm(
        { toolName: 'write_file', params: {}, riskLevel: 'high' },
        'session-1'
      );
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Policy: always_ask
  // --------------------------------------------------------------------------
  describe('always_ask policy', () => {
    it('should confirm even read operations', () => {
      const strictGate = new ConfirmationGate({ policy: 'always_ask' });
      const result = strictGate.shouldConfirm(
        { toolName: 'read_file', params: {}, riskLevel: 'low' },
        'session-1'
      );
      expect(result).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Session Approval Memory
  // --------------------------------------------------------------------------
  describe('Session Approval', () => {
    it('should remember session-level approvals', () => {
      const sessionGate = new ConfirmationGate({ policy: 'session_approve' });

      // 首次应该需要确认
      expect(
        sessionGate.shouldConfirm(
          { toolName: 'write_file', params: {}, riskLevel: 'medium' },
          'session-1'
        )
      ).toBe(true);

      // 记录批准
      sessionGate.recordApproval('session-1', 'write_file');

      // 同一会话不再需要确认
      expect(
        sessionGate.shouldConfirm(
          { toolName: 'write_file', params: {}, riskLevel: 'medium' },
          'session-1'
        )
      ).toBe(false);

      // 不同会话仍需确认
      expect(
        sessionGate.shouldConfirm(
          { toolName: 'write_file', params: {}, riskLevel: 'medium' },
          'session-2'
        )
      ).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Risk Assessment
  // --------------------------------------------------------------------------
  describe('assessRiskLevel', () => {
    it('should rate write_file as medium risk', () => {
      const level = gate.assessRiskLevel('write_file', { file_path: '/tmp/a.ts' });
      expect(level).toBe('medium');
    });

    it('should rate dangerous bash as high risk', () => {
      const level = gate.assessRiskLevel('bash', { command: 'rm -rf /important' });
      expect(level).toBe('high');
    });

    it('should rate read_file as low risk', () => {
      const level = gate.assessRiskLevel('read_file', {});
      expect(level).toBe('low');
    });
  });

  // --------------------------------------------------------------------------
  // buildPreview
  // --------------------------------------------------------------------------
  describe('buildPreview', () => {
    it('should build diff preview for edit_file', () => {
      const preview = gate.buildPreview('edit_file', {
        file_path: '/tmp/a.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      });
      expect(preview).toBeDefined();
      expect(preview!.type).toBe('diff');
      expect(preview!.summary).toBeTruthy();
    });

    // N-EDIT-RETRY-KEY-SHAPE — 注册的 Edit 参数形状（multiEdit.schema.ts）是
    // { file_path, edits: [{ old_text, new_text }] }，没有顶层 old_string/new_string。
    it('should build diff preview for a real Edit call with edits[]', () => {
      const preview = gate.buildPreview('Edit', {
        file_path: '/tmp/a.ts',
        edits: [{ old_text: 'const x = 1;', new_text: 'const x = 2;' }],
      });
      expect(preview).toBeDefined();
      expect(preview!.type).toBe('diff');
      expect(preview!.before).toContain('const x = 1;');
      expect(preview!.after).toContain('const x = 2;');
      expect(preview!.diff).toContain('-const x = 1;');
      expect(preview!.diff).toContain('+const x = 2;');
    });

    it('should build command preview for bash', () => {
      const preview = gate.buildPreview('bash', { command: 'npm install' });
      expect(preview).toBeDefined();
      expect(preview!.type).toBe('command');
      expect(preview!.summary).toContain('npm install');
    });

    const WS = '/Users/example/ws';

    it('summary uses the model-given name, else the task, and never the role', () => {
      const named = getConfirmationGate().buildPreview('spawn_agent', { role: 'explore', name: ' 文档主题整理 ', task: '读文档' }, { workspaceRoot: WS });
      expect(named?.summary).toBe('派出子代理：文档主题整理');
      const unnamed = getConfirmationGate().buildPreview('spawn_agent', { role: 'explore', name: '  ', task: ' 调查数据趋势 ' }, { workspaceRoot: WS });
      expect(unnamed?.summary).toBe('派出子代理：调查数据趋势');
    });

    it.each(['spawn_agent', 'AgentSpawn'])('%s: a harmless name cannot hide the real task, write permission and out-of-workspace target', (tool) => {
      const preview = getConfirmationGate().buildPreview(tool, {
        name: '整理文档',
        role: 'coder',
        task: '删除 /Users/example/prod 下全部文件',
      }, { workspaceRoot: WS });
      expect(preview?.summary).toBe('派出子代理：整理文档');
      expect(preview?.diff).toBe('任务：删除 /Users/example/prod 下全部文件\n权限：可修改文件、运行命令');
      const all = `${preview?.summary}\n${preview?.diff}`;
      expect(all).not.toMatch(/coder|Task:|Role:/);
    });

    it('read-only role: workspace paths become relative, permission is 只读查看, role id is hidden', () => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', {
        role: 'explore',
        task: `整理 ${WS}/docs 里的文档，并对照 ${WS} 根目录`,
      }, { workspaceRoot: WS });
      expect(preview?.diff).toContain('./docs');
      expect(preview?.diff).toContain('对照 ./ 根目录');
      expect(preview?.diff).toContain('权限：只读查看');
      const all = `${preview?.summary}\n${preview?.diff}`;
      expect(all).not.toContain(WS);
      expect(all).not.toContain('explore');
    });

    it('does not treat a sibling directory sharing the workspace prefix as inside it', () => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', { role: 'explore', task: `读 ${WS}-other/a` }, { workspaceRoot: WS });
      expect(preview?.diff).toContain(`${WS}-other/a`);
    });

    it('unknown role is shown with write-capable wording', () => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', { role: 'totally-unknown-role', task: '做点事' }, { workspaceRoot: WS });
      expect(preview?.diff).toContain('权限：可修改文件、运行命令');
      expect(`${preview?.summary}\n${preview?.diff}`).not.toContain('totally-unknown-role');
    });

    it('missing role is shown with write-capable wording', () => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', { task: '做点事' }, { workspaceRoot: WS });
      expect(preview?.diff).toBe('任务：做点事\n权限：可修改文件、运行命令');
    });

    it('preserves POSIX, Windows and UNC targets outside the workspace', () => {
      const task = String.raw`Read "/Users/example/My Documents/notes.md", C:\Users\example\other\ and \\server\share\report.md`;
      const preview = getConfirmationGate().buildPreview('spawn_agent', { role: 'explore', task }, { workspaceRoot: WS });
      expect(preview?.summary).toBe(`派出子代理：${task}`);
      expect(preview?.diff).toBe(`任务：${task}\n权限：只读查看`);
    });

    it('keeps a lone filesystem root as / (outside the workspace)', () => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', { task: 'Review /' }, { workspaceRoot: WS });
      expect(preview?.summary).toBe('派出子代理：Review /');
      expect(preview?.diff).toBe('任务：Review /\n权限：可修改文件、运行命令');
    });

    it('redacts task and name secrets before limiting the approval text', () => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', {
        name: 'Review API_KEY=name-secret', task: `API_KEY=preview-secret ${'x'.repeat(250)}`, role: 'explore',
      });
      expect(preview?.summary).toContain('Review API_KEY=');
      expect(preview?.diff).toContain('任务：API_KEY=');
      expect(`${preview?.summary}\n${preview?.diff}`).not.toMatch(/preview-secret|name-secret/);
      expect(preview?.diff?.split('\n')[0]).toHaveLength('任务：'.length + 200);
    });

    it('limits the unnamed spawn_agent task label and details to 200 characters', () => {
      const preview = gate.buildPreview('spawn_agent', { role: '  ', task: 'x'.repeat(250) });
      expect(preview!.type).toBe('generic');
      expect(preview!.summary).toBe(`派出子代理：${'x'.repeat(200)}`);
      expect(preview!.diff).toBe(`任务：${'x'.repeat(200)}\n权限：可修改文件、运行命令`);
    });


    it.each(['spawn_agent', 'AgentSpawn'])('%s: parallel preview lists every task and its own permission', (tool) => {
      const preview = getConfirmationGate().buildPreview(tool, {
        parallel: true,
        name: '不能替代全部助手', task: '不能替代全部任务', role: 'coder',
        agents: [
          { name: '销售要点', task: `整理 ${WS}/sales.txt`, role: 'explore' },
          { name: '产品要点', task: `审阅 ${WS}/product.txt`, role: 'explore' },
          { name: '客服要点', task: `写入 ${WS}/support-summary.md`, role: 'coder' },
        ],
      }, { workspaceRoot: WS });
      expect(preview).toEqual({
        type: 'generic', summary: '派出 3 个子代理',
        diff: '销售要点\n任务：整理 ./sales.txt\n权限：只读查看\n\n产品要点\n任务：审阅 ./product.txt\n权限：只读查看\n\n客服要点\n任务：写入 ./support-summary.md\n权限：可修改文件、运行命令',
      });
      expect(`${preview?.summary}\n${preview?.diff}`).not.toMatch(/explore|reviewer|coder|不能替代/);
    });

    it('parallel unnamed agents use the task and redact and limit each block independently', () => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', {
        parallel: true,
        agents: [
          { task: `读取 ${WS}/sales.txt API_KEY=task-secret ${'x'.repeat(250)}`, role: 'explore' },
          { name: '记录 API_KEY=name-secret', task: `读取 ${WS}-outside/product.txt`, role: 'unknown-role' },
        ],
      }, { workspaceRoot: WS });
      const blocks = preview?.diff?.split('\n\n');
      expect(preview?.summary).toBe('派出 2 个子代理');
      expect(blocks).toHaveLength(2);
      expect(blocks![0].split('\n')[0]).toHaveLength(200);
      expect(blocks![0].split('\n')[1]).toHaveLength('任务：'.length + 200);
      expect(blocks![0]).toContain('读取 ./sales.txt');
      expect(blocks![0]).toContain('权限：只读查看');
      expect(blocks![1]).toContain(`任务：读取 ${WS}-outside/product.txt`);
      expect(blocks![1]).toContain('权限：可修改文件、运行命令');
      expect(preview?.diff).not.toMatch(/task-secret|name-secret|unknown-role/);
    });

    it.each([{}, { parallel: true, agents: [] }])('missing task with no agents is explicit and logged: %j', (params) => {
      const warn = vi.spyOn(console, 'error');
      try {
        const preview = getConfirmationGate().buildPreview('spawn_agent', params);
        expect(preview).toEqual({
          type: 'generic', summary: '派出子代理：未说明任务',
          diff: '任务：未说明任务\n权限：可修改文件、运行命令',
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('WARN [ConfirmationGate] Spawn approval task not stated'),
          { field: 'params.task' },
        );
      } finally { warn.mockRestore(); }
    });

    it('parallel blank task preserves the named agent and logs its field index', () => {
      const warn = vi.spyOn(console, 'error');
      try {
        const preview = getConfirmationGate().buildPreview('spawn_agent', {
          parallel: true,
          agents: [{ name: '销售助手', task: '  ', role: 'explore' }, { role: 'coder' }],
        });
        expect(preview?.diff).toBe('销售助手\n任务：未说明任务\n权限：只读查看\n\n未说明任务\n任务：未说明任务\n权限：可修改文件、运行命令');
        for (const field of ['params.agents[0].task', 'params.agents[1].task']) {
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('WARN [ConfirmationGate] Spawn approval task not stated'), { field },
          );
        }
      } finally { warn.mockRestore(); }
    });

    it.each([undefined, false, 'true'])('agents alone do not select parallel preview: %s', (parallel) => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', {
        parallel, task: '整理销售笔记', role: 'explore', agents: [{ task: '不执行的分支', role: 'coder' }],
      });
      expect(preview?.summary).toBe('派出子代理：整理销售笔记');
      expect(preview?.diff).toBe('任务：整理销售笔记\n权限：只读查看');
    });

    it.each(['spawn_agent', 'AgentSpawn'])('%s: English parallel copy keeps every task and permission visible', (tool) => {
      const locale = vi.spyOn(hostUiLocale, 'getHostUiLocale').mockReturnValue('en');
      try {
        const preview = getConfirmationGate().buildPreview(tool, {
          parallel: true,
          agents: [
            { name: 'Sales notes', task: `Read ${WS}/sales.txt`, role: 'explore' },
            { task: `Write ${WS}/summary.md`, role: 'coder' },
            { task: ' ', role: 'explore' },
          ],
        }, { workspaceRoot: WS });
        expect(preview).toEqual({
          type: 'generic', summary: 'Spawn 3 sub-agents',
          diff: 'Sales notes\nTask: Read ./sales.txt\nPermission: Read-only\n\nWrite ./summary.md\nTask: Write ./summary.md\nPermission: Can modify files and run commands\n\nTask not stated\nTask: Task not stated\nPermission: Read-only',
        });
        const tasks = preview?.diff?.split('\n').filter(line => line.startsWith('Task: '));
        expect(tasks).toHaveLength(3);
        expect(tasks?.every(line => line.slice('Task: '.length).trim().length > 0)).toBe(true);
        expect(`${preview?.summary}\n${preview?.diff}`).not.toMatch(/explore|coder|任务|权限/);
      } finally { locale.mockRestore(); }
    });

    it('English missing single task remains explicit in summary and details and still warns', () => {
      const locale = vi.spyOn(hostUiLocale, 'getHostUiLocale').mockReturnValue('en');
      const warn = vi.spyOn(console, 'error');
      try {
        const preview = getConfirmationGate().buildPreview('spawn_agent', { parallel: true, agents: [] });
        expect(preview?.summary).toContain('Task not stated');
        expect(preview?.diff).toBe('Task: Task not stated\nPermission: Can modify files and run commands');
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('WARN [ConfirmationGate] Spawn approval task not stated'), { field: 'params.task' },
        );
      } finally { warn.mockRestore(); locale.mockRestore(); }
    });

    it('should return generic preview with up to 3 redacted string param diff lines for default tools', () => {
      const preview = gate.buildPreview('custom_tool', {
        query: 'search term',
        apiKey: 'plain-secret-with-no-recognizable-token-shape',
        longText: 'a'.repeat(150),
        fourthParam: 'should not appear',
        count: 42,
      });
      expect(preview).toBeDefined();
      expect(preview!.type).toBe('generic');
      expect(preview!.summary).toBe('执行工具 custom_tool');
      expect(preview!.diff).toBeDefined();
      const lines = preview!.diff!.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('搜索内容: search term');
      expect(lines[1]).toBe('详情: ***REDACTED***');
      expect(lines[1]).not.toContain('plain-secret-with-no-recognizable-token-shape');
      expect(lines[2]).toBe(`详情: ${'a'.repeat(120)}`);
      expect(preview!.diff).not.toContain('fourthParam');
    });

    it('should return generic preview for non-write tools', () => {
      const preview = gate.buildPreview('read_file', { file_path: '/tmp/a.ts' });
      expect(preview).toBeDefined();
      if (preview) {
        expect(preview.type).toBe('generic');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Singleton
  // --------------------------------------------------------------------------
  describe('buildPreview generic card plain language', () => {
    const UUID = '3ab3c0de-1111-4222-8333-444455556666';
    const withLocale = (loc: 'zh' | 'en', fn: () => void) => {
      const spy = vi.spyOn(hostUiLocale, 'getHostUiLocale').mockReturnValue(loc);
      try { fn(); } finally { spy.mockRestore(); }
    };
    const excelArgs = {
      title: 'Sales', sheet_name: 'Sales', theme: 'blue', dry_run: 'false',
      data: '[["a",1],["b",2]]', output_path: 'exports/sales.xlsx',
    };

    it('excel_generate (model order): save location kept, no raw keys, zh', () => {
      withLocale('zh', () => {
        const diff = getConfirmationGate().buildPreview('excel_generate', excelArgs)?.diff ?? '';
        expect(diff).toBe('保存到: exports/sales.xlsx\n标题: Sales\n工作表: Sales');
        expect(diff).not.toMatch(/output_path|sheet_name|theme|dry_run|dry run/);
      });
    });

    it('excel_generate: en labels', () => {
      withLocale('en', () => {
        const diff = getConfirmationGate().buildPreview('excel_generate', excelArgs)?.diff ?? '';
        expect(diff).toBe('Save to: exports/sales.xlsx\nTitle: Sales\nSheet: Sales');
      });
    });

    it('unknown key uses generic label and keeps value; *_id hidden; true/false hidden', () => {
      withLocale('en', () => {
        const diff = getConfirmationGate().buildPreview('some_tool', { dry_run: 'false', task_id: 'abc', flavor: 'mint' })?.diff;
        expect(diff).toBe('Details: mint');
      });
    });

    it('http_request JSON body is still shown (sorted last)', () => {
      withLocale('en', () => {
        const diff = getConfirmationGate().buildPreview('http_request', {
          body: '{"to":"x@y.z"}', method: 'POST', url: 'https://api.example.com/v1',
        })?.diff ?? '';
        expect(diff).toContain('{"to":"x@y.z"}');
        expect(diff.indexOf('Link: https://api.example.com/v1')).toBeLessThan(diff.indexOf('{"to"'));
      });
    });

    it('keeps secret redaction', () => {
      withLocale('en', () => {
        const diff = getConfirmationGate().buildPreview('some_tool', { api_key: 'sk-secret' })?.diff ?? '';
        expect(diff).not.toContain('sk-secret');
        expect(diff).toContain('REDACTED');
      });
    });

    it.each([
      '/tmp/../etc/passwd',
      '/var/folders/ab/cd/T/../../../etc/passwd',
      '/private/var/folders/ab/cd/T/../../../etc/passwd',
      `/Users/x/Library/uploads/${UUID}/../../../etc/hosts`,
      `/tmp/${UUID}/../../etc/hosts`,
    ])('traversal path shown unchanged: %s', (p) => {
      withLocale('en', () => {
        const diff = getConfirmationGate().buildPreview('some_tool', { output_path: p })?.diff;
        expect(diff).toBe(`Save to: ${p}`);
      });
    });

    it.each([
      ['/tmp/a/sales.xlsx', 'Save to: Temporary file: a/sales.xlsx', '保存到: 临时文件：a/sales.xlsx'],
      ['/var/folders/ab/cd/T/sales.csv', 'Save to: Temporary file: sales.csv', '保存到: 临时文件：sales.csv'],
      [`/Users/x/Library/uploads/${UUID}/合同/合同.pdf`, 'Save to: Your uploaded file: 合同/合同.pdf', '保存到: 你上传的文件：合同/合同.pdf'],
      [`/private/var/folders/ab/cd/T/code-agent-uploads/${UUID}/s.csv`, 'Save to: Your uploaded file: s.csv', '保存到: 你上传的文件：s.csv'],
    ])('temp/upload root mapped: %s', (p, en, zh) => {
      withLocale('en', () => { expect(getConfirmationGate().buildPreview('some_tool', { output_path: p })?.diff).toBe(en); });
      withLocale('zh', () => { expect(getConfirmationGate().buildPreview('some_tool', { output_path: p })?.diff).toBe(zh); });
    });

    it('ancestor /var/folders itself and other paths are not shortened', () => {
      withLocale('en', () => {
        expect(getConfirmationGate().buildPreview('some_tool', { output_path: '/var/folders/etc/passwd' })?.diff).toBe('Save to: /var/folders/etc/passwd');
        expect(getConfirmationGate().buildPreview('some_tool', { output_path: '/etc/passwd' })?.diff).toBe('Save to: /etc/passwd');
      });
    });
  });

  describe('Singleton', () => {
    it('should return same instance', () => {
      const a = getConfirmationGate();
      const b = getConfirmationGate();
      expect(a).toBe(b);
    });
  });
});
