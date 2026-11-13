import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_TEMPLATES } from '../../../src/renderer/components/features/cron/cronTemplates';
import { buildCronJobInput } from '../../../src/renderer/components/features/cron/types';

afterEach(() => vi.restoreAllMocks());

describe.each(['Pacific/Auckland', 'Asia/Shanghai'])('machine timezone %s', (timeZone) => {
  function mockMachineZone() {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...original.call(this), timeZone };
    });
  }

  it.each(['daily-lookahead', 'daily-review', 'weekly-review', 'morning-triage'])(
    'template %s carries the machine timezone', (id) => {
      mockMachineZone();
      const draft = CRON_TEMPLATES.find((template) => template.id === id)!.generate({});
      expect(draft.cronTimezone).toBe(timeZone);
      expect(buildCronJobInput(draft).schedule).toMatchObject({ type: 'cron', timezone: timeZone });
    },
  );

  it.each([
    ['empty', '', '0 9 * * *'],
    ['direct cron', '0 15 * * 1-5', '0 15 * * 1-5'],
    ['daily time', '每天 17:30', '30 17 * * *'],
    ['daily default', '每天', '0 9 * * *'],
    ['fallback', '日常查看', '0 9 * * *'],
  ])('quick schedule %s carries the machine timezone', (_branch, schedule, expression) => {
    mockMachineZone();
    // Exercise the private parser through every template that consumes it.
    for (const id of ['web-change-watch', 'feishu-calendar-conflict', 'feishu-table-change']) {
      const draft = CRON_TEMPLATES.find((template) => template.id === id)!.generate({
        url: 'https://example.com/updates', calendarId: 'calendar', schedule,
      });
      expect(draft).toMatchObject({ scheduleType: 'cron', cronTimezone: timeZone, cronExpression: expression });
    }
  });

  it.each([['每 2 小时', 'hours', 2], ['每 15 分钟', 'minutes', 15]])(
    'interval %s remains independent of timezone', (schedule, unit, interval) => {
      mockMachineZone();
      const template = CRON_TEMPLATES.find((item) => item.id === 'web-change-watch')!;
      expect(buildCronJobInput(template.generate({ url: 'https://example.com', schedule })).schedule)
        .toEqual({ type: 'every', interval, unit });
    },
  );
});
