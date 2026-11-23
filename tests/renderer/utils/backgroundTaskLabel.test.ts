import { describe, expect, it } from 'vitest';
import { backgroundTaskLabel } from '../../../src/renderer/utils/agentRoleLabel';
import { languages } from '../../../src/renderer/i18n';

const task = (title: string, source: 'delegate_task' | 'session_command_center' | 'other' = 'delegate_task') =>
  ({ source, title }) as Parameters<typeof backgroundTaskLabel>[0];

describe('backgroundTaskLabel', () => {
  it('zh UI falls back for English prose titles', () => {
    expect(backgroundTaskLabel(task('Extract and summarize contract.pdf'), languages.zh)).toBe('助手');
    expect(backgroundTaskLabel(task('Budget review', 'session_command_center'), languages.zh)).toBe('助手');
  });
  it('zh UI keeps Chinese, single-token and non-delegation titles', () => {
    expect(backgroundTaskLabel(task('提炼合同关键条款'), languages.zh)).toBe('提炼合同关键条款');
    expect(backgroundTaskLabel(task('Extract 合同 clauses'), languages.zh)).toBe('Extract 合同 clauses');
    expect(backgroundTaskLabel(task('deepwiki'), languages.zh)).toBe('deepwiki');
    expect(backgroundTaskLabel(task('Extract and summarize', 'other'), languages.zh)).toBe('Extract and summarize');
  });
  it('en UI unchanged', () => {
    expect(backgroundTaskLabel(task('提炼合同关键条款'), languages.en)).toBe('Background assistant');
    expect(backgroundTaskLabel(task('Extract and summarize contract.pdf'), languages.en)).toBe('Extract and summarize contract.pdf');
  });
});
