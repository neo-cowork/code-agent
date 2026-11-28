// ============================================================================
// Pending Session Title Tracker
// ============================================================================
// Tracks fire-and-forget session auto-title jobs so background terminal
// notifications can wait (bounded) for the final title before dispatching an
// immutable OS banner.

const pendingTitleJobs = new Map<string, Promise<void>>();

/**
 * Register an in-flight auto-title job for a session and forget it once it settles.
 */
export function trackPendingSessionTitle(sessionId: string, promise: Promise<unknown>): void {
  const tracked = promise.then(
    () => undefined,
    () => undefined,
  );
  pendingTitleJobs.set(sessionId, tracked);
  void tracked.finally(() => {
    if (pendingTitleJobs.get(sessionId) === tracked) {
      pendingTitleJobs.delete(sessionId);
    }
  });
}

/**
 * Synchronously check whether an auto-title job is currently in flight for a session.
 * Lets terminal settlement callers decide whether to detach the bounded wait off
 * their `await` chain (avoiding blocking settlement or adding a microtask when idle).
 */
export function hasPendingSessionTitle(sessionId: string): boolean {
  return pendingTitleJobs.has(sessionId);
}

/**
 * Wait up to `timeoutMs` for a session's in-flight auto-title job to settle.
 * Resolves immediately with `status: 'none'` when nothing is pending.
 */
export async function waitForPendingSessionTitle(
  sessionId: string,
  timeoutMs: number,
): Promise<{ status: 'none' | 'settled' | 'timeout'; waitedMs: number }> {
  const pending = pendingTitleJobs.get(sessionId);
  if (!pending) {
    return { status: 'none', waitedMs: 0 };
  }
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    await Promise.race([
      pending.then(() => {
        settled = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  return {
    status: settled ? 'settled' : 'timeout',
    waitedMs: Math.max(0, Date.now() - startedAt),
  };
}
