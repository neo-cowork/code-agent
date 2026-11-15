import { describe, expect, it } from 'vitest';
import { detectReplyEgressLeaks } from '../../src/shared/replyEgressLeakDetect';

describe('detectReplyEgressLeaks', () => {
  describe('positive samples (zh/en audit examples)', () => {
    it('flags mechanism_talk and internal_tool_name on "我的工具列表里没有 browser_action"', () => {
      const reply = '抱歉，我的工具列表里没有 browser_action，暂时打不开这个网页。';
      const result = detectReplyEgressLeaks(reply, '打开这个网页截图发我并总结');

      expect(result.categories).toContain('mechanism_talk');
      expect(result.categories).toContain('internal_tool_name');
      expect(result.matchedTokens).toContain('工具列表里');
      expect(result.matchedTokens).toContain('browser_action');
      expect(result.matchedTokens).not.toContain(reply);
    });

    it('flags mechanism_talk on "本轮 Bash 不可用"', () => {
      const reply = '本轮 Bash 不可用，无法直接执行清理脚本。';
      const result = detectReplyEgressLeaks(reply, '帮我把桌面上的临时文件删掉');

      expect(result.categories).toEqual(['mechanism_talk']);
      expect(result.matchedTokens).toContain('本轮 Bash 不可用');
      expect(result.matchedTokens).not.toContain(reply);
    });

    it('flags English mechanism talk ("tool list", "this turn\'s tools", "system prompt")', () => {
      const reply =
        "My tool list has no browser_action, and this turn's tools are unavailable because the system prompt forbids direct shell execution.";
      const result = detectReplyEgressLeaks(reply, 'Please open this page and summarize it.');

      expect(result.categories).toContain('mechanism_talk');
      expect(result.categories).toContain('internal_tool_name');
      expect(result.categories).not.toContain('english_reply_to_zh');
      expect(result.matchedTokens).toContain('browser_action');
      expect(result.matchedTokens).toContain('system prompt');
      expect(result.matchedTokens).not.toContain(reply);
    });

    it('flags english_reply_to_zh on audit narration sample sent to a Chinese user', () => {
      const reply =
        'Both mail and calendar connectors are connected. Now let me take stock of accounts and pull recent data.';
      const result = detectReplyEgressLeaks(reply, '查一下我明天的日程再回邮件');

      expect(result.categories).toEqual(['english_reply_to_zh']);
      expect(result.matchedTokens.length).toBeGreaterThan(0);
      expect(result.matchedTokens).toContain('Both');
      expect(result.matchedTokens).not.toContain(reply);
    });

    it('flags english_reply_to_zh when Chinese user asks to summarize an English item in Chinese', () => {
      const reply =
        'Here is a summary of the project proposal: the team plans to ship the desktop release next Friday after finishing the final reliability review and documentation pass.';
      const result = detectReplyEgressLeaks(reply, '帮我看看这封英文邮件讲了什么');

      expect(result.categories).toEqual(['english_reply_to_zh']);
    });
  });

  describe('negative samples', () => {
    it('does not flag english_reply_to_zh when a Chinese user explicitly asks for English', () => {
      const englishReply =
        'Both mail and calendar connectors are connected. Here is the English summary you requested for tomorrow morning.';

      expect(
        detectReplyEgressLeaks(englishReply, '请用英文回复：帮我写一段明早会议的安排说明').categories,
      ).toEqual([]);
      expect(
        detectReplyEgressLeaks(englishReply, '把这段话翻译成英文：明天上午十点同步项目进度').categories,
      ).toEqual([]);
      expect(
        detectReplyEgressLeaks(englishReply, '帮我起草一封英文邮件给客户确认时间').categories,
      ).toEqual([]);
      expect(
        detectReplyEgressLeaks(englishReply, '总结一下今天的工作，please reply in English').categories,
      ).toEqual([]);
    });

    it('skips text inside markdown code fences for mechanism_talk, tool names, and English text', () => {
      const fencedWithChineseIntro = [
        '已为你整理好示例片段：',
        '```txt',
        '我的工具列表里没有 browser_action',
        '本轮 Bash 不可用，system prompt 限制了调用',
        'Both mail and calendar connectors are connected. Now let me take stock of accounts and pull recent data.',
        '```',
      ].join('\n');

      const fenceOnly = [
        '```md',
        'Both mail and calendar connectors are connected. Now let me take stock of accounts and pull recent data.',
        'browser_action spawn_agent system prompt',
        '```',
      ].join('\n');

      expect(detectReplyEgressLeaks(fencedWithChineseIntro, '帮我整理示例').categories).toEqual([]);
      expect(detectReplyEgressLeaks(fenceOnly, '帮我整理示例').categories).toEqual([]);
    });

    it('does not flag plain human-language Chinese fallback replies or English replies to English users', () => {
      expect(
        detectReplyEgressLeaks(
          '这里暂时没法直接运行清理命令，文件还没有改动；我可以先帮你列出桌面上的临时文件清单，再交由后台处理。',
          '帮我把桌面上的临时文件删掉',
        ).categories,
      ).toEqual([]);

      expect(
        detectReplyEgressLeaks(
          'Both mail and calendar connectors are connected. Now let me take stock of accounts and pull recent data.',
          'Check my calendar for tomorrow and draft a reply.',
        ).categories,
      ).toEqual([]);
    });
  });
});

