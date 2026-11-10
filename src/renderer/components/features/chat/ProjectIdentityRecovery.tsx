import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { useProjectIdentityRecoveryStore } from '../../../stores/projectIdentityRecoveryStore';

export function ProjectIdentityRecovery({ messageId }: { messageId?: string }) {
  const { t } = useI18n();
  const recovery = useProjectIdentityRecoveryStore(state => messageId ? state.entries[messageId] : undefined);
  if (!messageId || !recovery || recovery.phase === 'closed') return null;
  return (
    <div className="mt-2 flex gap-2" data-testid="project-identity-recovery">
      <Button size="sm" loading={recovery.phase === 'confirming'}
        onClick={() => { void useProjectIdentityRecoveryStore.getState().confirm(messageId); }}>
        {t.serverConnection.confirmFolderIdentity}
      </Button>
      <Button size="sm" variant="ghost" disabled={recovery.phase === 'confirming'}
        onClick={() => useProjectIdentityRecoveryStore.getState().dismiss(messageId)}>
        {t.serverConnection.dismissFolderIdentity}
      </Button>
    </div>
  );
}
