import { describe, expect, it, vi } from 'vitest';
import { backgroundWakePromptHead } from '../../../../src/host/agent/runtime/backgroundWakeMessage';
import { applyDesktopActionClaimGate, collectRecentUserTexts } from '../../../../src/host/agent/runtime/desktopActionClaimGate';
import { DESKTOP_CLAIM_GATE_WARNING } from '../../../../src/shared/i18n/desktopClaimGateWarning';

// 警示文案按 getHostUiLocale() 选 zh/en；单测里用可变 locale 桩替换（缺省 zh，
// 与真实读取失败时的回落一致），避免拉起 configService。
const locale = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../../src/host/config/hostUiLocale', () => ({
  getHostUiLocale: () => locale.value,
}));

describe('applyDesktopActionClaimGate', () => {
  it('retries when a desktop task response claims observation without tool evidence', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '你去腾讯会议里找',
      assistantContent: '我搜索了 Spotlight，没有看到腾讯会议，只有 iMeeting.app。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('retry');
    if (result.action === 'retry') {
      expect(result.reason).toBe('desktop_action_claim_without_tool_evidence');
      expect(result.repairPrompt).toContain('Computer/Desktop tool call');
    }
  });

  it('warns instead of retrying after the first repair attempt', () => {
    const result = applyDesktopActionClaimGate({
      recentUserMessages: collectRecentUserTexts([
        { role: 'user', content: '你去腾讯会议里找' },
        { role: 'assistant', content: '好的。' },
        { role: 'user', content: '没看到吗？' },
      ]),
      assistantContent: '腾讯会议在后台运行着，我现在最大化显示。',
      toolCallCount: 0,
      iterations: 2,
    });

    expect(result.action).toBe('warn');
    expect(result.content.startsWith(`${DESKTOP_CLAIM_GATE_WARNING.zh}\n\n`)).toBe(true);
  });

  it('allows honest uncertainty without tool evidence', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '你去腾讯会议里找',
      assistantContent: '我还没有实际打开腾讯会议，需要先调用 Computer 工具确认。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('allows desktop claims when the run used a tool', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '帮我记录当前腾讯会议的内容',
      assistantContent: '屏幕上显示的是腾讯会议主页。',
      toolCallCount: 1,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('allows appshot-backed screen observations without a desktop tool call', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '<appshot app="com.apple.finder" name="Finder">Downloads file list</appshot>',
      assistantContent: '屏幕上显示的是 Finder 的 Downloads 文件列表。',
      toolCallCount: 0,
      iterations: 1,
      hasDesktopEvidence: true,
    });

    expect(result.action).toBe('none');
  });

  it('ignores non-desktop replies', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '解释一下这段代码',
      assistantContent: '这段代码负责把消息写入数据库。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('does not retry a Chinese prose reply that uses observation words without a desktop request', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '写一篇约 8000 字的中文散文，主题是湖边小镇的四季。不要调用任何工具。',
      assistantContent: '那年春天我打开了窗口，看到了湖面上的晨雾，后来在老街找到一盏还亮着的灯。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
    expect(result.content.startsWith(DESKTOP_CLAIM_GATE_WARNING.zh)).toBe(false);
  });

  it('does not retry an English essay that mentions windows and finding things', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: 'Write an 800-word English essay about the four seasons in a lakeside town. Do not call any tools.',
      assistantContent: 'In spring I opened the window, saw the mist over the lake, and finally found the old lamp still glowing.',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
    expect(result.content.startsWith(DESKTOP_CLAIM_GATE_WARNING.zh)).toBe(false);
  });

  it('does not retry a translation reply whose source text contains observation words', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '请把下面译成英文：春天我打开了窗口，看到了湖面，终于找到了那家小店。',
      assistantContent: 'In spring I opened the window. 我打开了窗口，看到了湖面，终于找到了那家小店。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
    expect(result.content.startsWith(DESKTOP_CLAIM_GATE_WARNING.zh)).toBe(false);
  });

  it('does not retry a code explanation that uses 打开了/窗口/找到/看到了', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '解释一下这段代码',
      assistantContent: '这段代码打开了设置窗口，找到配置项之后把结果写回去。我看到了这里的边界处理。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
    expect(result.content.startsWith(DESKTOP_CLAIM_GATE_WARNING.zh)).toBe(false);
  });

  it('does not retry a summary that retells observation-like sentences', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '请总结这篇文章的大意',
      assistantContent: '作者写他打开了窗口，看到了湖，后来找到回家的路。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('does not retry a Q&A reply that uses 窗口/看到了/找到 as metaphors', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '什么是闭包？',
      assistantContent: '闭包能记住定义时的窗口变量。我看到了这个问题的核心，找到了最简例子：函数打开了外层作用域。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('retries when the user asked to open Notes and the reply claims it was done', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '打开备忘录',
      assistantContent: '我已经打开了备忘录，看到了里面的清单。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('retry');
    if (result.action === 'retry') {
      expect(result.reason).toBe('desktop_action_claim_without_tool_evidence');
    }
  });

  it('retries when the user asked for a screenshot phrased as 截屏 and the reply claims it was seen', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '帮我截屏看看',
      assistantContent: '我截图了，屏幕上显示的是桌面，看到了当前窗口。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('retry');
    if (result.action === 'retry') {
      expect(result.reason).toBe('desktop_action_claim_without_tool_evidence');
    }
  });

  it('no longer treats a bare 截一张图 request (browser wording) as a desktop request', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '给搜索结果页截一张图，告诉我图上有什么。',
      assistantContent: '我截图了，屏幕上显示的是搜索结果页，看到了当前窗口。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
    expect(result.content.startsWith(DESKTOP_CLAIM_GATE_WARNING.zh)).toBe(false);
  });

  it('retries when the user asked to click Tencent Meeting and the reply claims the click', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '点一下腾讯会议',
      assistantContent: '我点击了腾讯会议，窗口已经在前台。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('retry');
    if (result.action === 'retry') {
      expect(result.reason).toBe('desktop_action_claim_without_tool_evidence');
    }
  });

  it('still allows honest uncertainty on a desktop request to open Notes', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '打开备忘录',
      assistantContent: '我还没有打开备忘录，需要先调用 Computer 工具确认。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('keeps follow-up turns covered when an earlier turn asked for a desktop action', () => {
    const result = applyDesktopActionClaimGate({
      recentUserMessages: ['再试试', '没看到吗？', '打开备忘录'],
      assistantContent: '我已经打开了备忘录，看到了里面的清单。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('retry');
  });

  it('ignores desktop requests in rewound turns and beyond the recent window', () => {
    const texts = collectRecentUserTexts([
      { role: 'user', content: '打开备忘录' },
      { role: 'user', content: '写一篇散文' },
      { role: 'user', content: '再长一点' },
      { role: 'user', content: '点一下腾讯会议', visibility: 'rewound' },
      { role: 'user', content: '继续' },
    ]);
    expect(texts).toEqual(['继续', '再长一点', '写一篇散文']);

    const result = applyDesktopActionClaimGate({
      recentUserMessages: texts,
      assistantContent: '那年春天我打开了窗口，看到了满院的花，也找到了旧日的信。',
      toolCallCount: 0,
      iterations: 1,
    });
    expect(result.action).toBe('none');
  });

  const report = '后台已经打开了报销单页面，点击了上传框，invoice.pdf 已附加，页面显示已选择该文件，没有提交。';
  const check = (history: Array<{ role: string; content: string; isMeta?: boolean; metadata?: { automation?: { automationId?: string } } }>) =>
    applyDesktopActionClaimGate({ recentUserMessages: collectRecentUserTexts(history), assistantContent: report, toolCallCount: 0, iterations: 1 });

  it('前台唤醒消息（wakePrompt 真格式）不算用户的桌面请求', () => {
    const wake = `${backgroundWakePromptHead('报销附件', '完成')}已在浏览器里打开页面并点击上传框，截图确认 invoice.pdf 已附加。汇报时不要原样引用内部编号。`;
    const history = [
      { role: 'user', content: '请在后台打开报销单页面，把 invoice.pdf 附到上传框里' },
      { role: 'user', content: wake, isMeta: true },
    ];
    expect(collectRecentUserTexts(history)).toEqual(['请在后台打开报销单页面，把 invoice.pdf 附到上传框里']);
    expect(check(history).action).toBe('none');
    // 浏览器页面点击 + 截一张图的文本，作为普通用户消息也不再算桌面请求（本单收口）
    expect(applyDesktopActionClaimGate({ recentUserMessages: [wake], assistantContent: report, toolCallCount: 0, iterations: 1 }).action).toBe('none');
    // 对照（保 wake 排除机制本身）：文本换成明确桌面词（截屏）时，普通用户消息仍触发闸门
    const desktopWake = wake.replace('截图确认', '截屏确认');
    expect(applyDesktopActionClaimGate({ recentUserMessages: [desktopWake], assistantContent: report, toolCallCount: 0, iterations: 1 }).action).toBe('retry');
  });

  it('空闲唤醒消息（automationId=background-subagent:*）不算用户的桌面请求', () => {
    const history = [
      { role: 'user', content: '帮我整理一下', isMeta: false },
      { role: 'user', content: '后台任务已结束：点击了上传框并截图', isMeta: true, metadata: { automation: { automationId: 'background-subagent:s1' } } },
    ];
    expect(check(history).action).toBe('none');
  });

  it('后台任务的 isMeta 任务指令若只是网页点击/截图，不再算桌面请求（本单收口）', () => {
    const history = [{ role: 'user', content: '打开页面，点击上传框，把 invoice.pdf 附到上传框', isMeta: true }];
    expect(collectRecentUserTexts(history)).toHaveLength(1);
    expect(check(history).action).toBe('none');
  });

  it('后台任务的 isMeta 任务指令点名桌面 app 时仍是桌面请求：零工具调用声称已执行照样 retry', () => {
    const history = [{ role: 'user', content: '打开备忘录，新建一条报销记录，附上 invoice.pdf', isMeta: true }];
    expect(collectRecentUserTexts(history)).toHaveLength(1);
    expect(check(history).action).toBe('retry');
  });

  // realrun2 复盘（N-FIX-DESKTOP-CLAIM-GATE-FALSE-WARN-RAW-TOOLNAME）：
  // ~/work/out/N-FIX-BROWSER-SCREENSHOT-READ-CONTEXT-BLOAT/realrun2/db-2.json 的
  // messages[0]（用户原话）+ messages[2]（is_meta 委派任务提示，只保留两行关键行：
  // 目标句 + 计划里「对这个「搜索结果页」截一张全屏截图」那行，模板其余部分无关）+
  // messages[44] 正文（去掉旧警示前缀）。修复前该复盘返回 warn（裸「截图」命中计划行），
  // 修复后必须 none。
  it('realrun2 replay: browser task with delegated meta prompt and bare 截一张图 → none', () => {
    const msg0 = '打开 example.com，然后在维基百科搜索 Tauri，帮我总结一下它是什么。再给搜索结果页截一张图，告诉我图上有什么。';
    const metaPrompt = [
      'This task covers only the objective in <drafted_task_plan>; that plan defines its scope.',
      `<original_user_request context_only="true">\n${msg0}\n</original_user_request>`,
      '<drafted_task_plan>',
      '3. 对这个「搜索结果页」截一张全屏截图，保存为工作区内的 PNG 文件（例如 screenshots/wikipedia-tauri-search-results.png），并在最终回复中给出该文件的绝对路径。',
      '</drafted_task_plan>',
    ].join('\n');
    const msg44Body = [
      "维基百科搜 Tauri 的结果和截图都拿到了。",
      "",
      "**Tauri 是什么**（信息来自中文维基百科 Tauri 条目）",
      "- 一个开源框架，用网页前端技术做出跨平台的桌面和移动应用",
      "- 后端用 Rust，前端用 JavaScript；靠系统自带的浏览器内核渲染页面，不像 Electron 那样打包一整个浏览器，所以更轻量",
      "- 支持 Linux、macOS、Windows、Android、iOS",
      "- 安全上做了隔离：各能力接口可单独开关，防止页面里的脚本随意访问本机程序",
      "- 由 Tauri 基金会管理，2020 年 6 月首次发布，2024 年 10 月的 v2 开始支持移动端，目前稳定版 2.12.5（2026 年 10 月），许可证 MIT 与 Apache 2.0",
      "",
      "**截图文件**",
      "[screenshots/wikipedia-tauri-search-results.png](!open) — 整页截图，1280 × 3913，约 1MB",
      "",
      "**图上能看到什么**",
      "- 浏览器标题「Tauri - 搜索结果 - 维基百科，自由的百科全书」，站头是繁体，正文简繁混排，右下角标注「澳門繁體」",
      "- 顶部有菜单按钮、维基 logo、居中的搜索框和「搜索」按钮，右侧是「资助维基百科 / 创建账号 / 登录」，下面一条交流群提示横幅",
      "- 搜索区有「外观」面板（字号、宽度、颜色三档）和筛选栏：搜索框里填着 Tauri、「高级搜索」、「搜索：条目」标签、每页 20/50/100/250/500 条的选择器",
      "- 结果统计「第 1-20 条结果，共 204 条」",
      "- 列表第一条就是 **Tauri**，摘要提到比 Electron 更轻量、Tauri 基金会、MIT 与 Apache 2.0、2020 年 6 月发布 1.0，条目大小 6 KB（518 字），最后修订 2026 年 7 月 29 日",
      "- 后面几条是同名不同义的内容：金牛T星、艾法托利車隊（重定向自 Alpha Tauri）、Racing Bulls 车队、毕宿增三、金牛座HL、金牛座GG、HD 283572、昴宿星團等，多为天文和赛车相关",
      "",
      "example.com 是这次执行的第一步，已按顺序打开，但回收的报告里没有写它页面上的文字内容。",
    ].join('\n');
    const history = [
      { role: 'user', content: msg0 },
      { role: 'user', content: metaPrompt, isMeta: true },
      { role: 'assistant', content: msg44Body },
    ];
    const result = applyDesktopActionClaimGate({
      recentUserMessages: collectRecentUserTexts(history),
      assistantContent: msg44Body,
      toolCallCount: 0,
      iterations: 2,
    });
    expect(result.action).toBe('none');
    expect(result.content.startsWith(DESKTOP_CLAIM_GATE_WARNING.zh)).toBe(false);
  });

  it('warns plainly without internal tool names on a real desktop claim without evidence (zh)', () => {
    locale.value = 'zh';
    const input = {
      latestUserMessage: '打开备忘录，新建一条',
      assistantContent: '我已经打开了备忘录，新建了一条清单，看到了里面的内容。',
      toolCallCount: 0,
    } as const;
    const firstAttempt = applyDesktopActionClaimGate({ ...input, iterations: 1 });
    expect(firstAttempt.action).toBe('retry');
    const laterAttempt = applyDesktopActionClaimGate({ ...input, iterations: 2 });
    expect(laterAttempt.action).toBe('warn');
    if (laterAttempt.action === 'warn') {
      expect(laterAttempt.content.startsWith(`${DESKTOP_CLAIM_GATE_WARNING.zh}\n\n`)).toBe(true);
      expect(laterAttempt.content).not.toContain('Computer');
    }
  });

  it('warns plainly without internal tool names on a real desktop claim without evidence (en)', () => {
    locale.value = 'en';
    try {
      const input = {
        latestUserMessage: '打开备忘录，新建一条',
        assistantContent: '我已经打开了备忘录，新建了一条清单，看到了里面的内容。',
        toolCallCount: 0,
      } as const;
      const firstAttempt = applyDesktopActionClaimGate({ ...input, iterations: 1 });
      expect(firstAttempt.action).toBe('retry');
      const laterAttempt = applyDesktopActionClaimGate({ ...input, iterations: 2 });
      expect(laterAttempt.action).toBe('warn');
      if (laterAttempt.action === 'warn') {
        expect(laterAttempt.content.startsWith(`${DESKTOP_CLAIM_GATE_WARNING.en}\n\n`)).toBe(true);
        expect(laterAttempt.content).not.toContain('Computer');
      }
    } finally {
      locale.value = 'zh';
    }
  });
});
