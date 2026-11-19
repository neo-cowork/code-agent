// Run-policy bounce text shared by the executor backstop and foreground admission.
// The handoff sentence names no tool and does not say the call was disabled.
import { EXCEL_READ_ACTIONS } from '../../shared/constants/excelActions';
import { resolveToolAlias } from '../services/toolSearch/deferredTools';
import {
  BACKGROUND_HANDOFF_SENTENCE,
  BACKGROUND_HANDOFF_SENTENCE_EN,
} from '../services/commandCenter/delegationGuidance';
import { readUiLanguage } from '../session/sessionTitleHostPrompt';

const ROLE_BOUNDARY_DENIAL = 'is not in this turn\'s tool list. The call was not executed; use a listed tool within the current role boundary.';

/** Foreground ExcelAutomate is read-only. Missing or unknown action fails closed. */
export function isForegroundExcelNonReadParams(
  foregroundToolFace: boolean | undefined,
  toolName: string,
  params: { action?: unknown } | null | undefined,
): boolean {
  if (foregroundToolFace !== true) return false;
  if (resolveToolAlias(toolName).toLowerCase() !== 'excelautomate') return false;
  const action = typeof params?.action === 'string' ? params.action : '';
  return !EXCEL_READ_ACTIONS.has(action);
}

/** User-visible executor error. Handoff copy only when this turn can delegate. */
export function formatRunPolicyDenial(toolName: string, canHandOff: boolean): string {
  if (!canHandOff) return `${toolName} ${ROLE_BOUNDARY_DENIAL}`;
  return readUiLanguage() === 'en' ? BACKGROUND_HANDOFF_SENTENCE_EN : BACKGROUND_HANDOFF_SENTENCE;
}
