import { describe, it, expect } from 'vitest';
import { browserSchema } from '../../../src/host/plugins/builtin/browserControl/browser.schema';
import { browserActionSchema } from '../../../src/host/plugins/builtin/browserControl/browserAction.schema';
import { browserActionTool } from '../../../src/host/tools/vision/browserAction';
import { BrowserTool } from '../../../src/host/tools/vision/BrowserTool';

// "我自己来填" 必须先走 Neo 浏览器面板（browser_action + wait_for_user），不走 Bash curl/open。
// static-contract 档：钉住每份模型可见文案里都带这条分流。
describe('user-fills-it-themselves routing guidance', () => {
  const copies: Array<[string, string]> = [
    ['browserActionTool', browserActionTool.description],
    ['browserActionSchema', browserActionSchema.description],
    ['browserSchema', browserSchema.description],
    ['BrowserTool', BrowserTool.description],
  ];
  it.each(copies)('%s description routes self-fill to wait_for_user, not Bash', (_n, d) => {
    expect(d).toContain('fill in, log in to, or operate a page themselves');
    expect(d).toContain('never probe the URL with Bash curl');
  });
});
