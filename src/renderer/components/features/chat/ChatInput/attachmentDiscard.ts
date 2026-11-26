import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import type { AttachmentMergeResult } from './attachmentDedupe';
import { notifyAttachmentMerge as notifyMerge } from './attachmentMergeToast';

const logger = createLogger('AttachmentDiscard');

export function discardRejectedAttachments(result: AttachmentMergeResult): void {
  const discard = ipcService.discardUploadedFiles;
  if (!discard) return;
  const protectedPaths = [...result.attachments, ...result.existingAttachments]
    .flatMap((attachment) => [attachment.path, ...(attachment.files ?? []).map((file) => file.absolutePath)])
    .filter((filePath): filePath is string => Boolean(filePath))
    .map((filePath) => filePath.replace(/\\/g, '/'));
  // The server removes a whole UUID directory. Protect siblings inside a kept folder too.
  const uploadDirectory = (filePath: string) => filePath.match(/^(.*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i)?.[1];
  const paths = [...new Set(result.rejectedIncoming
    .filter((attachment) => attachment.category !== 'folder')
    .map((attachment) => attachment.path)
    .filter((filePath): filePath is string => Boolean(filePath))
    .filter((filePath) => {
      const normalized = filePath.replace(/\\/g, '/');
      const directory = uploadDirectory(normalized);
      return !protectedPaths.some((kept) => kept === normalized || (directory && uploadDirectory(kept) === directory));
    }))];
  if (!paths.length) return;
  try {
    void discard(paths).catch((error: unknown) => logger.warn('Failed to discard rejected uploads', { error }));
  } catch (error) {
    logger.warn('Failed to discard rejected uploads', { error });
  }
}

/** Keep the toast and cleanup paired at every composer merge entry point. */
export function notifyAttachmentMerge(...args: Parameters<typeof notifyMerge>): void {
  notifyMerge(...args);
  discardRejectedAttachments(args[0]);
}
