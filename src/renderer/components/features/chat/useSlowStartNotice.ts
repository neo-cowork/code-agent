import { useEffect, useState } from 'react';
import { STARTUP_TIMEOUTS } from '@shared/constants';

/** A single copy change for admission only; never upgrades an active generation. */
export function useSlowStartNotice(startTime: number, phase: string | undefined): boolean {
  const eligible = phase === 'submitting' || phase === 'queued';
  const [notice, setNotice] = useState(() => (
    eligible && Date.now() - startTime >= STARTUP_TIMEOUTS.SLOW_START_NOTICE_MS
      ? { startTime, phase } : null
  ));

  useEffect(() => {
    setNotice(null);
    if (!eligible) return;
    const remaining = STARTUP_TIMEOUTS.SLOW_START_NOTICE_MS - (Date.now() - startTime);
    if (remaining <= 0) {
      setNotice({ startTime, phase });
      return;
    }
    const timer = setTimeout(() => setNotice({ startTime, phase }), remaining);
    return () => clearTimeout(timer);
  }, [eligible, phase, startTime]);

  return eligible && notice?.startTime === startTime && notice.phase === phase;
}
