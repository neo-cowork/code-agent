import * as path from 'node:path';
import type { DirectiveMemoryWriteGrant } from '../../shared/contract';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import type { DirectiveMemoryWriteAssessment } from './directiveMemoryPathAuthority';

/**
 * Per-call directive grant, passed into file-write classification so a confirmed
 * memory-dir write does not also raise the outside-project card.
 * The grant is not a standing allow: the fingerprint is this call only.
 */
export interface DirectiveMemoryClassifierAuthorization {
  grant: DirectiveMemoryWriteGrant;
  assessment: Pick<DirectiveMemoryWriteAssessment, 'requiresConfirmation' | 'fingerprint' | 'targets'>;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPath(target: string, workingDirectory: string): string | undefined {
  try {
    const absolute = path.isAbsolute(target) ? target : path.resolve(workingDirectory, target);
    return resolveCanonicalRunPath(absolute);
  } catch {
    return undefined;
  }
}

/**
 * Skip outsideProjectWriteAsk only when this call's grant matches and every
 * resolved target stays inside the canonical memory directory. `..` and a
 * symlink that leaves the directory fail the check.
 */
export function directiveMemoryGrantSkipsOutsideProjectAsk(
  authorization: DirectiveMemoryClassifierAuthorization | undefined,
  canonicalClassifierTarget: string,
  workingDirectory: string,
): boolean {
  if (!authorization?.assessment.requiresConfirmation) return false;
  const { grant, assessment } = authorization;
  if (grant.authority !== 'directive-memory-write' || grant.fingerprint !== assessment.fingerprint) {
    return false;
  }
  if (assessment.targets.length === 0) return false;
  let memoryDir: string;
  try {
    memoryDir = resolveCanonicalRunPath(getMemoryDir());
  } catch {
    return false;
  }
  const insideMemory = (target: string): boolean => {
    const canonical = canonicalPath(target, workingDirectory);
    return canonical !== undefined && isInside(canonical, memoryDir);
  };
  return assessment.targets.every(insideMemory) && insideMemory(canonicalClassifierTarget);
}
