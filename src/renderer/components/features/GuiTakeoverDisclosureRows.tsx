import type { SwarmAgentContextSnapshot } from '@shared/contract/swarm';
import { useI18n } from '../../hooks/useI18n';

export function GuiTakeoverDisclosureRows({ disclosures }: { disclosures?: SwarmAgentContextSnapshot['guiDisclosures'] }) {
  const { t } = useI18n();
  return disclosures?.map(({ app, callId }) => (
    <div
      key={callId}
      className="whitespace-normal break-words text-xs leading-5 text-zinc-400"
      data-testid="gui-takeover-disclosure"
    >
      {t.guiTakeover.disclosure.replace('{app}', () => app)}
    </div>
  ));
}
