import React, { useSyncExternalStore } from 'react';
import { ConfirmDialog } from './composites/ConfirmDialog';
import { getConfirmPrompt, settleConfirmPrompt, subscribeConfirmPrompt } from '../services/confirmPrompt';
import { Z_LAYERS } from '../styles/zLayers';

export function ConfirmPromptHost() {
  const request = useSyncExternalStore(subscribeConfirmPrompt, getConfirmPrompt);
  if (!request) return null;
  return (
    <ConfirmDialog
      key={request.id}
      isOpen
      title={request.title}
      message={<p className="whitespace-pre-line text-sm text-zinc-400 leading-relaxed">{request.message}</p>}
      confirmText={request.confirmText}
      variant={request.variant}
      onConfirm={() => settleConfirmPrompt(request.id, true)}
      onCancel={() => settleConfirmPrompt(request.id, false)}
      zIndex={Z_LAYERS.confirmPrompt}
      portal
    />
  );
}
