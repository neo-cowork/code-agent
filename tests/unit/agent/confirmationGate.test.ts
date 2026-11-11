// ============================================================================
// ConfirmationGate Tests [E2]
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
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

    it('should build human summary for spawn_agent using the task without the internal role', () => {
      const preview = gate.buildPreview('spawn_agent', {
        role: 'researcher',
        task: '调查最近三天的数据趋势并生成简报',
      });
      expect(preview).toBeDefined();
      expect(preview!.type).toBe('generic');
      expect(preview!.summary).toBe('派出子代理：调查最近三天的数据趋势并生成简报');
    });

    it.each([
      { name: ' 文档主题整理 ', expected: '文档主题整理' },
      { name: undefined, expected: 'Review all seven documents in workspace one by one' },
      { name: '   ', expected: 'Review all seven documents in workspace one by one' },
    ])('spawn_agent preview selects the user label and hides role and absolute paths ($name)', ({ name, expected }) => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', {
        role: 'explore',
        name,
        task: ' Review all seven documents in /Users/example/project/workspace one by one ',
      });
      expect(preview?.summary).toBe(`派出子代理：${expected}`);
      expect(preview?.summary).not.toMatch(/explore|role|\/Users\//);
    });

    it('shortens quoted POSIX, Windows and UNC paths before truncating the unnamed task', () => {
      const task = String.raw`Read "/Users/example/My Documents/notes.md", C:\Users\example\workspace\ and \\server\share\report.md`;
      const preview = getConfirmationGate().buildPreview('spawn_agent', { role: 'explore', task });
      expect(preview?.summary).toBe('派出子代理：Read "notes.md", workspace and report.md');
      const longPath = `/Users/example/${'folder/'.repeat(40)}workspace`;
      expect(getConfirmationGate().buildPreview('spawn_agent', { task: `Review ${longPath}` })?.summary)
        .toBe('派出子代理：Review workspace');
    });

    it('keeps secret redaction on the selected spawn_agent name', () => {
      const preview = getConfirmationGate().buildPreview('spawn_agent', {
        role: 'explore', name: 'Review API_KEY=preview-secret', task: 'unused',
      });
      expect(preview?.summary).toContain('Review API_KEY=');
      expect(preview?.summary).not.toContain('preview-secret');
    });

    it('should omit parenthesis for spawn_agent when role is empty', () => {
      const preview = gate.buildPreview('spawn_agent', {
        role: '  ',
        task: 'x'.repeat(250),
      });
      expect(preview).toBeDefined();
      expect(preview!.type).toBe('generic');
      expect(preview!.summary).toBe(`派出子代理：${'x'.repeat(200)}`);
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
      expect(lines[0]).toBe('query: search term');
      expect(lines[1]).toBe('apiKey: ***REDACTED***');
      expect(lines[1]).not.toContain('plain-secret-with-no-recognizable-token-shape');
      expect(lines[2]).toBe(`longText: ${'a'.repeat(120)}`);
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
  describe('Singleton', () => {
    it('should return same instance', () => {
      const a = getConfirmationGate();
      const b = getConfirmationGate();
      expect(a).toBe(b);
    });
  });
});
