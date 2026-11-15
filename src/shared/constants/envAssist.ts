/** User-click capabilities expire even when a native request has not started. */
export const ENV_ASSIST_CLICK_TTL_MS = 30_000;

/**
 * osascript budget while macOS may still be showing the "allow Neo to control …" dialog: the script blocks until the
 * user answers, so the ordinary 15s connector budget would report a user who is still reading the dialog as a timeout.
 * Kept under the 120s generic tool budget so the connector, not the outer watchdog, reports a real hang.
 */
export const APPLE_EVENTS_PERMISSION_PROMPT_TIMEOUT_MS = 90_000;

/** Loopback request timeout when calling the desktop shell env-assist endpoint. */
export const ENV_ASSIST_BRIDGE_TIMEOUT_MS = 15_000;
