// Renders ONE slide of a deck under 3 themes as PNGs so the user can pick a style.
// Usage: node theme-samples.mjs <slide-deck-dir> [--out <dir>]
// Stdout: one JSON line. {available:false, reason} when LibreOffice is missing (exit 0),
//         {available:true, slide, samples:[{theme,png}]} otherwise.
// Plain Node, no dependencies; the merge step is the sibling merge-to-pptx-hybrid.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const THEMES = ['corporate', 'minimal', 'bold-editorial'];
const SOFFICE_FIXED_PATHS = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/libreoffice',
  '/usr/local/bin/libreoffice',
];
const STEP_TIMEOUT_MS = 120_000;
// macOS: under the app's write fence LibreOffice finds /tmp unwritable and puts its
// single-instance socket at the filesystem root. Pin the directory the sandbox allows.
const OFFICE_SOCKET_DIR = process.platform === 'darwin' ? '/private/tmp' : '';

function log(message) {
  console.error(`[theme-samples] ${message}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let dir = '';
  let out = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') {
      out = args[i + 1] || '';
      i += 1;
    } else if (!args[i].startsWith('-')) {
      dir = args[i];
    }
  }
  if (!dir) {
    console.error('Usage: node theme-samples.mjs <slide-deck-dir> [--out <dir>]');
    process.exit(1);
  }
  return { dir: path.resolve(dir), out: out ? path.resolve(out) : path.join(path.resolve(dir), 'theme-samples') };
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(binary) {
  for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** LIBREOFFICE_PATH is authoritative when set; otherwise fixed install paths, then PATH. */
function findSoffice() {
  const explicit = process.env.LIBREOFFICE_PATH?.trim();
  if (explicit) {
    if (isExecutable(explicit)) return explicit;
    log(`lookup failed: LIBREOFFICE_PATH=${explicit} is not an executable file`);
    return null;
  }
  for (const candidate of SOFFICE_FIXED_PATHS) {
    if (isExecutable(candidate)) return candidate;
  }
  log(`lookup failed: none of ${SOFFICE_FIXED_PATHS.join(', ')}`);
  for (const binary of ['soffice', 'libreoffice']) {
    const found = findOnPath(binary);
    if (found) return found;
    log(`lookup failed: ${binary} not on PATH`);
  }
  return null;
}

function pickSlide(dir) {
  const slidesPath = path.join(dir, 'slides.json');
  const slides = JSON.parse(fs.readFileSync(slidesPath, 'utf8'));
  if (!Array.isArray(slides) || slides.length === 0) throw new Error(`${slidesPath} has no slides`);
  // First content slide; the cover only when it is the sole slide.
  return slides.find((slide) => slide.layout !== 'cover') ?? slides[0];
}

// The merge script treats index 1 as the cover whatever `layout` says, so a content slide
// must keep an index >= 2 or it would be laid out as a cover.
function sampleIndex(slide) {
  if (slide.layout === 'cover') return 1;
  return Math.max(Number(slide.index) || 2, 2);
}

function run(cmd, args, label, reason = 'sample render failed') {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: STEP_TIMEOUT_MS });
  if (result.status !== 0) {
    const stderr = result.stderr || '';
    const stdout = result.stdout || '';
    const error = new Error(`${label} failed: ${JSON.stringify({
      status: result.status, signal: result.signal, error: result.error?.message ?? null,
      stderr: stderr.slice(0, 500), stdout: stdout.slice(0, 500),
    })}`);
    error.reason = reason;
    throw error;
  }
}

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function probeWrite(dir) {
  const file = path.join(dir, `.theme-samples-probe-${process.pid}`);
  try {
    fs.writeFileSync(file, '');
    fs.rmSync(file, { force: true });
    return null;
  } catch (error) {
    return error.code || String(error);
  }
}

// Binds a socket named like LibreOffice's own, in the directory LibreOffice would use: the
// one passed to it, else the first writable of /tmp and /var/tmp, else the filesystem root.
function probeOfficeSocket() {
  const dir = OFFICE_SOCKET_DIR || ['/tmp', '/var/tmp'].find(writable) || '/';
  const target = path.join(dir, `OSL_PIPE_${process.getuid()}_SingleOfficeIPC_probe${process.pid}`);
  const bind = "const s=require('net').createServer();s.on('error',e=>console.log(e.code));s.listen(process.argv[1],()=>{console.log('OK');s.close()})";
  const result = spawnSync(process.execPath, ['-e', bind, target], { encoding: 'utf8', timeout: STEP_TIMEOUT_MS });
  const code = (result.stdout || '').trim() || `no result (${result.error?.message ?? `status ${result.status}`})`;
  return { target, code: code === 'OK' ? null : code };
}

// A sandbox denial goes to the kernel log, never to the failed child's stderr. So after a
// failure, repeat the same kinds of access here: EPERM means the sandbox refused it.
function sandboxDenial(error, work, out) {
  if (error.code === 'EPERM') return 'sandbox denied write';
  const probes = [work, out].filter(Boolean).map((dir) => ({ name: 'write', target: dir, code: probeWrite(dir) }));
  if (error.reason === 'soffice render failed' && process.platform !== 'win32') {
    probes.push({ name: 'socket', ...probeOfficeSocket() });
  }
  let reason = null;
  for (const { name, target, code } of probes) {
    if (!code) continue;
    log(`probe failed: ${name} ${target} -> ${code}`);
    if (code === 'EPERM') reason ??= `sandbox denied ${name}`;
  }
  return reason;
}

function pdfToPng(pdf, png) {
  const pdftoppm = findOnPath('pdftoppm') || ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm'].find(isExecutable);
  if (pdftoppm) {
    const prefix = png.replace(/\.png$/, '');
    run(pdftoppm, ['-png', '-r', '80', '-singlefile', pdf, prefix], 'pdftoppm', 'pdf-to-png failed');
    return;
  }
  log('lookup failed: pdftoppm not found, falling back to sips');
  run('sips', ['-s', 'format', 'png', pdf, '--out', png], 'sips', 'pdf-to-png failed');
}

function renderSample({ soffice, mergeScript, slide, theme, outDir, work }) {
  const deck = path.join(work, theme);
  fs.mkdirSync(deck, { recursive: true });
  fs.writeFileSync(path.join(deck, 'slides.json'), JSON.stringify([{ ...slide, index: sampleIndex(slide) }], null, 2));
  const pptx = path.join(deck, `${theme}.pptx`);
  run(process.execPath, [mergeScript, deck, '--text-only', '--theme', theme, '--output', pptx], `merge (${theme})`);
  // Isolated profile so a running LibreOffice instance cannot swallow the headless call.
  const profile = path.join(work, `profile-${theme}`);
  run(
    soffice,
    [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      ...(OFFICE_SOCKET_DIR ? [`-env:OSL_SOCKET_PATH=${OFFICE_SOCKET_DIR}`] : []),
      '--headless', '--convert-to', 'pdf', '--outdir', deck, pptx,
    ],
    `soffice (${theme})`,
    'soffice render failed',
  );
  const png = path.join(outDir, `${theme}.png`);
  pdfToPng(path.join(deck, `${theme}.pdf`), png);
  if (!fs.existsSync(png) || fs.statSync(png).size === 0) {
    const error = new Error(`empty PNG for ${theme}`);
    error.reason = 'pdf-to-png failed';
    throw error;
  }
  return { theme, png };
}

function main() {
  const { dir, out } = parseArgs();
  const soffice = findSoffice();
  if (!soffice) {
    console.log(JSON.stringify({ available: false, reason: 'LibreOffice (soffice) not found' }));
    return;
  }
  const slide = pickSlide(dir);
  const mergeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'merge-to-pptx-hybrid.mjs');
  let work = '';
  try {
    fs.mkdirSync(out, { recursive: true });
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-theme-samples-'));
    const samples = THEMES.map((theme) => renderSample({ soffice, mergeScript, slide, theme, outDir: out, work }));
    console.log(JSON.stringify({ available: true, slide: slide.index, samples }));
  } catch (error) {
    // Probe while the work directory still exists.
    error.reason = sandboxDenial(error, work, out) || error.reason;
    throw error;
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  // Rendering broke after LibreOffice was found: report unavailable so the skill falls back to text options.
  log(`render failed: ${error instanceof Error ? error.message : String(error)}`);
  console.log(JSON.stringify({ available: false, reason: error.reason || 'sample render failed' }));
}
