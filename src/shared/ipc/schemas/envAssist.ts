import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const EnvAssistRequest = z.object({
  action: z.enum(['act', 'getAvailability']),
  payload: z.unknown().optional(),
});

export const EnvAssistSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.ENV_ASSIST, payload: EnvAssistRequest }),
  ACTIONS: EnvAssistRequest.shape.action.options,
  act: z.object({
    noticeId: z.string().min(1),
    actionKind: z.enum(['open_settings_pane', 'request_grant']),
    payload: z.object({ pane: z.enum(['automation', 'accessibility', 'screenCapture']) }).strict(),
  }).strict(),
};
