import type { ElectronAPI } from '../../shared/ipc/api';
import { MAX_UPLOAD_DISCARD_PATHS } from '../../shared/constants/uploadDiscard';

/** Cleanup uses its own route, outside the single-file upload quota. */
export function createDiscardTempUpload(baseUrl: string, getAuthHeaders: () => Record<string, string>): NonNullable<ElectronAPI['discardUploadedFiles']> {
  return async (paths) => {
    const uniquePaths = [...new Set(paths)];
    for (let offset = 0; offset < uniquePaths.length; offset += MAX_UPLOAD_DISCARD_PATHS) {
      const response = await fetch(`${baseUrl}/api/upload/discard`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: uniquePaths.slice(offset, offset + MAX_UPLOAD_DISCARD_PATHS) }),
      });
      if (!response.ok) throw new Error(`Upload discard failed: ${response.status}`);
    }
  };
}
