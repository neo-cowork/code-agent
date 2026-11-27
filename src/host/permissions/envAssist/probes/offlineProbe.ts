import type { RunEnvelope } from '../../../../shared/contract/durableRun';
import { OFFLINE_NEUTRAL_PROBE_ENDPOINT, OFFLINE_PROBE_TIMEOUT_MS } from '../../../../shared/constants/envResume';
import axios from 'axios';
import { getHttpsAgent } from '../../../model/providers/providerHttp';
import { createLogger } from '../../../services/infra/logger';

type OfflineBlock = Extract<RunEnvelope['envBlocked'], { class: 'offline' }>;
const logger = createLogger('OfflineProbe');

/** HEAD without credentials. An HTTP response proves reachability unless the gateway/service is unavailable. */
export async function probeOfflineNetwork(
  block: Pick<OfflineBlock, 'endpoint' | 'provider'>,
  endpoints = process.env.CODE_AGENT_OFFLINE_PROBE_ENDPOINTS?.split(','),
): Promise<boolean> {
  const results = await Promise.all([
    { point: 'provider', url: endpoints?.[0] || block.endpoint },
    { point: 'neutral', url: endpoints?.[1] || OFFLINE_NEUTRAL_PROBE_ENDPOINT },
  ].map(async ({ point, url }) => {
    try {
      const agent = getHttpsAgent(url, block.provider);
      const { status } = await axios.head(url, {
        httpAgent: agent, httpsAgent: agent, proxy: false, maxRedirects: 0,
        validateStatus: () => true, signal: AbortSignal.timeout(OFFLINE_PROBE_TIMEOUT_MS),
      });
      return { point, reachable: status < 500, status };
    } catch {
      return { point, reachable: false };
    }
  }));
  const connected = results.some((result) => result.reachable);
  logger.info('Offline reachability probe', { results, offline: !connected });
  return connected;
}
