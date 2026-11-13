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
    const result = await response.json();
    if (typeof result?.root !== 'string' || !Array.isArray(result.files)
      || result.files.length !== files.length
      || !result.files.every((entry: { relativePath?: unknown; path?: unknown }, index: number) =>
        entry.relativePath === files[index].relativePath && typeof entry.path === 'string')) {
      throw new Error('Invalid batch upload response');
    }
    return result;
  };
}
