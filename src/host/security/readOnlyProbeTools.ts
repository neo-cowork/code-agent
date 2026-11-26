// ============================================================================
// ReadOnlyProbe 文法扩展：which / 版本探测 / pdfinfo·pdftotext 到 stdout / 字面量 for 循环（词表可带引号）。
// 只做「语法 → 计划」；路径授权、二进制解析与执行在 readOnlyProbeExecutor.ts。
// 任何认不出的形状返回 null，调用方走原审批链。
// ============================================================================

export type ProbeToolCommand =
  | { kind: 'which'; names: string[]; builtins?: boolean }
  | { kind: 'version-probe'; name: string; flag: string; headLines?: number }
  | { kind: 'pdf-read'; program: 'pdfinfo' | 'pdftotext'; options: string[]; file: string };

const PROGRAM_NAME = /^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/;
const VERSION_FLAGS = new Set(['--version', '-V', '--help', '-h']);
// poppler 系只认 -v/-h/--help；`--version`/`-V` 会被当成输入文件名（工作目录里有同名 PDF 时会真的读/写文件）。
const POPPLER_PROGRAMS = new Set(['pdftotext', 'pdfinfo', 'pdftoppm', 'pdfimages', 'pdftohtml']);
const POPPLER_FLAGS = new Set(['-v', '-h', '--help']);
// npx/npm 只有 --version 会立刻退出且不写盘；-h/--help/-V 会往 npm 缓存写日志（探测先跑、退审批前就已落盘）。
const NPM_FAMILY_FLAGS = new Set(['--version']);
const NPM_FAMILY_PROGRAMS = new Set(['npx', 'npm']);
// 只有这里列出的程序，其 --version/-V/--help/-h 才免卡：已知只打印版本/用法、无副作用。
// 其余程序（pbcopy 会清空剪贴板、pbpaste 会输出剪贴板、ps -h 会列进程命令行、ssh-keygen -h 等）一律不认，走原审批链。
// 刻意保持很小：只放账本关心的 PDF / 运行时工具，新增前先确认该程序的这几个旗标在所有平台上都只读。
const PROBEABLE_PROGRAMS = new Set([
  'pdftotext', 'pdfinfo', 'pdftoppm', 'pdfimages', 'pdftohtml', 'mutool', 'qpdf', 'gs', 'pdftk',
  'tesseract', 'ocrmypdf', 'pandoc',
  'python', 'python3', 'pip', 'pip3', 'node', 'npm', 'npx', 'git', 'uv', 'ruby', 'cargo', 'rustc',
]);
const PAGE_NUMBER = /^\d{1,5}$/;

export function compileToolCommand(program: string, argv: string[]): { cmd: ProbeToolCommand; program: string } | null {
  if (!PROGRAM_NAME.test(program)) return null;
  if (program === 'which') {
    if (argv.length < 1 || argv.length > 32 || argv.some((name) => !PROGRAM_NAME.test(name))) return null;
    return { program, cmd: { kind: 'which', names: argv } };
  }
  const flagSet = POPPLER_PROGRAMS.has(program) ? POPPLER_FLAGS : NPM_FAMILY_PROGRAMS.has(program) ? NPM_FAMILY_FLAGS : VERSION_FLAGS;
  if (argv.length === 1 && flagSet.has(argv[0])) {
    if (!PROBEABLE_PROGRAMS.has(program)) return null;
    return { program, cmd: { kind: 'version-probe', name: program, flag: argv[0] } };
  }
  if (program === 'pdfinfo') {
    if (argv.length !== 1 || !argv[0] || argv[0].startsWith('-')) return null;
    return { program, cmd: { kind: 'pdf-read', program, options: [], file: argv[0] } };
  }
  if (program === 'pdftotext') {
    const options: string[] = [];
    let i = 0;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-layout') { options.push(a); continue; }
      if ((a === '-f' || a === '-l') && PAGE_NUMBER.test(argv[i + 1] ?? '')) { options.push(a, argv[++i]); continue; }
      if (a === '-enc' && argv[i + 1] === 'UTF-8') { options.push(a, argv[++i]); continue; }
      break;
    }
    // 输出必须是字面量 `-`（stdout）；缺省输出文件名或具名输出文件都会写盘，留给审批。
    if (argv.length - i !== 2 || argv[i + 1] !== '-' || !argv[i] || argv[i].startsWith('-')) return null;
    return { program, cmd: { kind: 'pdf-read', program, options, file: argv[i] } };
  }
  return null;
}

