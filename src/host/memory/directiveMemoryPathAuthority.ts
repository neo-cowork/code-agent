import * as os from 'node:os';
import * as path from 'node:path';
import type {
  DirectiveMemoryWriteGrant,
  ToolDefinition,
} from '../../shared/contract';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { hasPathBoundaryMention, resolveToolPath, resolveToolWriteTargets, shellScopedUncertainRedirects } from '../tools/writeTargets';
import { buildDirectiveMemoryConfirmView } from './directiveMemoryConfirmView';
import type { MemoryConfirmView } from '../../shared/contract/memory';
import type { DirectiveMemoryConfirmationResult } from './directiveMemoryConfirmation';

export interface DirectiveMemoryWriteAssessment {
  requiresConfirmation: boolean;
  fingerprint: string;
  targets: readonly string[];
  preview: string;
  /** 给用户看的确认卡内容（语言中立、只含值）；preview 仍是 headless 探针用的 JSON */
  buildConfirmView: () => MemoryConfirmView;
}

interface AssessInput {
  definition: ToolDefinition;
  params: Record<string, unknown>;
  workingDirectory: string;
  agentRole?: string;
  /**
   * 这次调用实际会拿到的子进程 env（门跑在 dispatch 前，bash 模块的 sanitized env
   * 尚未组装，调用方传其基准 process.env；测试传显式小字典）。用于展开 uncertain
   * 写目标里的 $VAR/${VAR} 核验真实去向（PR #1790 ai-review Important）。
   */
  env?: Record<string, string | undefined>;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 与 writeTargets 出口同口径：含这些字符的目标解析不出确定路径。 */
const EXPANSION_MARKERS = /[$`*?{}]/;

/** `$VAR` / `${VAR}`；`$(...)` 命令替换不匹配（`(` 不在变量名字符集里）。 */
const VAR_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** 用 lookup 展开词里的 $VAR/${VAR}；任一变量查不到 → undefined（展开不了，由调用方决定残余方向）。 */
function expandWithEnv(
  word: string,
  lookup: (name: string) => string | undefined,
): string | undefined {
  let missing = false;
  const expanded = word.replace(VAR_REFERENCE, (match, braced: string | undefined, bare: string | undefined) => {
    const value = lookup(braced ?? bare ?? '');
    if (value === undefined) {
      missing = true;
      return match;
    }
    return value;
  });
  return missing ? undefined : expanded;
}

/**
 * 判定一个解析不出的重定向目标词是否指向记忆目录，返回要并入确认面的目标
 * （undefined = 不门）。ai-review Important（PR #1790 二至四轮）：变量重定向必须先
 * 用它所属 execution 的赋值环境（命令内字面赋值按段序与作用域结算，见
 * writeTargets.shellScopedUncertainRedirects；再回落本次调用的 env）展开核验——
 * `OUT=~/.code-agent/memory; echo hi > "$OUT/f.md"` 不能靠「解析不出」逃过确认门。
 * 展开后落进记忆目录 → 门住；展开后在目录外 → 不门；变量查不到 / 仍含 `$(...)` 等
 * 展开不了的 → 只做字面证据判定，字面也没证据就不门（有意接受的残余：对展开不了的
 * 一律 fail-closed 正是 RQ-066 要治的病，全量 fail-closed 不许回退）。
 */
function uncertainWordTarget(
  word: string,
  memoryDir: string,
  memoryAlias: string,
  workingDirectory: string,
  lookup: (name: string) => string | undefined,
): string | undefined {
  const candidate = expandWithEnv(word, lookup) ?? word;
  if (!EXPANSION_MARKERS.test(candidate)) {
    // 完全展开（或本就没有变量）：按确定目标核验真实去向。
    const resolved = resolveToolPath(candidate, workingDirectory);
    return isInside(resolved, memoryDir) ? resolved : undefined;
  }
  // 仍解析不出（glob / 命令替换 / 缺变量）：只剩字面证据，且必须是路径边界命中
  // （Nit：普通文本顺带提到 .code-agent/memory 不算证据）。
  return hasPathBoundaryMention(candidate, memoryDir)
    || hasPathBoundaryMention(candidate, memoryAlias)
    ? word
    : undefined;
}

export function assessDirectiveMemoryWrite(input: AssessInput): DirectiveMemoryWriteAssessment {
  const memoryDir = resolveCanonicalRunPath(getMemoryDir());
  // 通用扫描对**所有非 read 工具**生效。原先门在 permissionLevel === 'write' 上，
  // 而落盘能力根本不跟着这个档位走：screenshot_page / ppt_generate 是 'network' 档
  // 却带 output_path，git_worktree 是 'execute' 档却带 path——三个都能把文件落进记忆
  // 目录而一声不吭。bash 也正因为是 'execute' 档，通用扫描对它返回空，只能靠 #1005
  // 补的那行显式声明兜住。
  //
  // 翻成「非 read 一律扫」而不是继续按名字给工具补声明：新增工具默认被扫，漏的是
  // 「参数名不像路径」那一类（命令字符串、自造参数名），那类仍需显式 pathAuthority。
  // read 档不写盘，扫了只是白费 + 徒增误报。
  const resolved = resolveToolWriteTargets(input);
  // uncertain ≠ 「要写记忆目录」：它只表示解析不出写目标（复合命令里的变量/反引号
  // 重定向、解析失败兜底等，RQ-066）。把无证据的 uncertain 并进 targets，会把根本没碰
  // 记忆目录的命令（`echo hi > "$OUT/f"`、`echo a && echo b` 一类）也拽进确认门，
  // headless 下整条 Bash 被 DIRECTIVE_MEMORY_HEADLESS_NO_UI_ERROR 劫杀。
  // uncertain 先经 env 展开核验真实去向、再做路径边界的字面证据判定（详见
  // uncertainMemoryTarget）；确定目标落进记忆目录的判定（含 canonical.command
  // 字面值命中）完全不受影响。
  const memoryAlias = path.join(path.basename(path.dirname(memoryDir)), path.basename(memoryDir));
  const env = input.env ?? {};
  // 展开 $VAR 的查找（shell 语义，PR #1790 三/四轮 ai-review Important）：逐条不确定
  // 重定向用它**所属 execution** 的字面赋值环境（命令内赋值按段序与作用域结算：
  // 独立赋值段对后续可见、不回污染先前，前缀赋值只作用于所附段，见
  // writeTargets.shellScopedUncertainRedirects）→ 再回落 AssessInput.env
  // （process.env 基准）。全局 last-wins 合并会把先后的同名赋值拍平，四轮审查原例
  // `OUT=/memory; …> "$OUT/a"; OUT=/tmp; …> "$OUT/b"` 第一条因此被误判漏门。
  const scopedUncertain = (input.definition.pathAuthority ?? [])
    .filter((descriptor) => descriptor.kind === 'shell')
    .flatMap((descriptor) => {
      const command = input.params[descriptor.commandParameter];
      return typeof command === 'string' ? shellScopedUncertainRedirects(command) : [];
    });
  const targets = [
    ...resolved.targets.filter((target) => isInside(target, memoryDir)),
    ...scopedUncertain
      .map(({ word, assignments }) => uncertainWordTarget(
        word,
        memoryDir,
        memoryAlias,
        input.workingDirectory,
        (name) => assignments[name] ?? env[name],
      ))
      .filter((target): target is string => target !== undefined),
  ];
  const uniqueTargets = [...new Set(targets)].sort();
  const fingerprint = JSON.stringify({
    tool: input.definition.name,
    params: input.params,
    targets: uniqueTargets,
  });
  return {
    requiresConfirmation: uniqueTargets.length > 0,
    fingerprint,
    targets: uniqueTargets,
    preview: JSON.stringify(input.params).slice(0, 4_000),
    buildConfirmView: () => buildDirectiveMemoryConfirmView({
      toolName: input.definition.name,
      params: input.params,
      targets: uniqueTargets,
    }),
  };
}

export function createDirectiveMemoryWriteGrant(
  assessment: DirectiveMemoryWriteAssessment,
  confirmation: DirectiveMemoryConfirmationResult,
): DirectiveMemoryWriteGrant {
  return {
    authority: 'directive-memory-write',
    fingerprint: assessment.fingerprint,
    requestId: confirmation.requestId,
    confirmedAt: confirmation.respondedAt,
  };
}

export function hasMatchingDirectiveMemoryWriteGrant(
  assessment: DirectiveMemoryWriteAssessment,
  grant: DirectiveMemoryWriteGrant | undefined,
): boolean {
  return !assessment.requiresConfirmation || (
    grant?.authority === 'directive-memory-write'
    && grant.fingerprint === assessment.fingerprint
  );
}

/** Targets the user confirmed via the directive dialog; undefined unless a matching grant exists. */
export function confirmedDirectiveMemoryTargets(
  assessment: DirectiveMemoryWriteAssessment,
  grant: DirectiveMemoryWriteGrant | undefined,
): readonly string[] | undefined {
  return assessment.requiresConfirmation && grant && hasMatchingDirectiveMemoryWriteGrant(assessment, grant)
    ? assessment.targets
    : undefined;
}

// 同一轮 run 里，已确认的规则文件所附带的 INDEX.md 指针更新不再弹第二次规则确认窗。
// 只认：本 run 已有确认过的非 INDEX 规则文件，且这次写入的目标全是 INDEX.md、
// 内容里点到了那个规则文件的名字。单独的 INDEX.md 写入、跨 run 的写入仍然要问。
const confirmedRuleFilesByRun = new Map<string, Set<string>>();
const MAX_TRACKED_RUNS = 200;
const INDEX_FILE_NAME = 'INDEX.md';

export function noteConfirmedRuleWrite(runKey: string | undefined, assessment: DirectiveMemoryWriteAssessment): void {
  if (!runKey) return;
  const rules = assessment.targets.map((t) => path.basename(t)).filter((name) => name !== INDEX_FILE_NAME);
  if (!rules.length) return;
  const known = confirmedRuleFilesByRun.get(runKey) ?? new Set<string>();
  rules.forEach((name) => known.add(name));
  confirmedRuleFilesByRun.delete(runKey);
  confirmedRuleFilesByRun.set(runKey, known);
  if (confirmedRuleFilesByRun.size > MAX_TRACKED_RUNS) {
    confirmedRuleFilesByRun.delete(confirmedRuleFilesByRun.keys().next().value as string);
  }
}

export function coveredIndexConfirmation(
  runKey: string | undefined,
  assessment: DirectiveMemoryWriteAssessment,
  params: Record<string, unknown>,
  definition: ToolDefinition,
): DirectiveMemoryConfirmationResult | undefined {
  const known = runKey ? confirmedRuleFilesByRun.get(runKey) : undefined;
  if (!known || !assessment.targets.length) return undefined;
  if (!isPlainIndexWrite(assessment, params, definition)) return undefined;
  const bodies = newContentTexts(params);
  const mentioned = [...known].some((name) => name.length > '.md'.length && bodies.some((b) => mentionsFileName(b, name)));
  if (!mentioned) return undefined;
  return { requestId: `covered-by-run-${runKey}`, confirmed: true, respondedAt: Date.now(), timedOut: false };
}

/**
 * 只有「路径参数本身就是规范写法、且落点恰好是 <memoryDir>/INDEX.md」才算 INDEX 写入。
 * 带 ..、. 段、重复分隔符、结尾斜杠的写法（memory.md/../INDEX.md）一律不豁免，
 * 走正常确认；shell 命令和没声明路径参数的工具同样不豁免。
 */
function isPlainIndexWrite(
  assessment: DirectiveMemoryWriteAssessment,
  params: Record<string, unknown>,
  definition: ToolDefinition,
): boolean {
  const memoryDir = resolveCanonicalRunPath(getMemoryDir());
  const indexPath = path.join(memoryDir, INDEX_FILE_NAME);
  if (!assessment.targets.every((t) => resolveCanonicalRunPath(t) === indexPath)) return false;
  const descriptors = definition.pathAuthority ?? [];
  if (!descriptors.length) return false;
  return descriptors.every((descriptor) => {
    if (descriptor.kind === 'shell') return false;
    const raw = params[descriptor.pathParameter];
    if (raw === undefined) return true;
    if (typeof raw !== 'string') return false;
    if (descriptor.kind === 'global-memory' && raw === INDEX_FILE_NAME) return true;
    const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
    return path.isAbsolute(expanded) && path.resolve(expanded) === expanded && expanded === indexPath;
  });
}

/** 只取「新写入的内容」字段：Write content、Edit new_string、MultiEdit edits[].new_string。 */
function newContentTexts(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['content', 'new_string']) {
    if (typeof params[key] === 'string') out.push(params[key] as string);
  }
  if (Array.isArray(params.edits)) {
    for (const edit of params.edits) {
      const next = (edit as { new_string?: unknown } | null)?.new_string;
      if (typeof next === 'string') out.push(next);
    }
  }
  return out;
}

function mentionsFileName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.-])${escaped}($|[^\\w.-])`).test(text);
}