describe('detectReplyEgressLeaks: denial paraphrases (FU1)', () => {
  const zhUser = '帮我把工作目录里的 .tmp 临时文件删掉';

  it.each([
    'shell 被禁用',
    'Shell 命令这一轮跑不了',
    'shell 命令不在本轮可用能力内',
    '该能力在本次运行中被禁用',
    '终端工具被禁用了',
  ])('flags mechanism_talk on "%s"', (reply) => {
    const result = detectReplyEgressLeaks(`抱歉，${reply}，我先帮你列出文件。`, zhUser);
    expect(result.categories).toContain('mechanism_talk');
  });

  it('flags a short English opener only when the message carries toolCalls', () => {
    const reply = "I'll first look at what's actually there before removing anything.";
    expect(detectReplyEgressLeaks(reply, zhUser, { hasToolCalls: true }).categories).toEqual(['english_reply_to_zh']);
    expect(detectReplyEgressLeaks(reply, zhUser).categories).toEqual([]);
  });

  it('does not fire on legitimate sentences or English requests', () => {
    expect(detectReplyEgressLeaks('终端里的配色可以在设置中调整，也可以禁用闪烁光标。', '终端配色怎么改').categories).toEqual([]);
    expect(detectReplyEgressLeaks('OK', zhUser, { hasToolCalls: true }).categories).toEqual([]);
    expect(detectReplyEgressLeaks("I'll first look at what's actually there.", '请用英文回复我', { hasToolCalls: true }).categories).toEqual([]);
    expect(detectReplyEgressLeaks("I'll first look at what's actually there.", 'clean my tmp files', { hasToolCalls: true }).categories).toEqual([]);
  });
});


describe('inability reply violation shapes', () => {
  const zhUser = '帮我把工作目录里的 .tmp 临时文件删掉';
  it.each([
    '删除动作被权限拦下了',
    '系统不允许我直接抹掉文件',
    '本机进程查询这条路在当前环境里被拦下了，两次都没跑成，所以数据还没拿到。',
    '刚才那步打包命令在我这边被拦下了',
    '我刚才的尝试被拦住了',
    '查日程这件事我没做成，刚才两次尝试都被拦下，没有执行任何操作。',
    '我的权限不允许执行删除',
    '我没有权限删除文件',
    '我的删除请求被拒了',
    'My command was blocked by policy.',
    'I am not allowed to delete it.',
    'Permission denied.',
    '被拦下',
  ])('observes invented cause: %s', (reply) => {
    expect(detectReplyEgressLeaks(reply, zhUser).categories).toContain('invented_cause');
  });

  it.each([
    '请打开「终端」App，粘贴下面这行',
    '你可以把下面这行贴到右侧终端里自己执行',
    '把下面这行复制到终端里回车就能清掉这两项',
    '你自己在终端里执行下面这行',
    '粘贴以下这行即可',
    '改成你自己在「终端」里粘贴这三行',
    'Open Terminal and paste the command below.',
  ])('observes unsolicited command handover: %s', (reply) => {
    expect(detectReplyEgressLeaks(reply, zhUser).categories).toContain('command_handoff');
  });

  it.each([
    ['权限设置里可以查看哪些应用不允许访问文件。', '权限设置怎么改？'],
    ['系统不允许未授权的应用读取文件，需要在权限设置中调整。', '权限设置怎么改？'],
    ['Permission denied means the application is not allowed to read that folder.', 'Explain the permission settings in English.'],
    ['你没有权限修改这个共享文件夹，请找文件夹主人确认设置。', '如何处理共享文件夹权限？'],
    ['需要你点允许，然后我会继续删除。', zhUser],
    ['广告被浏览器拦住了。', '浏览器为什么没显示广告？'],
    ['删除还没完成，文件没有改动。我可以先只读查看，再交给后台任务，操作前会先问你。', zhUser],
    ['打开「终端」App，粘贴下面这行：\n```sh\nzip -r notes.zip notes\n```', '我自己运行，给我压缩 notes 文件夹的命令'],
    ['Open Terminal and paste this line.\n```sh\nzip -r notes.zip notes\n```', 'I will run it myself, give me the command to compress the notes folder into a zip.'],
    ['下面是示例：\n```text\n删除动作被权限拦下了\n打开「终端」App，粘贴下面这行\nPermission denied.\n```', '查看示例'],
  ])('exempts settings, approvals, explicit command requests and fenced examples', (reply, user) => {
    expect(detectReplyEgressLeaks(reply, user).categories).toEqual([]);
  });

  it('an explicit command request does not exempt an invented cause', () => {
    expect(detectReplyEgressLeaks('删除动作被权限拦下了', '给我删除命令').categories).toContain('invented_cause');
  });

  it('a request to execute, or not to provide a command, does not opt into handover', () => {
    for (const user of [zhUser, '不要给我命令，直接压缩文件夹', 'Run the command to compress notes', "Don't give me a command; do it for me."]) {
      expect(detectReplyEgressLeaks('Open Terminal and paste this line.', user).categories).toContain('command_handoff');
    }
  });
});
