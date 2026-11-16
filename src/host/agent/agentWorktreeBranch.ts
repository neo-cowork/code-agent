// 子 agent 隔离分支的唯一命名来源：创建时生成可读名，清理/丢弃时从 worktree 本身读回真实分支。
import { exec } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';

const execAsync = promisify(exec);
const GIT_TIMEOUT = 30_000;
const MAX_SLUG_WORDS = 4;
const MAX_SLUG_CHARS = 24;
const MAX_COLLISION_RETRIES = 5;
const INTERNAL_ID_RE = /^agent_(.+)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOP_WORDS = new Set(['a', 'an', 'the', 'in', 'on', 'of', 'to', 'for', 'and', 'into', 'with', 'then', 'me', 'my', 'it', 'is']);

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function toSlug(text: string | undefined): string {
  const words = (text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const picked: string[] = [];
  let len = 0;
  for (const word of words.filter((w) => !STOP_WORDS.has(w))) {
    if (picked.length >= MAX_SLUG_WORDS) break;
    const next = len + word.length + (picked.length ? 1 : 0);
    if (next > MAX_SLUG_CHARS) break;
    picked.push(word);
    len = next;
  }
  return picked.join('-');
}

/** 内部 id 形如 agent_<role>_<uuid> 时返回 role。 */
function internalRole(agentId: string): string | undefined {
  return INTERNAL_ID_RE.exec(agentId)?.[1];
}

async function branchExists(repoPath: string, name: string): Promise<boolean> {
  try {
    await execAsync(`git show-ref --verify --quiet ${quote(`refs/heads/${name}`)}`, { cwd: repoPath, timeout: GIT_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成 agent 分支名。内部 id 或给了 label 时用 agent/<slug>-<4hex>（slug 取任务文本里的英文词，
 * 没有则用角色名）；其余 id 形态保持 agent/<legacyKey>。
 */
export async function resolveAgentBranchName(
  agentId: string,
  legacyKey: string,
  repoPath: string,
  label?: string,
): Promise<string> {
  const role = internalRole(agentId);
  if (!role && !label?.trim()) return `agent/${legacyKey}`;
  const slug = toSlug(label) || toSlug(role) || 'agent';
  for (let i = 0; i < MAX_COLLISION_RETRIES; i++) {
    const name = `agent/${slug}-${randomBytes(2).toString('hex')}`;
    if (!(await branchExists(repoPath, name))) return name;
  }
  return `agent/${slug}-${randomBytes(4).toString('hex')}`;
}

/** 从 worktree 读真实分支；失败（目录没了/detached）回落旧版 agent/<key>。 */
export async function readWorktreeBranch(worktreePath: string, legacyKey: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git -C ${quote(worktreePath)} rev-parse --abbrev-ref HEAD`, { timeout: GIT_TIMEOUT });
    const name = stdout.trim();
    if (name.startsWith('agent/')) return name;
  } catch {
    // fall through to legacy name
  }
  return `agent/${legacyKey}`;
}
