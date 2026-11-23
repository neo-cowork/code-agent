import type { createHtmlLocalitySelection, HtmlLocalitySelectionController } from './htmlLocality';

type Capture = (target: HTMLElement, maxPixels: number, imageTimeout: number) => Promise<HTMLCanvasElement>;

// This function runs as an inline script in the sandbox. Pass dependencies as arguments.
export function runPreviewFrameDriver(
  makeSelection: typeof createHtmlLocalitySelection,
  revision: number,
  maxPixels: number,
  imageTimeout: number,
  maxPngLength: number,
) {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      void window[name];
    } catch {
      const values = new Map<string, string>();
      const storage: Storage = {
        get length() { return values.size; },
        key: (index) => Array.from(values.keys())[index] ?? null,
        getItem: (key) => values.get(String(key)) ?? null,
        setItem: (key, value) => { values.set(String(key), String(value)); },
        removeItem: (key) => { values.delete(String(key)); },
        clear: () => { values.clear(); },
      };
      Object.defineProperty(window, name, { configurable: true, value: storage });
    }
  }

  const { attachHtmlLocalitySelection } = makeSelection();
  const reply = (message: object) => window.parent.postMessage({ ...message, revision }, '*');
  let selection: HtmlLocalitySelectionController | undefined;
  let capture: Capture | undefined;

  async function screenshot(id: number, source: string) {
    const type = 'neo-preview-screenshot-done';
    try {
      if (!capture) {
        // A classic script loaded only into the opaque frame, from the bundled library.
        const script = document.createElement('script');
        const target = window as Window & { __neoPreviewCapture?: Capture };
        script.textContent = source;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
        capture = target.__neoPreviewCapture;
        delete target.__neoPreviewCapture;
      }
      if (!capture) throw new Error('Screenshot renderer unavailable');
      const canvas = await capture(document.documentElement, maxPixels, imageTimeout);
      const png = canvas.toDataURL('image/png');
      if (png.length > maxPngLength || png === 'data:,') throw new Error('Invalid screenshot size');
      reply({ type, id, png });
    } catch (error) {
      reply({ type, id, failure: error instanceof DOMException && error.name === 'SecurityError' ? 'cors' : 'capture' });
    }
  }

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent) return;
    if (!event.data || typeof event.data !== 'object') return;
    const message = event.data as Record<string, unknown>;
    switch (message.type) {
      case 'neo-preview-select':
        if (message.on === false) {
          selection?.destroy();
          selection = undefined;
        } else if (message.on === true && !selection) {
          selection = attachHtmlLocalitySelection(document, (next) => {
            reply(next ? { type: 'neo-preview-selection', ...next } : { type: 'neo-preview-selection-cleared' });
          });
        }
        break;
      case 'neo-preview-clear':
        selection?.clear();
        break;
      case 'neo-preview-screenshot':
        if (typeof message.id === 'number' && typeof message.source === 'string') {
          void screenshot(message.id, message.source);
        }
        break;
    }
  });
}
