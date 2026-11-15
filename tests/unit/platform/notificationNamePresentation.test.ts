import { describe, expect, it } from 'vitest';
import { sanitizeNotificationText } from '../../../src/host/services/infra/notificationPolicy';

describe('notification entity names', () => {
  it.each([
    ['Task completed - Weekly report · ', 'Task completed - Weekly report'],
    ['任务完成 - 周报（工单 ', '任务完成 - 周报'],
  ])('omits identifiers in the title without an internal-record placeholder: %s', (prefix, expected) => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const raw = prefix + id + (prefix.includes('（') ? '）' : '');
    expect(sanitizeNotificationText(raw, 120, { omitIds: true })).toBe(expected);
  });
  it('keeps a user name that has no id', () => {
    expect(sanitizeNotificationText('Weekly report (ID)', 120, { omitIds: true })).toBe('Weekly report (ID)');
  });
});
