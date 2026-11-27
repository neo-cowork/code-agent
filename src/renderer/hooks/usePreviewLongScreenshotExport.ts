import { useCallback, useRef, useState, type RefObject } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from './useI18n';
import { toast, useToastStore } from './useToast';
import ipcService from '../services/ipcService';
import { createLogger } from '../utils/logger';
import {
  capturePreviewFrame,
  PreviewCaptureError,
  type PreviewCaptureErrorReason,
} from '../utils/previewFrameBridge';

const logger = createLogger('PreviewExport');

type PreviewExportFailureReason =
  | PreviewCaptureErrorReason
  | 'source-mode'
  | 'not-ready'
  | 'save-failed';

interface UsePreviewLongScreenshotExportOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  previewFilePath: string | null;
  isHtml: boolean;
  mode: string;
}

function extractBaseName(filePath: string | null | undefined): string {
  if (!filePath) return 'preview';
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || 'preview';
}

function extractErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  if (typeof error === 'string') return error.slice(0, 300);
  if (error === undefined || error === null) return '';
  return String(error).slice(0, 300);
}

function logPreviewExportNotSaved(
  reason: PreviewExportFailureReason,
  fileBaseName: string,
  error?: unknown,
): void {
  const message = `Long screenshot not saved: reason=${reason} file=${fileBaseName}`;
  try {
    void ipcService.invokeDomain(IPC_DOMAINS.DIAGNOSTICS, 'logClientError', {
      context: 'PreviewExport',
      message,
      detail: extractErrorDetail(error),
    }).catch(() => {});
  } catch {
    return;
  }
}

export function usePreviewLongScreenshotExport({
  iframeRef,
  previewFilePath,
  isHtml,
  mode,
}: UsePreviewLongScreenshotExportOptions) {
  const { t } = useI18n();
  const pv = t.previewWorkspace.preview;
  const exportingRef = useRef(false);
  const [isExporting, setIsExporting] = useState(false);

  const handleExportLongScreenshot = useCallback(async () => {
    if (exportingRef.current) return;

    const fileBaseName = extractBaseName(previewFilePath);
    const stem = fileBaseName.replace(/\.[^.]+$/, '') || 'preview';
    const targetFileName = `${stem}-long-screenshot.png`;
    const iframe = iframeRef.current;

    if (!iframe) {
      if (isHtml && mode !== 'preview') {
        toast.warning(pv.longScreenshotNeedsPreview);
        logPreviewExportNotSaved('source-mode', fileBaseName, `mode=${mode}`);
      } else {
        toast.warning(pv.longScreenshotNotReady);
        logPreviewExportNotSaved('not-ready', fileBaseName, 'preview iframe not mounted');
      }
      return;
    }

    exportingRef.current = true;
    setIsExporting(true);
    let progressToastId: string | null = toast.info(pv.exportingLongScreenshot, 0);
    const dismissProgress = () => {
      if (progressToastId !== null) {
        useToastStore.getState().removeToast(progressToastId);
        progressToastId = null;
      }
    };

    let stage: 'capture' | 'save' = 'capture';
    try {
      const base64 = await capturePreviewFrame(iframe);
      stage = 'save';
      const saved = await ipcService.invokeDomain<{ filePath?: string }>(
        IPC_DOMAINS.WORKSPACE,
        'saveBinaryToDownloads',
        { fileName: targetFileName, base64 },
      );
      if (!saved?.filePath) {
        throw new Error('saveBinaryToDownloads returned no filePath');
      }
      const savedFilePath = saved.filePath;
      const savedName = extractBaseName(savedFilePath) || targetFileName;
      dismissProgress();
      toast.success(
        pv.longScreenshotSaved.replace('{name}', savedName),
        8000,
        {
          label: pv.revealInFinder,
          onClick: () => {
            void ipcService.invokeDomain(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', {
              filePath: savedFilePath,
            }).catch(() => {});
          },
        },
      );
    } catch (err) {
      const reason: PreviewExportFailureReason =
        stage === 'save'
          ? 'save-failed'
          : err instanceof PreviewCaptureError
            ? err.reason
            : 'capture-failed';
      logger.error('Long screenshot export failed', err);
      dismissProgress();
      const failureCopy: Record<Exclude<PreviewExportFailureReason, 'source-mode' | 'not-ready'>, string> = {
        'cross-origin': pv.crossOriginScreenshot,
        'capture-failed': pv.screenshotFailed,
        timeout: pv.longScreenshotTimeout,
        'preview-changed': pv.longScreenshotPreviewChanged,
        'save-failed': pv.longScreenshotSaveFailed,
      };
      toast.error(failureCopy[reason]);
      logPreviewExportNotSaved(reason, fileBaseName, err);
    } finally {
      dismissProgress();
      exportingRef.current = false;
      setIsExporting(false);
    }
  }, [iframeRef, isHtml, mode, previewFilePath, pv]);

  return { isExporting, handleExportLongScreenshot };
}
