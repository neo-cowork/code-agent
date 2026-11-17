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
});
