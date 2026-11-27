/** Bounded passive environment polling (ADR-090 §8). */
export const ENV_RESUME_POLL_INTERVAL_MS = 1_000;
export const ENV_RESUME_TIMEOUT_MS = 120_000;
/** A parked call's user confirmation stays reusable for the auto-resumed run this long (N-ENV-ASSIST-S3-RESUME-REST2-FU2). */
export const PARKED_CALL_APPROVAL_TTL_MS = 600_000;

export const OFFLINE_RESUME_POLL_INTERVAL_MS = 5_000;
export const OFFLINE_RESUME_TIMEOUT_MS = 10 * 60_000;
export const OFFLINE_PROBE_TIMEOUT_MS = 3_000;
export const OFFLINE_NEUTRAL_PROBE_ENDPOINT = 'https://www.cloudflare.com/cdn-cgi/trace';
