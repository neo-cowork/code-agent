// ============================================================================
// useFileUpload - 文件上传处理 Hook
// ============================================================================

import { useCallback } from 'react';
import { MAX_FOLDER_PATH_UPLOADS } from '../../../../../shared/constants/chatUploads';
import type { MessageAttachment } from '../../../../../shared/contract';
import {
  MAX_FILE_SIZE,
  MAX_FOLDER_FILES,
  getFileCategory,
  readDirectoryEntry,
  extractPdfText,
  generateAttachmentId,
} from './utils';
import { toast } from '../../../../hooks/useToast';
import { createLogger } from '../../../../utils/logger';
import ipcService from '../../../../services/ipcService';
import { buildArchiveManifest, buildPresentationSummary } from './attachmentSummaries';
import { useI18n } from '../../../../hooks/useI18n';
import { formatFileSize } from './formatFileSize';
import { useComposerRejectedUploadsStore } from '../../../../stores/composerRejectedUploadsStore';

const logger = createLogger('useFileUpload');

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * 文件上传处理 Hook
 * 处理单个文件和文件夹的上传逻辑
 */
export function useFileUpload() {
  const { t } = useI18n();
  const showToast = toast.show;

  // 处理单个文件
  const processFile = useCallback(async (file: File): Promise<MessageAttachment | null> => {
    const { category, language } = getFileCategory(file);
    const id = generateAttachmentId();
    const relativePath = (file as File & { relativePath?: string }).relativePath;
    const displayName = relativePath || file.name;

    let filePath: string | undefined;
    try {
      filePath = await ipcService.getPathForFile(file);
    } catch (e) {
      logger.warn('processFile - failed to get path', { error: e });
    }

    // PDF 大文件只传路径，不受 MAX_FILE_SIZE 限制
    if (category === 'pdf' && filePath) {
      const { text, pageCount } = await extractPdfText(t, filePath);
      return {
        id, type: 'file', category: 'pdf', name: displayName, size: file.size,
        mimeType: 'application/pdf', data: text, pageCount, path: filePath,
      };
    }

    // 非 PDF 文件超限时 toast 提示
    if (file.size > MAX_FILE_SIZE) {
      logger.warn('File is too large (max 10MB)', { fileName: file.name, size: file.size });
      useComposerRejectedUploadsStore.getState().add({ name: displayName, size: file.size });
      showToast('warning', t.chatInput.uploadFileTooLarge.replace('{name}', file.name).replace('{size}', formatFileSize(file.size)));
      return null;
    }

    // Word (.docx) 文件处理
    if (category === 'document' && filePath && file.name.toLowerCase().endsWith('.docx')) {
      try {
        const result = await ipcService.extractDocxHtml(filePath);
        if (result) {
          const docxJson = JSON.stringify({
            title: file.name.replace(/\.docx$/i, ''),
            paragraphs: result.paragraphs,
            text: result.text,
            wordCount: result.wordCount,
          });
          return {
            id, type: 'file', category: 'document', name: displayName, size: file.size,
            mimeType: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            data: result.text, path: filePath, docxJson,
          };
        }
      } catch (e) {
        logger.warn('Docx extraction failed', { error: e });
      }
      showToast('error', t.chatInput.uploadDocxFailed.replace('{name}', file.name));
      return null;
    }

    // Excel 文件处理
    if (category === 'excel' && filePath) {
      const result = await ipcService.extractExcelText(filePath);
      if (result) {
        // Also extract JSON for SpreadsheetBlock interactive rendering
        let sheetsJson: string | undefined;
        try {
          const jsonResult = await ipcService.extractExcelJson(filePath);
          if (jsonResult) sheetsJson = JSON.stringify(jsonResult);
        } catch { /* non-blocking */ }

        return {
          id, type: 'file', category: 'excel', name: displayName, size: file.size,
          mimeType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: result.text, sheetCount: result.sheetCount, rowCount: result.rowCount, path: filePath,
          sheetsJson,
        };
      }
      logger.warn('Excel extraction failed, falling back to binary warning');
      showToast('error', t.chatInput.uploadXlsxFailed.replace('{name}', file.name));
      return null;
    }

    if (category === 'presentation') {
      const data = await readFileAsDataUrl(file);
      if (!data) {
        showToast('error', t.chatInput.uploadPptFailed.replace('{name}', file.name));
        return null;
      }

      const summary = await buildPresentationSummary(file);
      return {
        id, type: 'file', category: 'presentation', name: displayName, size: file.size,
        mimeType: file.type || (file.name.toLowerCase().endsWith('.pptx')
          ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          : 'application/vnd.ms-powerpoint'),
        data, path: filePath, pptJson: JSON.stringify(summary),
      };
    }

    if (category === 'archive') {
      const data = await readFileAsDataUrl(file);
      if (!data) {
        showToast('error', t.chatInput.uploadArchiveFailed.replace('{name}', file.name));
        return null;
      }

      const archiveManifest = await buildArchiveManifest(file);
      return {
        id, type: 'file', category: 'archive', name: displayName, size: file.size,
        mimeType: file.type || 'application/octet-stream',
        data, path: filePath, archiveManifest,
      };
    }

    if (category === 'document') {
      logger.warn('Unsupported Office document type', { fileName: file.name, mimeType: file.type });
      showToast('warning', t.chatInput.uploadUnsupported.replace('{name}', file.name));
      return null;
    }

    if (category === 'image') {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const data = e.target?.result as string;
          resolve({
            id, type: 'image', category: 'image', name: displayName, size: file.size,
            mimeType: file.type, data, thumbnail: data, path: filePath,
          });
        };
        reader.onerror = () => {
          showToast('error', t.chatInput.uploadImageFailed.replace('{name}', file.name));
          resolve(null);
        };
        reader.readAsDataURL(file);
      });
    }

    if (category === 'audio' || category === 'video') {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const data = e.target?.result as string;
          resolve({
            id, type: 'file', category, name: displayName, size: file.size,
            mimeType: file.type || (category === 'audio' ? 'audio/mpeg' : 'video/mp4'),
            data, path: filePath,
          });
        };
        reader.onerror = () => {
          const kind = category === 'audio' ? t.chatInput.mediaKindAudio : t.chatInput.mediaKindVideo;
          showToast('error', t.chatInput.uploadMediaFailed.replace('{name}', file.name).replace('{kind}', kind));
          resolve(null);
        };
        reader.readAsDataURL(file);
      });
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const data = e.target?.result as string;
        // .csv：从同一份已读文本构建 sheetsJson，消息气泡里渲染与 xlsx 同款的
        // 交互表格。动态 import 让 papaparse 留在懒 chunk（同 CsvTable 拆包策略）；
        // 解析失败静默回退为普通图标卡。
        let sheetsJson: string | undefined;
        if (category === 'data' && file.name.toLowerCase().endsWith('.csv')) {
          try {
            const { buildCsvSheetsJson } = await import('./csvSheets');
            sheetsJson = buildCsvSheetsJson(displayName, data);
          } catch (err) {
            logger.warn('csv sheetsJson build failed, falling back to icon card', { fileName: file.name, error: err });
          }
        }
        resolve({
          id, type: 'file', category, name: displayName, size: file.size,
          mimeType: file.type || 'text/plain', data, language, path: filePath, sheetsJson,
        });
      };
      reader.onerror = () => {
        showToast('error', t.chatInput.uploadTextFailed.replace('{name}', file.name));
        resolve(null);
      };
      reader.readAsText(file);
    });
  }, [showToast]);

  // 处理文件夹
  const processFolderEntry = useCallback(async (
    dirEntry: FileSystemDirectoryEntry,
    folderName: string
  ): Promise<MessageAttachment | null> => {
    const files = await readDirectoryEntry(dirEntry, folderName);
    if (files.length === 0) {
      logger.warn('no processable files in folder', { folderName });
      showToast('warning', t.chatInput.uploadEmptyFolder.replace('{name}', folderName));
      return null;
    }

    const filesToProcess = files.slice(0, MAX_FOLDER_FILES);
    const fileContents: NonNullable<MessageAttachment['files']> = [];
    const byType: Record<string, number> = {};
    let totalSize = 0;

    for (const file of filesToProcess) {
      const relativePath = (file as File & { relativePath?: string }).relativePath || file.name;
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      byType[ext] = (byType[ext] || 0) + 1;
      totalSize += file.size;

      const { category } = getFileCategory(file);
      // Only known text formats may be decoded. This also catches images with no MIME.
      const binary = !['text', 'code', 'data', 'html'].includes(category);
      const entry: NonNullable<MessageAttachment['files']>[number] = {
        path: relativePath, size: file.size,
        ...(binary ? { type: category, binary: true } : {}),
      };
      if (!binary) {
        try {
          entry.content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.onerror = () => reject(new Error('read failed'));
            reader.readAsText(file);
          });
        } catch {
          logger.warn('failed to read file', { path: relativePath });
        }
      }
      fileContents.push(entry);
    }

    // Binary files need tools; prioritize their uploads within the transport budget.
    const pathOrder = filesToProcess.map((_, index) => index)
      .sort((a, b) => Number(!!fileContents[b].binary) - Number(!!fileContents[a].binary))
      .slice(0, MAX_FOLDER_PATH_UPLOADS);
    for (const index of pathOrder) {
      try {
        const absolutePath = await ipcService.getPathForFile(filesToProcess[index]);
        if (absolutePath && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(absolutePath)) {
          fileContents[index].absolutePath = absolutePath;
        }
      } catch (error) {
        logger.warn('processFolderEntry - failed to get file path', { error });
      }
    }

    // Separate temp uploads have different roots. Never invent a shared folder path.
    const folderRoots = fileContents.map((entry) => {
      const absolutePath = entry.absolutePath?.replace(/\\/g, '/');
      return absolutePath?.endsWith('/' + entry.path)
        ? absolutePath.slice(0, -entry.path.length) + folderName
        : undefined;
    });
    const folderPath = folderRoots[0] && folderRoots.every((root) => root === folderRoots[0])
      ? folderRoots[0] : undefined;

    const id = generateAttachmentId();
    const typeStats = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `${ext}(${count})`)
      .join(', ');
    const summary = `${t.chatInput.folderSummaryCount.replace('{count}', String(files.length))}${files.length > MAX_FOLDER_FILES ? t.chatInput.folderSummaryTruncated.replace('{max}', String(MAX_FOLDER_FILES)) : ''}: ${typeStats}${folderPath ? '' : `\n${t.chatInput.folderPathUnresolved}`}`;

    return {
      id, type: 'file', category: 'folder', name: folderName, size: totalSize,
      mimeType: 'inode/directory', data: summary, files: fileContents, path: folderPath,
      folderStats: { totalFiles: files.length, totalSize, byType },
    };
  }, [showToast]);

  return { processFile, processFolderEntry };
}

export default useFileUpload;
