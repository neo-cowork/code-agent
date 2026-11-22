// Detect office documents (.docx/.xlsx/.pptx) created or modified in the working
// directory while a foreground Bash call ran, so scripted deliverables get a file card.
import * as fsp from 'fs/promises';
import * as path from 'path';

const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_DEPTH = 3;
const MAX_FILES = 20;

export type OfficeSnapshot = Map<string, string>;

async function walk(dir: string, depth: number, out: OfficeSnapshot): Promise<void> {
  if (out.size >= MAX_FILES) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.size >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) await walk(full, depth + 1, out);
    } else if (
      entry.isFile()
      && !entry.name.startsWith('~$')
      && OFFICE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      const stat = await fsp.stat(full).catch(() => null);
      if (stat) out.set(full, `${stat.mtimeMs}:${stat.size}`);
    }
  }
}

export async function snapshotOfficeFiles(workingDirectory: string): Promise<OfficeSnapshot> {
  const snapshot: OfficeSnapshot = new Map();
  await walk(workingDirectory, 0, snapshot);
  return snapshot;
}

export async function findChangedOfficeFiles(
  workingDirectory: string,
  before: OfficeSnapshot,
): Promise<string[]> {
  const after = await snapshotOfficeFiles(workingDirectory);
  return [...after].filter(([file, sig]) => before.get(file) !== sig).map(([file]) => file);
}
