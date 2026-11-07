import { clearSessionCachePrompt } from '../agent/runtime/turnCostPersistence';
import { clearSessionCacheHits } from '../model/cacheHitObservation';
import { clearBrowserSessionGrants } from '../permissions/browserSessionGrant';
import { getToolSearchService } from '../services/toolSearch/toolSearchService';
import { releaseMemoryIndexSnapshot } from '../lightMemory/indexLoader';

/** Release process-local observations when a host session ends. */
export function clearSessionRuntimeCaches(sessionId: string): void {
  clearSessionCachePrompt(sessionId);
  clearSessionCacheHits(sessionId);
  clearBrowserSessionGrants(sessionId);
  getToolSearchService().releaseSession(sessionId);
  releaseMemoryIndexSnapshot(sessionId);
}
