import { basename } from 'node:path';
import { CLI_CONNECTOR_DESCRIPTORS } from '../../shared/constants/cliConnectorDescriptors';
import { canonicalizeCommand } from '../security/canonicalizeCommand';
import { lenientCommandWords, parseShellCommand } from '../security/commandParse';

const READ_VERB = /(?:^|[-_])(?:list|get|mget|search|history|show|status)$/;
const READ_VALUE_FLAGS = new Set([
  '--profile', '--chat-id', '--message-id', '--user-id', '--query', '--keyword',
  '--page-size', '--page-token', '--limit', '--offset', '--start', '--end', '--status', '--fields',
]);
const TARGET_FLAGS = ['--message-id', '--chat-id', '--user-id', '--to', '--receive-id'];
const TEXT_FLAGS = ['--text', '--content', '--markdown', '--message'];
const ACTION_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|[-_])reply$/, '回复消息'],
  [/(?:^|[-_])send$/, '发送消息'],
  [/(?:^|[-_])create$/, '创建'],
  [/(?:^|[-_])(?:delete|remove)$/, '删除'],
  [/(?:^|[-_])(?:update|edit)$/, '修改'],
  [/(?:^|[-_])upload$/, '上传'],
];

function connectorFor(word: string) {
  return CLI_CONNECTOR_DESCRIPTORS.find(({ binaryName }) => basename(word) === binaryName);
}

/** Only a literal command path ending in a catalogued read verb qualifies. */
function isReadOnly(binaryName: string, args: string[]): boolean {
  const firstFlag = args.findIndex((arg) => arg.startsWith('-'));
  const commandPath = firstFlag < 0 ? args : args.slice(0, firstFlag);
  if (commandPath.length !== 2) return false;
  const [domain, verb] = commandPath;
  const readPath = (domain === 'auth' && verb === 'status') || (domain === 'config' && verb === 'show')
    || (binaryName === 'lark-cli' && /^[a-z][a-z0-9_-]*$/.test(domain)
      && /^\+[a-z][a-z0-9_-]*$/.test(verb) && READ_VERB.test(verb.slice(1)))
    || (binaryName === 'tmeet' && domain === 'meeting' && /^(?:list|get|mget|search|history|show|status)$/.test(verb));
  if (!readPath) return false;
  for (let index = commandPath.length; index < args.length; index += 1) {
    if (args[index] === '--json') continue;
    const [flag, inlineValue] = args[index].split(/=(.*)/s);
    if (!READ_VALUE_FLAGS.has(flag)) return false;
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith('-')) return false;
  }
  return true;
}

function flagValue(args: string[], flags: string[]): string | undefined {
  for (const flag of flags) {
    const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
    if (index < 0) continue;
    const value = args[index] === flag ? args[index + 1] : args[index].slice(flag.length + 1);
    // Never project an unresolved shell expression (or another flag) into the decision row.
    if (value && !value.startsWith('-') && !/[$`\n\r]/.test(value)) return value;
  }
  return undefined;
}

/**
 * Adds a deny only for known connector binaries. Parse the original spelling so quoted
 * text retains its word boundaries; canonical text is only a conservative detection view.
 * Compounds, wrappers and uncertain parses never earn the read-only exemption.
 */
export function getObserveConnectorCliAction(command: string): {
  toolName: string;
  target?: string;
  summary: string;
} | null {
  const canonical = canonicalizeCommand(command);
  const parsed = parseShellCommand(command);
  const invocation = parsed.executions.find(({ program }) => connectorFor(program));
  const uncertain = canonical.parsingFailed || parsed.parsingFailed || parsed.uncertain.length > 0;
  // This view is for display only, never for granting the read-only exemption.
  // Recover static text from a broken quote or backtick wrapper without copying shell syntax.
  const closingQuote = canonical.failureReason === 'unclosed double quote' ? '"'
    : canonical.failureReason === 'unclosed single quote' ? "'" : '';
  const fallbackWords = uncertain ? lenientCommandWords(command.replace(/`/g, ' ') + closingQuote) : [];
  const detectedWord = canonical.command.split(/[\s;|&()'"`<>]+/).find((word) => connectorFor(word));
  const descriptor = invocation ? connectorFor(invocation.program) : uncertain && detectedWord ? connectorFor(detectedWord) : undefined;
  if (!descriptor) return null;

  const simple = !uncertain && !parsed.trailingOperator && parsed.segments.length === 1
    && parsed.executions.length === 1 && invocation?.wrappers.length === 0
    && !invocation.environmentAssignments?.length
    && parsed.segments[0].words[0] === invocation.program;
  if (simple && isReadOnly(descriptor.binaryName, invocation.args)) return null;

  const fallbackIndex = fallbackWords.findIndex((word) => connectorFor(word));
  const args = fallbackIndex >= 0 ? fallbackWords.slice(fallbackIndex + 1) : invocation?.args ?? [];
  const commandPath = args.slice(0, args.findIndex((arg) => arg.startsWith('-')) < 0
    ? args.length : args.findIndex((arg) => arg.startsWith('-')));
  const verb = commandPath.at(-1)?.replace(/^\+/, '') ?? '';
  const action = ACTION_LABELS.find(([pattern]) => pattern.test(verb))?.[1] ?? '操作';
  const target = flagValue(args, TARGET_FLAGS);
  return {
    toolName: `${descriptor.displayName} ${action}`,
    ...(target ? { target } : {}),
    summary: flagValue(args, TEXT_FLAGS) ?? '连接器操作已记录，未执行',
  };
}
