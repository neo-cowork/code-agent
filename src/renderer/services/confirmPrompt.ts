import type { ConfirmDialogVariant } from '../components/composites/ConfirmDialog';
import { createLogger } from '../utils/logger';

interface ConfirmPromptOptions {
  title: string;
  message: string;
  confirmText: string;
  variant: ConfirmDialogVariant;
}

interface ConfirmPromptRequest extends ConfirmPromptOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

const logger = createLogger('ConfirmPrompt');
const listeners = new Set<() => void>();
let current: ConfirmPromptRequest | null = null;
let nextId = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestConfirm(options: ConfirmPromptOptions): Promise<boolean> {
  if (listeners.size === 0) {
    logger.warn('Confirmation requested without a mounted host');
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    current?.resolve(false);
    current = { ...options, id: ++nextId, resolve };
    emit();
  });
}

export function getConfirmPrompt(): ConfirmPromptRequest | null {
  return current;
}

export function settleConfirmPrompt(id: number, confirmed: boolean): void {
  if (current?.id !== id) return;
  const { resolve } = current;
  current = null;
  resolve(confirmed);
  emit();
}

export function subscribeConfirmPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && current) settleConfirmPrompt(current.id, false);
  };
}
