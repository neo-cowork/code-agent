/* global process, console */
// Deterministic 5-page fixture for managed-browser multi-step runs. No external network.
// Usage: node tests/fixtures/browser-doomloop/server.mjs [port]  (prints FIXTURE_URL=...)
import http from 'node:http';
import { URL, URLSearchParams } from 'node:url';

const nav = '<nav><a href="/">Home</a> | <a href="/form">Form</a> | <a href="/reveal">Reveal</a> | <a href="/delayed">Delayed</a> | <a href="/submit">Submit</a> | <a href="/upload">Upload</a></nav>';
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${nav}<h1>${title}</h1>${body}</body></html>`;
const bootAt = Date.now();

const pages = {
  '/': () => page('Fixture Home', '<p>Welcome. Secret code A: ALPHA-17.</p>'),
  '/form': () => page('Fixture Form', '<form onsubmit="event.preventDefault();document.getElementById(\'out\').textContent=\'Hello, \'+document.getElementById(\'name\').value"><label>Name <input id="name" name="name"></label><button type="submit" id="go">Greet</button></form><p id="out"></p>'),
  '/reveal': () => page('Fixture Reveal', '<button id="reveal" onclick="document.getElementById(\'secret\').textContent=\'Secret code B: BRAVO-42\'">Show secret</button><p id="secret"></p>'),
  // Same URL, text changes ~4s after load: re-reading with identical args yields different results.
  '/delayed': () => page('Fixture Delayed', '<p id="status">Status: loading</p><script>setTimeout(()=>{document.getElementById("status").textContent="Status: ready. Secret code C: CHARLIE-99"},4000)</script>'),
  '/submit': () => page('Fixture Submit', '<form method="post" action="/submitted"><label>Receipt name <input id="receipt-name" name="receiptName"></label><button id="finish-form">Finish</button></form>'),
  '/upload': () => page('Fixture Upload', '<input type="file" id="f"><p>Upload any file to continue.</p>'),
  '/wiki-search': (reqUrl = '/wiki-search') => {
    const u = new URL(reqUrl, 'http://127.0.0.1');
    const q = u.searchParams.get('search') || u.searchParams.get('q') || '';
    return page(
      'Fixture Wiki Search',
      // Hidden at default 1280px width (<=1400px); the Search button reveals a distinct overlay input.
      '<style>@media (max-width: 1400px) { #searchInput { display: none; } }</style>' +
      '<header>' +
      '<input id="searchInput" name="search" type="search" placeholder="Search encyclopedia">' +
      '<button id="searchToggle" type="button" onclick="document.getElementById(\'overlayBox\').style.display=\'block\'">Search</button>' +
      '<div id="overlayBox" style="display:none"><form onsubmit="event.preventDefault();document.getElementById(\'searchResult\').textContent=\'Article: \'+document.getElementById(\'overlaySearchInput\').value"><input id="overlaySearchInput" name="q" type="search" placeholder="Type search term" aria-label="Search query"><button type="submit" id="overlayGo">Go</button></form></div>' +
      '</header>' +
      '<input id="readonlyInput" value="locked" readonly>' +
      '<button id="hiddenClick" style="display:none">Hidden fixture action</button>' +
      '<div style="position:relative;width:160px;height:40px"><button id="coveredClick">Covered action</button><div id="clickOverlay" style="position:absolute;inset:0;z-index:2">Overlay</div></div>' +
      '<input class="dup-input" name="dup1" style="display:none"><input class="dup-input" name="dup2" style="display:none">' +
      `<p id="searchResult">${q ? `Article: ${q} — desktop app framework` : ''}</p>`,
    );
  },
};

export function startFixture(port = 0) {
  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?')[0];
    if (req.method === 'POST' && pathname === '/submitted') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const receiptName = new URLSearchParams(body).get('receiptName') ?? '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Fixture Submitted', `<p id="receipt">POST receipt: ${receiptName}. Submission code: DELTA-63.</p>`));
      });
      return;
    }
    const handler = pages[pathname];
    if (!handler) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(handler(rawUrl));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, bootAt })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startFixture(Number(process.argv[2] ?? 0));
  console.log(`FIXTURE_URL=http://127.0.0.1:${port}`);
}
