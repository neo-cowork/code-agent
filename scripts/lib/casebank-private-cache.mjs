import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const defaultEntryPoints = [
  'src/host/testing/answerSide.ts',
  'src/host/testing/testCaseLoader.ts',
  'src/host/testing/testCaseClassification.ts',
  'src/host/testing/mockEvalPolicy.ts',
  'src/host/testing/ci/sampleSplits.ts',
  'packages/internal/evaluation-center/scripts/casebank-l3-oracle.ts',
  'packages/internal/evaluation-center/scripts/casebank-l0-git-oracle.ts',
];
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function hashInputs(root, privateRoot, entryPoints) {
  const inputs = [];
  const file = (name, target) => inputs.push([name, digest(fs.readFileSync(target))]);
  const tree = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) tree(target, name);
      else if (entry.isFile()) file(name, target);
      else throw new Error(`Nonregular cache input: ${name}`);
    }
  };
  try {
    tree(path.join(root, '.claude/test-cases'), 'public');
    inputs.push(['.claude/eval-splits.json:exists', digest(String(fs.existsSync(path.join(root, '.claude/eval-splits.json'))))]);
    tree(privateRoot, 'private');
    const { metafile } = await build({
      absWorkingDir: root, entryPoints, bundle: true, write: false, metafile: true,
      platform: 'node', packages: 'external', logLevel: 'silent', outdir: 'unused-private-cache-build',
    });
    for (const source of Object.keys(metafile.inputs)) file(`source/${source}`, path.resolve(root, source));
    for (const name of ['scripts/ci/check-casebank-answers.mjs', 'scripts/lib/casebank-private-cache.mjs', 'package-lock.json', 'tsconfig.json']) file(name, path.join(root, name));
    inputs.push(['node', digest(process.version)]);
    inputs.push(['git', digest(execFileSync('git', ['--version'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim())]);
    return { inputHash: digest(JSON.stringify(inputs.sort(([a], [b]) => a.localeCompare(b)))), reusable: true };
  } catch {
    // Incomplete fingerprints can never authorize reuse, even if the real check passes.
    return { inputHash: digest(JSON.stringify(['unresolved', inputs.sort(([a], [b]) => a.localeCompare(b))])), reusable: false };
  }
}

function readCache(cacheFile) {
  try {
    const entries = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)
        || Object.entries(entries).some(([hash, passedAt]) => !/^[a-f0-9]{64}$/.test(hash) || typeof passedAt !== 'number' || !Number.isFinite(passedAt))) return {};
    return entries;
  } catch { return {}; }
}

/** Only successful checks with complete fingerprints may be reused. */
export async function runPrivateCheckCached({ root, privateRoot, run, cacheDir = process.env.GATES_FAST_CACHE_DIR ?? path.join(os.homedir(), '.cache/agent-neo/gates-fast'), entryPoints = defaultEntryPoints }) {
  const cacheFile = path.join(cacheDir, 'private-check.json');
  const { inputHash, reusable } = await hashInputs(root, privateRoot, entryPoints);
  if (reusable && Object.hasOwn(readCache(cacheFile), inputHash)) return { mode: 'reused', inputHash };
  const result = { mode: 'ran', inputHash };
  try {
    await run();
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { privateCheck: result });
  }
  if (reusable) {
    // Shared private inputs may change while the checker runs. Do not cache that run.
    const after = await hashInputs(root, privateRoot, entryPoints);
    if (!after.reusable || after.inputHash !== inputHash) return result;
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const entries = { ...readCache(cacheFile), [inputHash]: Date.now() };
      const newest = Object.entries(entries).sort(([, a], [, b]) => b - a).slice(0, 8);
      fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(newest))}\n`, { mode: 0o600 });
      fs.renameSync(temporary, cacheFile);
    } catch (error) {
      console.error(`private check cache: write failed (${error.code ?? 'unknown'}); check passed`);
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Cache cleanup cannot fail the gate. */ }
    }
  }
  return result;
}
