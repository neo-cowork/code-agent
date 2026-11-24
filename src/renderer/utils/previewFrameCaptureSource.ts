import source from 'html2canvas/dist/html2canvas.js?raw';

// html2canvas's public entry point clones into a child iframe, which inherits the
// sandbox and has a different opaque origin. Use its DOM parser and canvas renderer
// directly on the live document. This source runs before the artifact's CSP.
export function getPreviewFrameCaptureSource(): string {
  const exportMarker = '    return html2canvas;';
  if (source.split(exportMarker).length !== 2) throw new Error('Unsupported html2canvas bundle');

  return source.replace(exportMarker, `
    window.__neoPreviewCapture = async function (target, maxPixels, imageTimeout) {
        await target.ownerDocument.fonts.ready;
        var width = target.scrollWidth;
        var height = target.scrollHeight;
        var scale = Math.min(window.devicePixelRatio,
            Math.sqrt(maxPixels / (width * height)), 32767 / Math.max(width, height));
        var context = new Context(
            { useCORS: true, allowTaint: false, logging: false, imageTimeout: imageTimeout },
            new Bounds(window.scrollX, window.scrollY, window.innerWidth, window.innerHeight)
        );
        var backgroundColor = parseBackgroundColor(context, target, null);

        // The parser temporarily disables transforms and animations on elements.
        // Restore any inline styles it touched before yielding to the artifact.
        var observer = new MutationObserver(function () {});
        observer.observe(target, {
            subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true
        });
        var root;
        try {
            root = parseTree(context, target);
        } finally {
            var changes = observer.takeRecords();
            observer.disconnect();
            for (var i = changes.length - 1; i >= 0; i--) {
                var change = changes[i];
                if (change.oldValue === null) change.target.removeAttribute('style');
                else change.target.setAttribute('style', change.oldValue);
            }
        }
        if (backgroundColor === root.styles.backgroundColor) {
            root.styles.backgroundColor = COLORS.TRANSPARENT;
        }
        return new CanvasRenderer(context, { backgroundColor: backgroundColor,
            width: width, height: height, scale: scale, x: 0, y: 0 }).render(root);
    };
    return html2canvas;`).replace(/<\/script/gi, '<\\/script');
}
