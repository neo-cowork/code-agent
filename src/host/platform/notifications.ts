// ============================================================================
// Platform: Notifications - native notification support detection
// ============================================================================

/** Native notifications are supported on macOS via the Agent Neo shell. */
export class Notification {
  static isSupported(): boolean {
    return process.platform === 'darwin';
  }
}
