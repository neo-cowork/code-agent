import React from 'react';
import { Button } from '../../../primitives';

interface SaaSConnectorCardFooterProps {
  status: {
    id: string;
    requiresClientSecret: boolean;
    clientSecretConfigured: boolean;
  };
  text: {
    actions: { cancel: string };
    clientSecretSaved: string;
  };
  connecting: boolean;
  onCancel: (providerId: string) => unknown;
}

// 状态词只在卡片头部徽标里说一次；这里只留取消按钮和「密钥已保存」备注。
export const SaaSConnectorCardFooter: React.FC<SaaSConnectorCardFooterProps> = ({
  status,
  text,
  connecting,
  onCancel,
}) => {
  if (connecting) {
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void onCancel(status.id)}
        data-testid={`saas-cancel-${status.id}`}
        className="mt-3"
      >
        {text.actions.cancel}
      </Button>
    );
  }

  if (!(status.requiresClientSecret && status.clientSecretConfigured)) return null;

  return <div className="mt-3 text-[11px] text-zinc-500">{text.clientSecretSaved}</div>;
};
