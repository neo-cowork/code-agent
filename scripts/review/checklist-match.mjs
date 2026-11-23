#!/usr/bin/env node
// 把 diff 对到 docs/review/reliability-checklist.md 里命中的条目。
// 用法：
//   node scripts/review/checklist-match.mjs --base origin/main [--json]
//   git diff X | node scripts/review/checklist-match.mjs
//   node scripts/review/checklist-match.mjs --diff change.diff [--checklist other.md]
//   node scripts/review/checklist-match.mjs --list   # 列出解析后的全部条目（JSON）
// 退出码：0 = 成功（命中 0 条也是 0）；2 = 清单格式错误（点名条目 id）或参数/输入错误。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CHECKLIST = resolve(ROOT, 'docs/review/reliability-checklist.md');
const SELF_PATH = 'docs/review/reliability-checklist.md';
const REQUIRED = ['id', 'check', 'incident', 'expiry'];
const KNOWN = new Set([...REQUIRED, 'paths', 'diff', 'diff-del']);

class ChecklistError extends Error {}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out += '(?:.*/)?';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function parseRegexLiteral(raw, id, key) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(raw);
  if (!m) throw new ChecklistError(`${id}: ${key} must look like /regex/flags, got: ${raw}`);
  try {
    return new RegExp(m[1], m[2]);
  } catch (e) {
    throw new ChecklistError(`${id}: ${key} regex does not compile: ${e.message}`);
  }
}

function parseChecklist(text) {
  const entries = [];
  const blocks = [...text.matchAll(/^```rc[ \t]*\n([\s\S]*?)^```[ \t]*$/gm)];
  for (const [idx, block] of blocks.entries()) {
    const fields = {};
    for (const line of block[1].split('\n')) {
      if (!line.trim()) continue;
      const m = /^([a-z-]+):[ \t]*(.*)$/.exec(line);
      if (!m) throw new ChecklistError(`${fields.id ?? `block#${idx + 1}`}: unparseable line: ${line}`);
      if (!KNOWN.has(m[1])) throw new ChecklistError(`${fields.id ?? `block#${idx + 1}`}: unknown key ${m[1]}`);
      if (m[1] in fields) throw new ChecklistError(`${fields.id ?? `block#${idx + 1}`}: duplicate key ${m[1]}`);
      fields[m[1]] = m[2].trim();
    }
    const id = fields.id ?? `block#${idx + 1}`;
    if (!/^RC-\d{2}$/.test(fields.id ?? '')) throw new ChecklistError(`${id}: id must match RC-NN`);
    if (entries.some((e) => e.id === id)) throw new ChecklistError(`${id}: duplicate id`);
    for (const key of REQUIRED) {
      if (!fields[key]) throw new ChecklistError(`${id}: missing required field ${key}`);
    }
    if (!fields.paths && !fields.diff && !fields['diff-del']) {
      throw new ChecklistError(`${id}: needs at least one trigger (paths / diff / diff-del)`);
    }
    const includes = [];
    const excludes = [];
    for (const g of (fields.paths ?? '').split('|').map((s) => s.trim()).filter(Boolean)) {
      if (g.startsWith('!')) excludes.push(globToRegExp(g.slice(1)));
      else includes.push(globToRegExp(g));
    }
    if (fields.paths && includes.length === 0) throw new ChecklistError(`${id}: paths has only exclusions`);
    entries.push({
      id,
      check: fields.check,
      incident: fields.incident,
      expiry: fields.expiry,
      pathsRaw: fields.paths,
      diffRaw: fields.diff,
      diffDelRaw: fields['diff-del'],
      includes,
      excludes,
      diffRe: fields.diff ? parseRegexLiteral(fields.diff, id, 'diff') : null,
      diffDelRe: fields['diff-del'] ? parseRegexLiteral(fields['diff-del'], id, 'diff-del') : null,
    });
  }
  if (entries.length === 0) throw new ChecklistError('no ```rc entry blocks found');
  return entries;
}

function parseDiff(diff) {
  const files = [];
  let cur = null;
  for (const line of diff.split('\n')) {
    const h = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (h) {
      cur = { path: h[2], added: [], removed: [] };
      files.push(cur);
    } else if (cur && line.startsWith('+') && !line.startsWith('+++')) cur.added.push(line.slice(1));
    else if (cur && line.startsWith('-') && !line.startsWith('---')) cur.removed.push(line.slice(1));
  }
  return files.filter((f) => f.path !== SELF_PATH);
}

function matchEntries(entries, files) {
  const hits = [];
  for (const e of entries) {
    const why = [];
    for (const f of files) {
      if (e.includes.length && !e.includes.some((r) => r.test(f.path))) continue;
      if (e.excludes.some((r) => r.test(f.path))) continue;
      const reasons = [];
      let ok = true;
      if (e.diffRe) {
        const line = f.added.find((l) => e.diffRe.test(l));
        if (line === undefined) ok = false;
        else reasons.push(`+ ${line.trim().slice(0, 100)}`);
      }
      if (ok && e.diffDelRe) {
        const line = f.removed.find((l) => e.diffDelRe.test(l));
        if (line === undefined) ok = false;
        else reasons.push(`- ${line.trim().slice(0, 100)}`);
      }
      if (!ok) continue;
      why.push({ file: f.path, matched: reasons.length ? reasons : [`path ${e.pathsRaw}`] });
    }
    if (why.length) hits.push({ id: e.id, check: e.check, incident: e.incident, expiry: e.expiry, matches: why });
  }
  return hits;
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function main(argv) {
  const opt = { list: false, json: false, diff: null, base: null, checklist: DEFAULT_CHECKLIST };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opt.json = true;
    else if (a === '--list') opt.list = true;
    else if (a === '--diff') opt.diff = argv[++i];
    else if (a === '--base') opt.base = argv[++i];
    else if (a === '--checklist') opt.checklist = resolve(argv[++i]);
    else throw new ChecklistError(`unknown argument ${a}`);
  }
  const entries = parseChecklist(readFileSync(opt.checklist, 'utf8'));
  if (opt.list) {
    const rows = entries.map((e) => ({ id: e.id, check: e.check, incident: e.incident, expiry: e.expiry, paths: e.pathsRaw ?? null, diff: e.diffRaw ?? null, diffDel: e.diffDelRaw ?? null }));
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  let diff;
  if (opt.diff) diff = readFileSync(opt.diff, 'utf8');
  else if (opt.base) {
    diff = execFileSync('git', ['diff', `${opt.base}...HEAD`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } else diff = readStdin();
  const hits = matchEntries(entries, parseDiff(diff));
  if (opt.json) {
    console.log(JSON.stringify({ total: entries.length, hits }, null, 2));
    return;
  }
  console.log(`checklist hits: ${hits.length}/${entries.length}`);
  for (const h of hits) {
    console.log(`\n[${h.id}] ${h.check}`);
    console.log(`  incident: ${h.incident}`);
    for (const m of h.matches.slice(0, 5)) console.log(`  matched: ${m.file} :: ${m.matched.join(' ; ')}`);
    if (h.matches.length > 5) console.log(`  ... +${h.matches.length - 5} more files`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`checklist-match: ${e.message}`);
    process.exit(2);
  }
}
