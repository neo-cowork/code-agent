/** Bounded passive environment polling (ADR-090 §8). */
export const ENV_RESUME_POLL_INTERVAL_MS = 1_000;
export const ENV_RESUME_TIMEOUT_MS = 120_000;
/**
 * A runtime Neo installs itself (ADR-090 §3 row 7) has no hard window: a ~300 MB download legitimately takes minutes.
 * The wait only ends when the install reports failure, or when its progress has not moved for this long.
 */
export const ENV_RESUME_RUNTIME_STALL_MS = 300_000;
/** How often a "preparing" card re-reads install progress. */
export const ENV_RUNTIME_PROGRESS_INTERVAL_MS = 1_000;
/**
 * A runtime card that says the download servers were unreachable re-probes them this often (a read-only check, no
 * download) and retries the install once one answers — the "I will retry when you are online" the card promises.
 */
export const ENV_RUNTIME_OFFLINE_RECHECK_INTERVAL_MS = 30_000;
/** A parked call's user confirmation stays reusable for the auto-resumed run this long (N-ENV-ASSIST-S3-RESUME-REST2-FU2). */
export const PARKED_CALL_APPROVAL_TTL_MS = 600_000;

export const OFFLINE_RESUME_POLL_INTERVAL_MS = 5_000;
export const OFFLINE_RESUME_TIMEOUT_MS = 10 * 60_000;
export const OFFLINE_PROBE_TIMEOUT_MS = 3_000;
export const OFFLINE_NEUTRAL_PROBE_ENDPOINT = 'https://www.cloudflare.com/cdn-cgi/trace';
