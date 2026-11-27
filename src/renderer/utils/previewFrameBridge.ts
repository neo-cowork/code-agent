import { ARTIFACT_PREVIEW_CAPTURE_TIMEOUTS } from '@shared/constants/timeouts';
import { createHtmlLocalitySelection, type HtmlElementSelection } from './htmlLocality';
import { loadPreviewFrameCaptureSource } from './previewFrameCaptureSource';
import { runPreviewFrameDriver } from './previewFrameDriver';

export const ARTIFACT_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-pointer-lock';

const MAX_SELECTOR_LENGTH = 512;
const MAX_TAG_LENGTH = 128;
const MAX_TEXT_LENGTH = 120;
const MAX_CAPTURE_PIXELS = 16 * 1024 * 1024;
const MAX_PNG_LENGTH = 96 * 1024 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n';
// Preserve the document mode and opening tag attributes while running before artifact scripts.
const OPENING_TAG_ATTRIBUTES = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const DOCUMENT_START = new RegExp(
  String.raw`^(?:\s|<!--[\s\S]*?-->|<!doctype\b${OPENING_TAG_ATTRIBUTES}>)*(?:<html(?=[\s/>])${OPENING_TAG_ATTRIBUTES}>(?:\s|<!--[\s\S]*?-->)*)?(?:<head(?=[\s/>])${OPENING_TAG_ATTRIBUTES}>)?`,
  'i',
);
let nextRevision = 0;
let nextCaptureId = 0;

export function createPreviewFrameDocument(html: string, captureSource?: string) {
  const revision = ++nextRevision;
  const driver = `(${runPreviewFrameDriver.toString()})(${createHtmlLocalitySelection.toString()},` +
    `${revision},${MAX_CAPTURE_PIXELS},${ARTIFACT_PREVIEW_CAPTURE_TIMEOUTS.IMAGE},${MAX_PNG_LENGTH});`;
  const bootstrap = captureSource ? `<script>${captureSource}</script>` : '';
  const srcDoc = html.replace(DOCUMENT_START, (start) => `${start}${bootstrap}<script>${driver}</script>`);
  return { revision, srcDoc };
}

export function sendPreviewFrameSelectionMode(iframe: HTMLIFrameElement | null, on: boolean) {
  iframe?.contentWindow?.postMessage({ type: 'neo-preview-select', on }, '*');
}

export function clearPreviewFrameSelection(iframe: HTMLIFrameElement | null) {
  iframe?.contentWindow?.postMessage({ type: 'neo-preview-clear' }, '*');
}

function readFrameMessage(event: MessageEvent<unknown>, frame: Window | null | undefined) {
  if (!frame || event.source !== frame || !event.data || typeof event.data !== 'object') return null;
  return event.data as Record<string, unknown>;
}

export function readPreviewFrameSelection(
  event: MessageEvent<unknown>,
  iframe: HTMLIFrameElement | null,
  revision: number,
): HtmlElementSelection | null | undefined {
  const data = readFrameMessage(event, iframe?.contentWindow);
  if (data?.revision !== revision) return undefined;
  if (data.type === 'neo-preview-selection-cleared') return null;
  if (data.type !== 'neo-preview-selection') return undefined;

  const { selector, tag, text } = data;
  if (typeof selector !== 'string' || !selector || selector.length > MAX_SELECTOR_LENGTH
    || typeof tag !== 'string' || !tag || tag.length > MAX_TAG_LENGTH
    || (text !== undefined && (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH))) {
    return undefined;
  }

  return { selector, tag, text };
}

export type PreviewCaptureErrorReason =
  | 'cross-origin'
  | 'capture-failed'
  | 'timeout'
  | 'preview-changed';

export class PreviewCaptureError extends Error {
  readonly reason: PreviewCaptureErrorReason;

  constructor(reason: PreviewCaptureErrorReason, message: string) {
    super(message);
    this.name = 'PreviewCaptureError';
    this.reason = reason;
  }
}

export async function capturePreviewFrame(iframe: HTMLIFrameElement): Promise<string> {
  const frame = iframe.contentWindow;
  const revision = Number(iframe.dataset.previewRevision);
  let source: string;
  try {
    source = await loadPreviewFrameCaptureSource();
  } catch (error) {
    throw new PreviewCaptureError(
      'capture-failed',
      error instanceof Error ? error.message : 'Failed to load screenshot renderer',
    );
  }
  if (!frame || !Number.isSafeInteger(revision) || iframe.contentWindow !== frame || !iframe.isConnected) {
    throw new PreviewCaptureError('preview-changed', 'Preview changed');
  }

  const id = ++nextCaptureId;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', handleMessage);
      iframe.removeEventListener('load', handleLoad);
    };
    const handleLoad = () => {
      cleanup();
      reject(new PreviewCaptureError('preview-changed', 'Preview changed'));
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      const data = readFrameMessage(event, iframe.contentWindow);
      if (!iframe.isConnected || data?.type !== 'neo-preview-screenshot-done'
        || data.revision !== revision || data.id !== id) return;
      cleanup();
      if (data.failure === 'cors') {
        reject(new PreviewCaptureError('cross-origin', 'Screenshot contains cross-origin resources'));
        return;
      }
      if (data.failure === 'capture') {
        reject(new PreviewCaptureError('capture-failed', 'Screenshot capture failed'));
        return;
      }

      const { png } = data;
      if (typeof png !== 'string' || png.length > MAX_PNG_LENGTH || !png.startsWith(PNG_PREFIX)) {
        reject(new PreviewCaptureError('capture-failed', 'Invalid screenshot response'));
        return;
      }
      const base64 = png.slice(PNG_PREFIX.length);
      try {
        const binary = window.atob(base64);
        if (!binary.startsWith(PNG_SIGNATURE)) {
          reject(new PreviewCaptureError('capture-failed', 'Invalid PNG signature'));
          return;
        }
        resolve(base64);
      } catch (error) {
        reject(new PreviewCaptureError(
          'capture-failed',
          error instanceof Error ? error.message : 'Invalid PNG base64 payload',
        ));
      }
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new PreviewCaptureError('timeout', 'Screenshot response timed out'));
    }, ARTIFACT_PREVIEW_CAPTURE_TIMEOUTS.RESPONSE);
    window.addEventListener('message', handleMessage);
    iframe.addEventListener('load', handleLoad);
    try {
      frame.postMessage({ type: 'neo-preview-screenshot', id, source }, '*');
    } catch (error) {
      cleanup();
      reject(new PreviewCaptureError(
        'capture-failed',
        error instanceof Error ? error.message : 'Failed to request screenshot',
      ));
    }
  });
}
