import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build as viteBuild } from 'vite';
import viteConfig from '../../../vite.config';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_MAP_COMMENT = /[#@]\s*sourceMappingURL=/;
// previewFrameCaptureSource.ts relies on this marker to splice in
// window.__neoPreviewCapture; the stripped bundle must keep it exactly once.
const EXPORT_MARKER = '    return html2canvas;';

describe('html2canvas ?raw bundle', () => {
  it('emits no sourceMappingURL comment and keeps the html2canvas export marker', async () => {
    const tmp = fs.mkdtempSync(path.join(repoRoot, '.tmp-h2c-raw-'));
    try {
      const entry = path.join(tmp, 'entry.js');
      fs.writeFileSync(
        entry,
        `const mod = await import('html2canvas/dist/html2canvas.js?raw');\n` +
          `globalThis.__h2cRawSource = mod.default;\n`,
      );
      const result = await viteBuild({
        configFile: false,
        root: tmp,
        logLevel: 'warn',
        plugins: viteConfig.plugins,
        build: {
          write: false,
          outDir: path.join(tmp, 'dist'),
          rollupOptions: { input: entry },
        },
      });
      const outputs = Array.isArray(result) ? result : 'output' in result ? [result] : [];
      const chunkText = outputs
        .flatMap((output) => output.output)
        .map((item) => (item.type === 'chunk' ? item.code : ''))
        .join('\n');
      expect(chunkText).not.toMatch(SOURCE_MAP_COMMENT);
      expect(chunkText.split(EXPORT_MARKER).length - 1).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
