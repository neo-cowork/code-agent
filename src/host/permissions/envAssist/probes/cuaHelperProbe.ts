import type { CuaHelperPermissionState } from '../cua/helperPermissionState';
import type { ProbeResult, ReadOnlyProbe } from './types';

/** Helper-identity probes: read the cua helper's own state via a non-prompting check. */
export function cuaHelperProbe(
  read: () => Promise<CuaHelperPermissionState>,
  pane: 'accessibility' | 'screenCapture',
): ReadOnlyProbe {
  return async (): Promise<ProbeResult> => {
    const state = await read();
    if (state.status === 'unavailable') return { status: 'unavailable', reason: state.reason };
    const value = pane === 'accessibility' ? state.accessibility : state.screenRecording;
    if (value === undefined) return { status: 'unavailable', reason: `probe_unavailable:cua_helper:${pane}_missing` };
    return { status: value ? 'granted' : 'denied' };
  };
}