// ----------------------------------------------------------------------------
// for <var> in <字面量词>; do <体>; done
// 词表只允许字面量：无引号的纯字面量词，或整词用单引号 / 双引号括起的字面量。
// 每次迭代整体重新编译，所以体里的每条命令都必须自己在文法内；命令替换 / 反引号 / 其它变量展开一律不认。
// 循环变量的值怎么进到体里，按词分两条路：
//  - 无引号安全词（纯 ASCII 标识符类字符，shell 赋不了别的含义）：照旧以文本替换后重新编译；
//  - 其余词（带空格 / 中文 / 括号…）：值从不进文本，作为编译期已知值绑定给循环变量，由分词器在双引号里折叠。
//  for 前面可以是行首 / `;` / 换行，或一条无条件的 `cd`（`cd X && for …`）。
// ----------------------------------------------------------------------------

const LOOP_HEAD = /(^|[;\n]|&&)[ \t]*for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in[ \t]+/;
const LOOP_TAIL = /^[;\n][ \t\n]*do[ \t\n]+([\s\S]*?)[;\n][ \t\n]*done[ \t]*(?:[;\n]([\s\S]*))?$/;
const LOOP_WORD = /^[A-Za-z0-9._+/@:,=][A-Za-z0-9._+/@:,=-]*$/;
// 引号里的字面量内容：不含 shell 还可能赋予含义的字符（展开 / 反斜杠 / 通配 / 波浪线 / 控制字符）
const QUOTED_WORD_FORBIDDEN = /[$`\\~*?[\p{Cc}]/u;
// 体内不许再有循环或其它控制结构；`if … fi` 的一层结构由编译器逐 token 校验
const NESTED_CONTROL = /(^|[;\n&|][ \t]*)(for|do|done|while|until|case|esac|select|function)\b/;
const MAX_LOOP_WORDS = 32;
const MAX_LOOP_STEPS = 200;

interface WithOp { op: ';' | '&&' | '||' }

interface LiteralWord { value: string; wordSafe: boolean }

/** 从 from 起读词表，到引号外的 `;` / 换行为止；任一词不是字面量就返回 null。 */
function parseLiteralWords(src: string, from: number): { words: LiteralWord[]; end: number } | null {
  const words: LiteralWord[] = [];
  let i = from;
  for (;;) {
    while (src[i] === ' ' || src[i] === '\t') i++;
    if (i >= src.length || src[i] === ';' || src[i] === '\n') return words.length > 0 ? { words, end: i } : null;
    const start = i;
    const quote = src[i] === "'" || src[i] === '"' ? src[i] : null;
    if (quote) {
      const close = src.indexOf(quote, i + 1);
      if (close < 0) return null;
      i = close + 1;
    } else {
      while (i < src.length && ![' ', '\t', ';', '\n'].includes(src[i])) i++;
    }
    const value = src.slice(start + (quote ? 1 : 0), i - (quote ? 1 : 0));
    const next = src[i];
    // 引号后紧跟别的字符（拼接词）、空词、以 - 开头（会被当选项）都不认
    if ((next !== undefined && next !== ' ' && next !== '\t' && next !== ';' && next !== '\n') || value === '' || value.startsWith('-')) return null;
    if (quote ? QUOTED_WORD_FORBIDDEN.test(value) : !LOOP_WORD.test(value)) return null;
    words.push({ value, wordSafe: !value.startsWith('-') && LOOP_WORD.test(value) });
  }
}

/**
 * 体内对循环变量的引用出现在哪：单引号里是字面量（shell 不展开），文本替换会改变语义 → 返回 null；
 * 否则报告有没有引号外的引用。
 */
function scanLoopReferences(body: string, refStart: RegExp): { unquoted: boolean } | null {
  let quote: "'" | '"' | null = null;
  let unquoted = false;
  const referencesAt = (i: number): boolean => refStart.test(body.slice(i));
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else if (c === '$' && referencesAt(i)) return null;
      continue;
    }
    // 引号外 / 双引号里转义过的下一个字符不参与引号判断（引号外的反斜杠分词器本来就不认）
    if (c === '\\') { i++; continue; }
    if (quote === '"') { if (c === '"') quote = null; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '$' && referencesAt(i)) unquoted = true;
  }
  return { unquoted };
}

/** 循环体一次迭代的编译上下文：循环变量叫什么、这一轮等于什么、值是怎么进到文本里的。 */
export interface LoopBodyBinding {
  name: string;
  value: string;
  /** true = value 已作为纯字面量替换进 text；false = text 原样，循环变量按 value 折叠（值不进文本）。 */
  expanded: boolean;
}

/** undefined = 不是循环；null = 是循环但不能证明只读；否则返回展开后的步骤。 */
export function expandLiteralForLoop<S extends WithOp>(
  command: string,
  compile: (text: string, loopBody?: LoopBodyBinding) => { steps: S[] } | null,
): S[] | null | undefined {
  const head = LOOP_HEAD.exec(command);
  if (!head) return /(^|[;\n&|][ \t]*)for\b/.test(command) ? null : undefined;
  const variable = head[2];
  const list = parseLiteralWords(command, head.index + head[0].length);
  const tail = list && LOOP_TAIL.exec(command.slice(list.end));
  if (!list || !tail) return null;
  const [, body, rest] = tail;
  if (list.words.length > MAX_LOOP_WORDS || !body.trim() || NESTED_CONTROL.test(body)) return null;
  const ref = new RegExp(`\\$\\{${variable}\\}|\\$${variable}(?![A-Za-z0-9_])`, 'g');
  const references = scanLoopReferences(body, new RegExp(`^\\$\\{${variable}\\}|\\$${variable}(?![A-Za-z0-9_])`));
  // 引号外的引用只对无引号安全词成立（文本替换）；带引号的词只在双引号里折叠
  if (!references || (references.unquoted && list.words.some((w) => !w.wordSafe))) return null;
  const prefixText = command.slice(0, head.index).trim();
  const steps: S[] = [];
  const add = (text: string, loopBody?: LoopBodyBinding): boolean => {
    const plan = compile(text, loopBody);
    if (!plan) return false;
    steps.push(...plan.steps.map((s, i) => (i === 0 ? { ...s, op: ';' as const } : s)));
    return true;
  };
  if (prefixText && !add(prefixText)) return null;
  if (head[1] === '&&') {
    // `cd X && for …`：cd 失败会让整个计划中止，与用 ; 接等价。换成别的命令，失败只是非零退出码、shell 会跳过循环而计划不会，不认。
    // 这条 cd 自己也必须是无条件的：`[ -d build ] && cd build && for …` 在条件不成立时 shell 不跑循环，计划却会在原目录跑
    const last = steps[steps.length - 1] as { op?: string; cmd?: { kind?: unknown } } | undefined;
    if (last?.op !== ';' || last.cmd?.kind !== 'cd') return null;
  }
  for (const { value, wordSafe } of list.words) {
    if (!add(wordSafe ? body.replace(ref, value) : body, { name: variable, value, expanded: wordSafe })) return null;
  }
  if (rest?.trim() && !add(rest)) return null;
  return steps.length > 0 && steps.length <= MAX_LOOP_STEPS ? steps : null;
}
