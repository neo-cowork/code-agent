import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const EnvAssistRequest = z.object({
  action: z.enum(['act', 'enableSettingGrant', 'getAvailability', 'recheck', 'recheckSettingGrant']),
  payload: z.unknown().optional(),
});

export const EnvAssistSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.ENV_ASSIST, payload: EnvAssistRequest }),
  ACTIONS: EnvAssistRequest.shape.action.options,
  act: z.object({
    noticeId: z.string().min(1),
    actionKind: z.enum(['open_settings_pane', 'request_grant']),
    payload: z.object({ pane: z.enum(['automation', 'calendars', 'accessibility', 'screenCapture', 'inputMonitoring']) }).strict(),
  }).strict(),
  recheck: z.object({ noticeId: z.string().min(1) }).strict(),
  /** Whitelist: only settings that are gated by a permission grant. */
  settingGrant: z.object({ setting: z.literal('meetingCalendarReminder') }).strict(),
};
