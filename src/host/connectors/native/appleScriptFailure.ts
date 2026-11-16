// Failure classification and display text only; native execution stays in the connector executor.
import { getConfigService } from '../../services/core/configService';

// TCC 拒绝 Apple Events 自动化时执行进程以 errno -1743 退出（典型文案
// "Not authorized to send Apple events to Mail."）。匹配错误码或措辞把这类失败
// 归为「授权被拒」而不是一般读取失败（screenshotFailureCause / photos.ts 各有
// 私有同款判断，这里是可复用的一份）。
const APPLE_EVENTS_DENIED_PATTERN = /-1743|not authorized to send apple events/i;

/**
 * 判断错误是否为 Apple Events 授权被拒（-1743）。输入是 Error 时看 message，
 * 是字符串时直接匹配；其余一律 false。调用方用它把 read-error 细分成
 * not-authorized，渲染层才能给出「去设置」而不是永远重试。
 */
export function isAppleEventsDenied(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : '';
  return APPLE_EVENTS_DENIED_PATTERN.test(message);
}

export type AppleScriptFailureCode = 'not_authorized' | 'not_found' | 'timeout' | 'read_failed';

const APPLE_SCRIPT_NOT_FOUND_PATTERN = /-1728|can['’]t get/i;

function describeAppleScriptFailureText(
  english: boolean,
  label: string,
  code: AppleScriptFailureCode,
  timeoutContext?: 'calendar_list_events' | 'list_reminders' | 'write',
): string {
  if (english) {
    switch (code) {
      case 'not_authorized':
        return `${label} access was denied. Allow Neo under System Settings > Privacy & Security > Automation, then try again.`;
      case 'not_found':
        return `${label} could not find the requested mailbox, account or calendar. Check that the account exists in the ${label} app.`;
      case 'timeout':
        if (timeoutContext === 'list_reminders') {
          return `${label} took too long to read reminders. Open ${label} and check for a pending permission prompt, then try a specific list name or a lower limit.`;
        }
        return timeoutContext === 'calendar_list_events'
          ? `${label} did not respond in time (timeout). Narrow the date range or pass a specific calendar name instead of retrying unchanged.`
          : timeoutContext === 'write'
            ? `${label} did not respond in time (timeout). The result could not be confirmed; check ${label} before retrying, and do not retry blindly.`
          : `${label} did not respond in time. Please try again later.`;
      default:
        return `${label}: Read failed, please try again later`;
    }
  }
  switch (code) {
    case 'not_authorized':
      return `${label} 未获授权：请在「系统设置 > 隐私与安全性 > 自动化」中允许 Neo 控制 ${label}，然后重试。`;
    case 'not_found':
      return `${label} 找不到指定的邮箱/账户/日历：请在 ${label} 应用中检查对应账户是否存在。`;
    case 'timeout':
      if (timeoutContext === 'list_reminders') {
        return `${label} 读取提醒超时：请打开 ${label}，检查是否有待处理的授权提示，然后指定列表名称或减少读取条数。`;
      }
      return timeoutContext === 'calendar_list_events'
        ? `${label} 响应超时：请缩小查询时间范围或指定具体日历名称（calendar），不要原样重试。`
        : timeoutContext === 'write'
          ? `${label} 响应超时：结果无法确认，请先在 ${label} 中检查是否已完成，不要直接重试。`
        : `${label} 响应超时，请稍后重试。`;
    default:
      return `${label}：读取失败，请稍后重试`;
  }
}

/**
 * 把 AppleScript 异常转成一句给用户/模型看的人话。execFile 的 error.message 以
 * "Command failed: <命令> -e <整段脚本>" 开头，绝不能原样外露；这里只按错误码/信号分类，
 * 返回文案不含命令行、脚本或 stderr。原始异常由调用方写 host 日志。
 */
export function describeAppleScriptFailure(
  connectorLabel: string | { zh: string; en: string },
  error: unknown,
  options?: { timeoutContext?: 'calendar_list_events' | 'list_reminders' | 'write' },
): { message: string; code: AppleScriptFailureCode } {
  const fields = (typeof error === 'object' && error !== null ? error : {}) as {
    killed?: unknown; signal?: unknown; code?: unknown; stderr?: unknown;
  };
  const text = [
    error instanceof Error ? error.message : typeof error === 'string' ? error : '',
    typeof fields.stderr === 'string' ? fields.stderr : '',
  ].join('\n');
  let code: AppleScriptFailureCode = 'read_failed';
  if (isAppleEventsDenied(text) || /not authorized/i.test(text)) code = 'not_authorized';
  else if (APPLE_SCRIPT_NOT_FOUND_PATTERN.test(text)) code = 'not_found';
  else if (fields.killed === true || fields.signal === 'SIGTERM' || fields.code === 'ETIMEDOUT') code = 'timeout';
  let english: boolean;
  try {
    english = getConfigService().getSettings().ui?.language === 'en';
  } catch {
    english = false;
  }
  return {
    message: describeAppleScriptFailureText(
      english,
      typeof connectorLabel === 'string' ? connectorLabel : connectorLabel[english ? 'en' : 'zh'],
      code,
      options?.timeoutContext,
    ),
    code,
  };
}

/**
 * 是否为 AppleScript/execFile 失败（而非连接器自己 throw 的参数/平台校验错误）。
 * 只有这类错误的 message 才会带整段脚本，才需要被改写成人话。
 */
export function isAppleScriptFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { message?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown; code?: unknown };
  return (typeof e.message === 'string' && e.message.startsWith('Command failed:'))
    || typeof e.stderr === 'string'
    || e.killed === true
    || (typeof e.signal === 'string' && e.signal !== '')
    || e.code === 'ETIMEDOUT';
}

/** 写 host 日志用的排查详情：stderr 优先；否则去掉开头的 "Command failed: <命令> …" 命令行，截断 300 字。 */
export function appleScriptFailureLogDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().slice(0, 300);
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split('\n');
  if (lines[0].startsWith('Command failed:')) {
    // 脚本以多个 -e 参数内联，命令行之后的最后几行是 AppleScript 的 stderr（取末 3 行，避开脚本正文）
    return lines.slice(1).slice(-3).join('\n').trim().slice(0, 300);
  }
  return message.slice(0, 300);
}

