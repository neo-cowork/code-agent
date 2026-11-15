// 浏览器面板空状态文案选择。
// 后台浏览器任务在跑、托管标签却还停在空白页（about:blank / 无地址）时，面板不能再说
// 「Neo 还没开始操作网页」——那是在对用户撒谎：活儿正在后台浏览器里干。
import type { useI18n } from '../../hooks/useI18n';

type AgentWindowCopy = ReturnType<typeof useI18n>['t']['workbenchTabs']['agentWindow'];

function isBlankPageUrl(url: string | null | undefined): boolean {
  const trimmed = url?.trim();
  return !trimmed || trimmed === 'about:blank';
}

interface BrowserEmptyTextInput {
  repairNeeded: boolean;
  blockedDetail?: string | null;
  streaming: boolean;
  streamUnavailable: boolean;
  running: boolean;
  activeUrl: string | null | undefined;
}

export function resolveBrowserEmptyText(
  copy: AgentWindowCopy,
  input: BrowserEmptyTextInput,
): { title: string; hint: string } {
  if (input.repairNeeded) return { title: copy.notReadyTitle, hint: input.blockedDetail || copy.idleHint };
  if (input.streaming) return { title: copy.connecting, hint: copy.idleHint };
  if (input.streamUnavailable) return { title: copy.streamUnavailable, hint: copy.idleHint };
  if (input.running && isBlankPageUrl(input.activeUrl)) {
    return { title: copy.backgroundBusyTitle, hint: copy.backgroundBusyHint };
  }
  if (!isBlankPageUrl(input.activeUrl)) return { title: copy.backgroundTitle, hint: copy.backgroundHint };
  return { title: copy.idleTitle, hint: copy.idleHint };
}
