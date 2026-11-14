import type { ElectronAPI } from '../../shared/ipc/api';

/** A distinct endpoint/bucket: never consumes the single-file upload quota. */
export function createFolderBatchUpload(baseUrl: string, getAuthHeaders: () => Record<string, string>): NonNullable<ElectronAPI['uploadFolderBatch']> {
  return async (files) => {
    const body = new FormData();
    files.forEach(({ file, relativePath }, index) => {
      body.append(`file${index}`, file);
      body.append(`relativePath${index}`, relativePath);
    });
    const response = await fetch(`${baseUrl}/api/upload/temp/batch`, {
      method: 'POST', headers: getAuthHeaders(), body,
    });
    if (!response.ok) throw new Error(`Batch upload failed: ${response.status}`);
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object'
      || !('root' in result) || typeof result.root !== 'string'
      || !('files' in result) || !Array.isArray(result.files) || result.files.length !== files.length) {
      throw new Error('Invalid batch upload response');
    }
    const entries: unknown[] = result.files;
    const uploaded = entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object'
        || !('relativePath' in entry) || entry.relativePath !== files[index].relativePath
        || !('path' in entry) || typeof entry.path !== 'string') {
        throw new Error('Invalid batch upload response');
      }
      return { relativePath: files[index].relativePath, path: entry.path };
    });
    return { root: result.root, files: uploaded };
  };
}
