// ============================================================================
// rmCommandTargets — 从 Bash 命令文本解析 rm 的删除目标（宿主与渲染层共用）
// ----------------------------------------------------------------------------
// 审批卡曾只取第一个 rm 目标就写「约 1 个文件」：`rm -rf a.log b.log c.log` 删 3 个
// 文件，卡片却说删 1 个。宿主盘点（details.affectedFileCount）与渲染层兜底必须用
// 同一套解析口径，所以放在 shared：纯函数，不碰 node/DOM。
//
// 解析只求「数得清就给数，数不清就如实说不确切」，不承担安全判定——放行与否
// 仍由 commandSafety / permissionClassifier 负责。
// ============================================================================

export interface RmCommandTargets {
  /** rm 的位置参数（已去引号），按命令出现顺序；管道/xargs/-exec 喂入的目标不可知，不在此列。 */
  targets: string[];
  /**
   * 目标清单是否足以算出确切文件数。通配符/变量/命令替换、管道或 xargs/-exec 喂入、
   * 命令替换段都算不确切；不确切时上层不得展示任何具体数字。
   */
  exact: boolean;
  /** 命令带 -r/-R/--recursive。递归删目录时目标数≠文件数，上层不得拿目标数当文件数。 */
  recursive: boolean;
}

// 通配与展开字符：目标命中任意一个就算不出确切清单。`$` 覆盖变量展开，反引号覆盖命令替换。
const INDETERMINATE_TARGET_CHARS = /[*?[{`$]/u;

// 重定向算符（可带 fd 前缀/后缀）：`>` `>>` `2>` `2>&1` `&>log` `<<EOF`。
// 捕获组是算符后的剩余部分：空 = 落点是下一个 token；`&数字` = fd 复制自含；其余 = 落点连写自含。
const REDIRECT_OPERATOR = /^[0-9]*&?[<>]{1,2}(.*)$/u;

interface CommandSegment {
  text: string;
  /** 该段由 `|` 直接喂入（上一段经管道接进来）。 */
  fedByPipe: boolean;
}

/**
 * 按控制运算符（`;` `&&` `||` `|` `&` 换行）切段，引号内的运算符不切。
 * `2>&1` 里的 `&` 两侧是重定向字符，不当控制符。切段后各段保留原始引号，交给分词。
 */
function splitSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let buffer = '';
  let quote = '';
  // 当前 buffer 之前的连接运算符；`&&`/`||` 两个字符逐个 flush，最终落成单字符即可。
  let separator = '';
  const flush = (): void => {
    if (buffer.trim()) segments.push({ text: buffer, fedByPipe: separator === '|' });
    buffer = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (quote) {
      buffer += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|') {
      flush();
      separator = ch;
      continue;
    }
    const redirectsNeighbor = index > 0 && (command[index - 1] === '>' || command[index - 1] === '<')
      || command[index + 1] === '>' || command[index + 1] === '<';
    if (ch === '&' && !redirectsNeighbor) {
      flush();
      separator = ch;
      continue;
    }
    buffer += ch;
  }
  flush();
  return segments;
}

/** 引号感知分词："a b" 与 'a b' 各成一个 token 并去引号；未闭合引号把剩余文本收进最后一个 token。 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function markRecursiveFlag(token: string, result: RmCommandTargets): void {
  if (token === '--recursive' || (!token.startsWith('--') && /[rR]/u.test(token))) {
    result.recursive = true;
  }
}

/**
 * 吃掉一段 rm 之后的 token：`--` 前是选项（顺带识别递归 flag），`--` 后全是目标。
 * 重定向算符与其落点不进目标清单（`rm a b > log` 只删 a、b）。collect=false 时只
 * 识别选项，用于 xargs/-exec 喂入的 rm（目标来自上游，不猜清单）。
 */
function consumeRmArgs(tokens: string[], result: RmCommandTargets, collect: boolean): void {
  let afterDoubleDash = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!afterDoubleDash) {
      if (token === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (token.startsWith('-')) {
        markRecursiveFlag(token, result);
        continue;
      }
    }
    if (!collect) continue;
    const redirect = /[<>]/u.test(token) ? REDIRECT_OPERATOR.exec(token) : null;
    if (redirect) {
      // 落点与算符分离（`> log`）时落点是下一个 token；`2>&1`、`>log` 自含。
      if (redirect[1] === '') index += 1;
      continue;
    }
    if (!token) continue;
    result.targets.push(token);
    if (/[<>]/u.test(token) || INDETERMINATE_TARGET_CHARS.test(token)) result.exact = false;
  }
}

function parseSegment(segment: CommandSegment, result: RmCommandTargets): void {
  const tokens = tokenize(segment.text);
  if (tokens.length === 0) return;
  // 只有段首的 rm（含 sudo rm）才可能解析出确切目标。
  const leading = tokens[0] === 'sudo' ? 1 : 0;
  if (tokens[leading] === 'rm') {
    // 管道喂进来的 rm 操作数可能来自上游输出；命令替换里的目标同样数不清。
    if (segment.fedByPipe || segment.text.includes('$(')) result.exact = false;
    consumeRmArgs(tokens.slice(leading + 1), result, true);
    return;
  }
  const rmIndex = tokens.indexOf('rm');
  if (rmIndex > 0) {
    // xargs / find -exec 喂进来的 rm：操作数来自上游输出，标记不确切、不猜目标。
    result.exact = false;
    consumeRmArgs(tokens.slice(rmIndex + 1), result, false);
  }
}

/**
 * 解析命令里每一段 rm 的删除目标。多段 rm（`rm a && rm b`）目标合并、exact 取与、
 * recursive 取或；找不到 rm 时返回空目标且 exact（上层按「无目标」处理，不写数字）。
 */
export function parseRmTargets(command: string): RmCommandTargets {
  const result: RmCommandTargets = { targets: [], exact: true, recursive: false };
  if (typeof command !== 'string' || command.trim() === '') return result;
  for (const segment of splitSegments(command)) {
    parseSegment(segment, result);
  }
  return result;
}
