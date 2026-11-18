// ============================================================================
// ReadOnlyProbe 文法扩展：which / 版本探测 / pdfinfo·pdftotext 到 stdout / 字面量 for 循环。
// 只做「语法 → 计划」；路径授权、二进制解析与执行在 readOnlyProbeExecutor.ts。
// 任何认不出的形状返回 null，调用方走原审批链。
// ============================================================================

export type ProbeToolCommand =
  | { kind: 'which'; names: string[] }
  | { kind: 'version-probe'; name: string; flag: string }
  | { kind: 'pdf-read'; program: 'pdfinfo' | 'pdftotext'; options: string[]; file: string };

const PROGRAM_NAME = /^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/;
const VERSION_FLAGS = new Set(['--version', '-V', '--help', '-h']);
// `-v` 不是通用版本旗标（python3 -v 是 verbose），只对已知把它当版本的程序放行。
const DASH_V_PROGRAMS = new Set(['pdftotext', 'pdfinfo', 'pdftoppm', 'pdfimages']);
// -h/-V 在这些程序里另有含义或会再执行别的程序：不当作版本探测。
const NOT_PROBEABLE = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'env', 'xargs', 'nohup', 'sudo', 'su', 'doas',
  'time', 'timeout', 'nice', 'exec', 'eval', 'command', 'builtin', 'open', 'osascript', 'ssh', 'scp', 'sftp',
]);
const PAGE_NUMBER = /^\d{1,5}$/;

export function compileToolCommand(program: string, argv: string[]): { cmd: ProbeToolCommand; program: string } | null {
  if (!PROGRAM_NAME.test(program)) return null;
  if (program === 'which') {
    if (argv.length < 1 || argv.length > 32 || argv.some((name) => !PROGRAM_NAME.test(name))) return null;
    return { program, cmd: { kind: 'which', names: argv } };
  }
  if (argv.length === 1 && (VERSION_FLAGS.has(argv[0]) || (argv[0] === '-v' && DASH_V_PROGRAMS.has(program)))) {
    if (NOT_PROBEABLE.has(program)) return null;
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
// 词表只允许无引号纯字面量；体里的循环变量引用逐词替换成字面量后，每次迭代整体重新编译，
// 所以体里的每条命令都必须自己在文法内。命令替换 / 反引号 / 其它变量展开一律不认。
// ----------------------------------------------------------------------------

const LOOP = /(^|[;\n])[ \t]*for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in[ \t]+([^;\n$`'"\\()<>|&*?[\]{}!#]+?)[ \t]*[;\n][ \t\n]*do[ \t\n]+([\s\S]*?)[;\n][ \t\n]*done[ \t]*(?:[;\n]([\s\S]*))?$/;
const LOOP_WORD = /^[A-Za-z0-9._+/@:,=][A-Za-z0-9._+/@:,=-]*$/;
const NESTED_CONTROL = /(^|[;\n&|][ \t]*)(for|do|done|while|until|if|then|else|fi|case|esac|select|function)\b/;
const MAX_LOOP_WORDS = 32;
const MAX_LOOP_STEPS = 200;

interface WithOp { op: ';' | '&&' | '||' }

/** undefined = 不是循环；null = 是循环但不能证明只读；否则返回展开后的步骤。 */
export function expandLiteralForLoop<S extends WithOp>(
  command: string,
  compile: (text: string) => { steps: S[] } | null,
): S[] | null | undefined {
  const match = LOOP.exec(command);
  if (!match) return /(^|[;\n&|][ \t]*)for\b/.test(command) ? null : undefined;
  const [, , variable, wordText, body, rest] = match;
  const words = wordText.trim().split(/[ \t]+/);
  if (words.length > MAX_LOOP_WORDS || words.some((w) => !LOOP_WORD.test(w) || w.startsWith('-'))) return null;
  if (!body.trim() || body.includes("'") || NESTED_CONTROL.test(body)) return null;
  const prefixText = command.slice(0, match.index).trim();
  const steps: S[] = [];
  const add = (text: string): boolean => {
    const plan = compile(text);
    if (!plan) return false;
    steps.push(...plan.steps.map((s, i) => (i === 0 ? { ...s, op: ';' as const } : s)));
    return true;
  };
  if (prefixText && !add(prefixText)) return null;
  const ref = new RegExp(`\\$\\{${variable}\\}|\\$${variable}(?![A-Za-z0-9_])`, 'g');
  for (const word of words) {
    if (!add(body.replace(ref, word))) return null;
  }
  if (rest && rest.trim() && !add(rest)) return null;
  return steps.length > 0 && steps.length <= MAX_LOOP_STEPS ? steps : null;
}
