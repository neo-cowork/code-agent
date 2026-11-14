/** Environment notices carry translation keys, never operating-system diagnostics. */
export type EnvBlockerClass =
  | 'perm_automation' | 'perm_accessibility' | 'perm_screen_recording'
  | 'perm_input_monitoring' | 'perm_notifications' | 'perm_files'
  | 'runtime_missing' | 'login_expired'
  | 'quota_exhausted' | 'model_capability' | 'offline' | 'first_launch';

// knip-ratchet：两个别名只在本文件内被 EnvAssistNotice/EnvAssistActRequest 引用，
// 外部无人 import，export 会被 dead-export 棘轮打红——保持文件内可见、不再导出。
type EnvAssistPhase =
  | 'diagnosing' | 'fixing' | 'needs_user' | 'verifying'
  | 'resolved' | 'unconfirmed' | 'declined' | 'unsupported';

type EnvAssistActionKind =
  | 'open_settings_pane' | 'request_grant' | 'reauthorize' | 'open_app_settings'
  | 'restart_and_continue' | 'recheck' | 'skip_step';

export interface EnvAssistNotice {
  id: string;
  sessionId: string;
  runId: string;
  class: EnvBlockerClass;
  target?: { id: string; labelKey: string };
  phase: EnvAssistPhase;
  sentenceKey: string;
  sentenceParams?: Record<string, string | number>;
  progress?: { percent: number };
  action?: {
    kind: EnvAssistActionKind;
    labelKey: string;
    payload?:
      | { pane: 'automation' | 'accessibility' | 'screenCapture' | 'inputMonitoring' | 'notifications' | 'filesAndFolders' | 'fullDiskAccess' | 'network' }
      | { serverName: string; requiredScope?: string }
      | { route: string };
  };
  resume: { mode: 'auto' | 'manual'; parkId?: string };
  doneKey?: string;
  updatedAt: number;
  devDiagnostic?: { rawRef: string };
}

export interface EnvAssistActRequest {
  noticeId: string;
  actionKind: EnvAssistActionKind;
  payload?: NonNullable<EnvAssistNotice['action']>['payload'];
}

export interface EnvAssistActResult {
  status: 'opened' | 'not_available' | 'rejected' | 'checked';
  outcome?: { status: 'granted' | 'denied' | 'undecided' | 'not_running' } | { status: 'unavailable'; reason: string };
}

/** Runtime validation for durable environment checkpoints. */
export function isEnvBlockerClass(value: unknown): value is EnvBlockerClass {
  return typeof value === 'string' && Object.hasOwn({
    perm_automation: true, perm_accessibility: true, perm_screen_recording: true,
    perm_input_monitoring: true, perm_notifications: true, perm_files: true,
    runtime_missing: true, login_expired: true, quota_exhausted: true,
    model_capability: true, offline: true, first_launch: true,
  } satisfies Record<EnvBlockerClass, true>, value);
}
