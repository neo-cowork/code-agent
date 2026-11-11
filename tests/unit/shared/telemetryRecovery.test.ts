import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  isTelemetryRecoveredMessage,
  stripTelemetryRecoveryNotice,
  withTelemetryRecoveryNoticeForModel,
} from '../../../src/shared/telemetryRecovery';

const TELEMETRY_RECOVERY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';

const msg = (over: Partial<Message>): Message => ({
  id: 'm', role: 'user', content: 'hi', timestamp: 1, ...over,
});

describe('telemetryRecovery', () => {
  it('model assembly prepends the disclaimer exactly once for flagged messages', () => {
    const [out] = withTelemetryRecoveryNoticeForModel([
      msg({ content: '写周报', metadata: { telemetryRecovered: true } }),
    ]);
    expect(out.content).toBe(`${TELEMETRY_RECOVERY_NOTICE}\n\n写周报`);
    expect(out.content.split(TELEMETRY_RECOVERY_NOTICE)).toHaveLength(2);
  });

  it('does not duplicate the disclaimer on legacy prefixed rows', () => {
    const legacy = msg({
      content: `${TELEMETRY_RECOVERY_NOTICE}\n\n写周报`,
      metadata: { telemetryRecovered: true },
    });
    expect(withTelemetryRecoveryNoticeForModel([legacy])[0].content).toBe(legacy.content);
  });

  it('returns the same array (bytes unchanged) when nothing is recovered', () => {
    const input = [msg({ content: 'a' }), msg({ id: 'n', role: 'assistant', content: 'b' })];
    expect(withTelemetryRecoveryNoticeForModel(input)).toBe(input);
  });

  it('legacy prefixed row displays clean and is recognised as recovered', () => {
    const legacy = msg({ content: `${TELEMETRY_RECOVERY_NOTICE}\n\n写周报` });
    expect(isTelemetryRecoveredMessage(legacy)).toBe(true);
    expect(stripTelemetryRecoveryNotice(legacy.content)).toBe('写周报');
    expect(stripTelemetryRecoveryNotice('普通消息')).toBe('普通消息');
  });

  it('ordinary user messages and assistant messages are not recovered', () => {
    expect(isTelemetryRecoveredMessage(msg({}))).toBe(false);
    expect(isTelemetryRecoveredMessage(msg({ role: 'assistant', metadata: { telemetryRecovered: true } }))).toBe(false);
  });
});
