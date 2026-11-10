import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeReplanSessionWorkDirectory, planSessionWorkDirectory } from '../../../../src/host/config/sessionWorkDirectory';

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'attachment-folder-'));
  env = { CODE_AGENT_HOME: home, CODE_AGENT_DATA_DIR: path.join(home, '.code-agent') };
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const attachment = { id: 'budget', name: 'sub/Q3-budget.xlsx', type: 'file' as const, category: 'data' as const, size: 1, mimeType: 'text/csv' };
const file = (name: string) => ({ name, category: 'data' as const });

describe('attachment-only session folder planning through the production entry', () => {
  it.each(['zh', 'en'] as const)('uses the first nonempty attachment basename without its extension (%s)', async language => {
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const result = await planSessionWorkDirectory({
      userMessage: '  ', attachments: [file(' '), file('sub/Q3-budget.xlsx'), file('ignored.csv')], language, env,
    });
    expect(path.basename(result)).toBe(`${language === 'zh' ? '任务' : 'Task'}_${mmdd}_Q3-budget`);
  });

  it.each([
    ['a'.repeat(60) + '.csv', 'a'.repeat(40)],
    ['sub/Q3:budget*<>|.xlsx', 'Q3budget'],
    ['sub/预算😀' + '😀'.repeat(60) + '.csv', '预算' + '😀'.repeat(38)],
    ['sub/report.final.csv', 'report'],
    ['sub/.budget', 'budget'],
    ['sub/<>|*.csv', 'untitled'],
  ])('sanitizes and caps %s', async (name, expected) => {
    const result = await planSessionWorkDirectory({ attachments: [file(name)], env });
    expect(path.basename(result).split('_').slice(2).join('_')).toBe(expected);
  });

  it('uses a folder attachment name including its final component', async () => {
    const result = await planSessionWorkDirectory({ attachments: [{ name: 'sub/Budget folder', category: 'folder' }], env });
    expect(path.basename(result)).toMatch(/_Budget folder$/);
  });

  it.each([undefined, [], [file(' ')], [file('sub/')]])('keeps untitled without a usable prompt or attachment (%j)', async attachments => {
    expect(path.basename(await planSessionWorkDirectory({ attachments, env }))).toMatch(/_untitled$/);
  });

  it.each(['Summarize budget, please', '<>|*'])('preserves existing nonempty prompt behavior (%s)', async userMessage => {
    const result = await planSessionWorkDirectory({ userMessage, attachments: [file('Q3-budget.xlsx')], env });
    expect(path.basename(result)).toMatch(userMessage.startsWith('Summarize') ? /_Summarize budget$/ : /_untitled$/);
  });

  it('keeps usable session titles ahead of attachment fallback', async () => {
    expect(path.basename(await planSessionWorkDirectory({
      sessionTitle: 'Budget review', attachments: [file('Q3-budget.xlsx')], env,
    }))).toMatch(/_Budget review$/);
  });
});

describe('attachment-derived names survive automatic titles before materialization', () => {
  it.each(['Appshot 会话', 'sub/Q3-budget.xlsx', '预算分析'])('preserves the attachment-derived plan for %s', async sessionTitle => {
    const workingDirectory = await planSessionWorkDirectory({ attachments: [file('sub/Q3-budget.xlsx')], env });
    await expect(maybeReplanSessionWorkDirectory({
      workingDirectory, sessionTitle, loadFirstUserMessage: async () => ({ content: '', attachments: [attachment] }), env,
    })).resolves.toBeUndefined();
  });

  it.each(['Q3-budget', 'Q3-budget-2'])('preserves collision suffixes for %s', async name => {
      const attachments = [{ ...attachment, name: `${name}.xlsx` }];
      await planSessionWorkDirectory({ attachments, env });
      const workingDirectory = await planSessionWorkDirectory({ attachments, env });
      expect(workingDirectory).toMatch(/-2$/);
      await expect(maybeReplanSessionWorkDirectory({
        workingDirectory, sessionTitle: 'Appshot 会话', loadFirstUserMessage: async () => ({ content: '', attachments }), env,
      })).resolves.toBeUndefined();
  });

  it.each(['', 'Summarize this budget'])('does not suppress normal smart-title replan for an unrelated current folder (%s)', async content => {
    const workingDirectory = await planSessionWorkDirectory({ userMessage: 'Earlier folder', env });
    const result = await maybeReplanSessionWorkDirectory({
      workingDirectory, sessionTitle: 'Budget review', loadFirstUserMessage: async () => ({ content, attachments: [attachment] }), env,
    });
    expect(result && path.basename(result)).toMatch(/_Budget review$/);
  });

  it('still replans a prompt-derived folder even if it matches an attachment', async () => {
    const workingDirectory = await planSessionWorkDirectory({ userMessage: 'Q3-budget', env });
    const result = await maybeReplanSessionWorkDirectory({
      workingDirectory, sessionTitle: 'Budget review',
      loadFirstUserMessage: async () => ({ content: 'Q3-budget', attachments: [attachment] }), env,
    });
    expect(result && path.basename(result)).toMatch(/_Budget review$/);
  });
});
