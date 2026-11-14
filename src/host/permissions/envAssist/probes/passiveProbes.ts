import { createLogger } from '../../../services/infra/logger';
import type { PassiveBridge, ProbeResult, ReadOnlyProbe } from './types';

const logger = createLogger('EnvAssistProbes');

function passiveProbe(name: string, bridge: PassiveBridge | null, read: (bridge: PassiveBridge) => Promise<ProbeResult>): ReadOnlyProbe {
  return async () => {
    if (!bridge) {
      const reason = `probe_unavailable:${name}:no_native_bridge`;
      logger.warn(reason);
      return { status: 'unavailable', reason };
    }
    try { return await read(bridge); } catch {
      const reason = `probe_unavailable:${name}:native_error`;
      logger.warn(reason);
      return { status: 'unavailable', reason };
    }
  };
}

export function accessibilityProbe(bridge: PassiveBridge | null): ReadOnlyProbe {
  return passiveProbe('accessibility', bridge, async (native) => ({ status: await native.AXIsProcessTrusted() ? 'granted' : 'denied' }));
}

export function screenRecordingProbe(bridge: PassiveBridge | null): ReadOnlyProbe {
  return passiveProbe('screen_recording', bridge, async (native) => ({ status: await native.CGPreflightScreenCaptureAccess() ? 'granted' : 'denied' }));
}

export function automationProbe(bridge: PassiveBridge | null, targetBundleId: string): ReadOnlyProbe {
  return passiveProbe('automation', bridge, async (native) => {
    const code = await native.AEDeterminePermissionToAutomateTarget(targetBundleId, false);
    switch (code) {
      case 0: return { status: 'granted' };
      case -1743: return { status: 'denied' };
      case -1744: return { status: 'undecided' };
      case -600: return { status: 'not_running' };
      default: throw new Error('probe_invalid_native_code');
    }
  });
}
