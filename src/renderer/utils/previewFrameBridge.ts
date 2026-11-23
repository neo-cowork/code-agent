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

export function createPreviewFrameDocument(html: string) {
  const revision = ++nextRevision;
  const script = `(${runPreviewFrameDriver.toString()})(${createHtmlLocalitySelection.toString()},` +
    `${revision},${MAX_CAPTURE_PIXELS},${ARTIFACT_PREVIEW_CAPTURE_TIMEOUTS.IMAGE},${MAX_PNG_LENGTH});`;
  const srcDoc = html.replace(DOCUMENT_START, (start) => `${start}<script>${script}</script>`);
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

export async function capturePreviewFrame(iframe: HTMLIFrameElement): Promise<Blob> {
  const frame = iframe.contentWindow;
  const revision = Number(iframe.dataset.previewRevision);
  const source = await loadPreviewFrameCaptureSource();
  if (!frame || !Number.isSafeInteger(revision) || iframe.contentWindow !== frame || !iframe.isConnected) {
    throw new Error('Preview changed');
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
      reject(new Error('Preview changed'));
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      const data = readFrameMessage(event, iframe.contentWindow);
      if (!iframe.isConnected || data?.type !== 'neo-preview-screenshot-done'
        || data.revision !== revision || data.id !== id) return;
      cleanup();
      if (data.failure === 'cors') {
        reject(new DOMException('Screenshot contains cross-origin resources', 'SecurityError'));
        return;
      }

      const { png } = data;
      if (typeof png !== 'string' || png.length > MAX_PNG_LENGTH || !png.startsWith(PNG_PREFIX)) {
        reject(new Error('Invalid screenshot response'));
        return;
      }
      try {
        const binary = window.atob(png.slice(PNG_PREFIX.length));
        if (!binary.startsWith(PNG_SIGNATURE)) throw new Error('Invalid PNG signature');
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (error) {
        reject(error);
      }
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Screenshot response timed out'));
    }, ARTIFACT_PREVIEW_CAPTURE_TIMEOUTS.RESPONSE);
    window.addEventListener('message', handleMessage);
    iframe.addEventListener('load', handleLoad);
    frame.postMessage({ type: 'neo-preview-screenshot', id, source }, '*');
  });
}
