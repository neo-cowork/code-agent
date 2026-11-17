import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  isTelemetryRecoveredMessage,
  stripTelemetryRecoveryNotice,
  withTelemetryRecoveryNoticeForModel,
} from '../../../src/shared/telemetryRecovery';

const LEGACY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';

const msg = (over: Partial<Message>): Message => ({
  id: 'm', role: 'user', content: 'hi', timestamp: 1, ...over,
});

const BANNED = ['telemetry', 'home', 'shell', 'Glob', '重建', '脱敏'];

const noticeOf = (content = 'x'): string => {
  const [out] = withTelemetryRecoveryNoticeForModel([
    msg({ content, metadata: { telemetryRecovered: true } }),
  ]);
  return out.content.slice(0, out.content.length - `\n\n${content}`.length);
};

describe('telemetryRecovery', () => {
  it('model assembly prepends the notice exactly once for flagged messages', () => {
    const notice = noticeOf();
    const [out] = withTelemetryRecoveryNoticeForModel([
      msg({ content: '写周报', metadata: { telemetryRecovered: true } }),
    ]);
    expect(out.content).toBe(`${notice}\n\n写周报`);
    expect(out.content.split('【历史恢复提示】')).toHaveLength(2);
    expect(out.content).not.toContain(LEGACY_NOTICE);
  });

  it('new notice tells the model what to say and never to scan the machine', () => {
    const notice = noticeOf();
    expect(notice).toContain('这条消息是根据运行记录还原的，路径可能不完整');
    expect(notice).toContain('不要为了找这个缩短的路径去搜索整台电脑');
  });

  it('notice sentence for the user contains none of the banned internal words', () => {
    const userSentence = noticeOf().match(/「(.+?)」/)?.[1] ?? '';
    expect(userSentence).not.toBe('');
    for (const word of BANNED) expect(userSentence).not.toContain(word);
  });

  it('does not duplicate on rows already prefixed with the new notice', () => {
    const prefixed = msg({
      content: `${noticeOf()}\n\n写周报`,
      metadata: { telemetryRecovered: true },
    });
    expect(withTelemetryRecoveryNoticeForModel([prefixed])[0].content).toBe(prefixed.content);
  });

  it('does not double-prefix rows that begin with the old notice', () => {
    const legacy = msg({
      content: `${LEGACY_NOTICE}\n\n写周报`,
      metadata: { telemetryRecovered: true },
    });
    expect(withTelemetryRecoveryNoticeForModel([legacy])[0].content).toBe(legacy.content);
  });

  it('returns the same array (bytes unchanged) when nothing is recovered', () => {
    const input = [msg({ content: 'a' }), msg({ id: 'n', role: 'assistant', content: 'b' })];
    expect(withTelemetryRecoveryNoticeForModel(input)).toBe(input);
  });

  it('old-prefixed row displays clean and is recognised as recovered', () => {
    const legacy = msg({ content: `${LEGACY_NOTICE}\n\n写周报` });
    expect(isTelemetryRecoveredMessage(legacy)).toBe(true);
    expect(stripTelemetryRecoveryNotice(legacy.content)).toBe('写周报');
    expect(stripTelemetryRecoveryNotice('普通消息')).toBe('普通消息');
  });

  it('new-prefixed row displays clean and is recognised as recovered', () => {
    const row = msg({ content: `${noticeOf()}\n\n写周报` });
    expect(isTelemetryRecoveredMessage(row)).toBe(true);
    expect(stripTelemetryRecoveryNotice(row.content)).toBe('写周报');
  });

  it('ordinary user messages and assistant messages are not recovered', () => {
    expect(isTelemetryRecoveredMessage(msg({}))).toBe(false);
    expect(isTelemetryRecoveredMessage(msg({ role: 'assistant', metadata: { telemetryRecovered: true } }))).toBe(false);
  });
});
