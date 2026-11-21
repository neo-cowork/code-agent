import { describe, expect, it } from 'vitest';
import { browserActionTool } from '../../../src/host/tools/vision/browserAction';
import { BrowserTool } from '../../../src/host/tools/vision/BrowserTool';
import { browserActionSchema } from '../../../src/host/plugins/builtin/browserControl/browserAction.schema';
import { browserSchema } from '../../../src/host/plugins/builtin/browserControl/browser.schema';

const tools = [browserActionTool, browserActionSchema, BrowserTool, browserSchema];
const guidance = (description: string) => description.split('\n').find((line) => line.startsWith('User-operated pages:'));

describe('user-operated browser task handoff descriptions', () => {
  it.each(tools)('$name opens a managed page and resumes only when Neo has remaining work', (tool) => {
    const text = guidance(tool.description);
    expect(text).toContain('browser_action navigate and engine="managed", not a shell command or OS browser opener');
    expect(text).toContain('If Neo must continue after the user acts');
    expect(text).toContain('call wait_for_user, then get_dom_snapshot after Done and finish the remaining task');
    expect(text).toContain('do not poll for login, ask for a chat reply or finish with keep_result_page');
    expect(text).toContain('If opening the page is the whole task and Neo has no follow-up work, call keep_result_page and finish; do not call wait_for_user');
  });

  it('keeps the native, plugin and unified tool guidance identical', () => {
    const descriptions = tools.map((tool) => guidance(tool.description));
    expect(descriptions[0]).toBeDefined();
    expect(new Set(descriptions).size).toBe(1);
  });

  const keepGuidance = (description: string) => description.split('\n').find((line) => line.startsWith('Keep-page requests:'));

  it.each(tools)('$name tells the model when to call keep_result_page and not to claim a kept window without it', (tool) => {
    const text = keepGuidance(tool.description);
    expect(text).toBeDefined();
    for (const phrase of ['把结果页留给我', '别关窗口', '我自己看', 'leave it open for me']) expect(text).toContain(phrase);
    expect(text).toContain('Never tell the user the managed window is kept or still open unless keep_result_page succeeded');
    expect(text).toContain('On the relay engine keep_result_page is unavailable and the tab simply stays open in the user\'s own Chrome');
  });

  it('keeps the keep-page guidance identical across the four copies', () => {
    expect(new Set(tools.map((tool) => keepGuidance(tool.description))).size).toBe(1);
  });
});
