import { z } from 'zod';
import type { EnvAssistNotice } from './envAssist';

export const EnvAssistNoticeSchema = z.object({
  id: z.string(), sessionId: z.string(), runId: z.string(),
  class: z.enum(['perm_automation', 'perm_accessibility', 'perm_screen_recording', 'perm_input_monitoring', 'perm_notifications', 'perm_files', 'runtime_missing', 'login_expired', 'quota_exhausted', 'model_capability', 'offline', 'first_launch']),
  target: z.object({ id: z.string(), labelKey: z.string() }).optional(),
  phase: z.enum(['diagnosing', 'fixing', 'needs_user', 'verifying', 'resolved', 'unconfirmed', 'declined', 'unsupported']),
  sentenceKey: z.string(), sentenceParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  progress: z.object({ percent: z.number().min(0).max(100) }).optional(),
  action: z.object({
    kind: z.enum(['open_settings_pane', 'request_grant', 'reauthorize', 'open_app_settings', 'restart_and_continue', 'recheck', 'skip_step']),
    labelKey: z.string(),
    payload: z.union([
      z.object({ pane: z.enum(['automation', 'accessibility', 'screenCapture', 'inputMonitoring', 'notifications', 'filesAndFolders', 'fullDiskAccess', 'network']) }),
      z.object({ serverName: z.string(), requiredScope: z.string().optional() }), z.object({ route: z.string() }),
    ]).optional(),
  }).optional(),
  resume: z.object({ mode: z.enum(['auto', 'manual']), parkId: z.string().optional() }),
  doneKey: z.string().optional(), updatedAt: z.number(),
  devDiagnostic: z.object({ rawRef: z.string() }).optional(),
}) satisfies z.ZodType<EnvAssistNotice>;
