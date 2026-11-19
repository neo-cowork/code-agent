import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { updateLightMemoryIndexPointers } from '../lightMemory/lightMemoryIpc';
import { createLogger } from '../services/infra/logger';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { resolveToolPath } from '../tools/writeTargets';
import {
  directiveMemoryGrantSkipsOutsideProjectAsk,
  type DirectiveMemoryClassifierAuthorization,
} from './directiveMemoryOutsideWriteExemption';

const logger = createLogger('GrantedMemoryIndex');

const NON_INDEXABLE = new Set(['INDEX.md', 'recent-conversations.md']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectChild(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep);
}

/** Description from frontmatter, or the filename when that field is absent. */
function descriptionForIndex(content: string, filename: string): { description: string; warning?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { description: filename, warning: 'missing frontmatter' };
  let description = '';
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0 && line.slice(0, colon).trim() === 'description') {
      description = line.slice(colon + 1).trim();
    }
  }
  if (!description) return { description: filename, warning: 'missing description' };
  return { description };
}

/**
 * After a granted Write of a memory markdown file (not INDEX.md) succeeds,
 * add its INDEX pointer. Invalid frontmatter and update failures are warned
 * and do not fail the write. Model-written INDEX.md is left untouched.
 */
export async function recordGrantedMemoryWritePointer(input: {
  toolName: string;
  params: Record<string, unknown>;
  workingDirectory: string;
  authorization: DirectiveMemoryClassifierAuthorization | undefined;
}): Promise<void> {
  if (input.toolName !== 'Write') return;
  const rawPath = input.params.file_path;
  if (typeof rawPath !== 'string' || !rawPath || !input.authorization) return;

  let canonical: string;
  let memoryDir: string;
  try {
    canonical = resolveToolPath(rawPath, input.workingDirectory);
    memoryDir = resolveCanonicalRunPath(getMemoryDir());
  } catch (error) {
    logger.warn(`memory index pointer skipped: path resolution failed: ${errorMessage(error)}`);
    return;
  }
  if (!directiveMemoryGrantSkipsOutsideProjectAsk(input.authorization, canonical, input.workingDirectory)) {
    return;
  }
  if (!isDirectChild(canonical, memoryDir)) {
    logger.warn(`memory index pointer skipped: ${path.basename(canonical)} is not a direct file in the memory directory`);
    return;
  }
  const filename = path.basename(canonical);
  if (!filename.endsWith('.md') || NON_INDEXABLE.has(filename)) return;

  let content: string;
  try {
    content = await fs.readFile(canonical, 'utf8');
  } catch (error) {
    logger.warn(`memory index pointer skipped: could not read ${filename}: ${errorMessage(error)}`);
    return;
  }
  const parsed = descriptionForIndex(content, filename);
  if (parsed.warning) {
    logger.warn(`memory index pointer: ${filename}: ${parsed.warning}`);
  }
  try {
    const result = await updateLightMemoryIndexPointers({
      remove: [],
      add: [{ filename, description: parsed.description }],
    });
    logger.info(`memory index pointer updated: ${filename} added=${result.added.join(',')}`);
  } catch (error) {
    logger.warn(`memory index pointer update failed: ${filename}: ${errorMessage(error)}`);
  }
}
