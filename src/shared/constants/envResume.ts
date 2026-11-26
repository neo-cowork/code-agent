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
