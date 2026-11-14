import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const forbidden = /osascript|runAppleScript|CGRequest|IOHIDRequestAccess|askUserIfNeeded\s*:\s*true|requestAccess|requestAccessibility/;
const probes = 'src/host/permissions/envAssist/probes/';
const grant = 'src/host/permissions/envAssist/grants/requestGrant.ts';

// Existing host exceptions are frozen by exact line, never blanket file exemptions.
// Each listed file is justified below; additions within these files still fail.
const legacyLines: Record<string, string[]> = {
  // Comments explain the existing forbidden shell bypass.
  "src/host/app/morningBriefSaveDraftTools.ts": ["// - delegate_task：后台任务自带完整工具面，会绕回 Bash/osascript 真发信；", "// - Bash：shell 执行工具，osascript 调 Mail 的直接旁路。"],
  // Comment enumerates trusted command consumers.
  "src/host/utils/safeShell.ts": ["// - cmd 必须是受信任的常量（'open', 'xdg-open', 'osascript', 'explorer.exe' 等）"],
  // Existing sandbox command classification and refusal explanation.
  "src/host/sandbox/osSandboxPolicy.ts": ["const MACOS_LAUNCH_PATTERN = COMMAND_TOKEN(['open', 'osascript']);", "'`open` and `osascript` need LaunchServices / Apple Events that sandbox-exec blocks. '"],
  // Existing consent guard recognizes automation commands.
  "src/host/task/macosAutomationPrompt.ts": ["const AUTOMATION_COMMAND_PATTERN = /osascript|tell application|system events/i;"],
  // Imports existing connector error classifier; not a probe.
  "src/host/ipc/cron.ipc.ts": ["import { isAppleEventsDenied } from '../connectors/native/osascript';"],
  // Existing explicit voice paste action executes keystrokes.
  "src/host/ipc/voicePaste.ipc.ts": ["execFile('osascript', ['-e', 'tell application \"System Events\" to keystroke \"v\" using command down'],"],
  // Comment describes existing mail connector polling.
  "src/host/cron/cronMailPoller.ts": ["// list_messages（osascript 秒级）的在飞轮询——那趟 settle 后若再 scheduleTick，"],
  // Model tool-description guidance mentions GUI osascript disclosure; never executes it.
  "src/host/mcp/cuaLadderGuidance.ts": ["// shell）→ browser_action（网页）→ 屏幕控制（最后手段；首次 GUI 操作含 osascript，动手前先说一句话）。", "'Prefer connectors/files/shell/browser_action. Before first GUI control (including osascript), say one sentence naming the app and why direct control is needed; pure Apple Events data access is exempt.';"],
  // System prompt capability-ladder guidance mentions Bash/osascript disclosure; never executes it.
  "src/host/prompts/base/tools.ts": ["- Capability ladder: connectors/native tools first; browser_action for web; screen last. Before a run's first GUI action (also Bash/osascript activation/clicks/keys/open-document edits), emit ONE sentence in content, not reasoning, in the user's language naming the app and why no connector/browser route works. Exclude pure connector/Apple Events data access. Unavailable connector: state it in content and call a tool under normal per-app approval"],
  // Comment describes existing notification delivery history.
  "src/host/services/infra/notificationService.ts": ["* 图标与身份，点击经 onAction 跳到对应会话。替代旧的 osascript（无图标、点击不回调）。"],
  // Existing desktop AX action/context execution.
  "src/host/services/desktop/backgroundAxBridge.ts": ["const stdout = getExecStdout(await execFileAsync('osascript', [", "const stdout = getExecStdout(await execFileAsync('osascript', ["],
  // Existing desktop application/window context execution.
  "src/host/services/desktop/computerSurfaceContext.ts": ["const stdout = getExecStdout(await execFileAsync('osascript', [", "const stdout = getExecStdout(await execFileAsync('osascript', [", "const stdout = getExecStdout(await execFileAsync('osascript', ["],
  // Comment describes existing coordinate units.
  "src/host/services/desktop/backgroundCgEventSurface.ts": ["/** 主显示器逻辑点尺寸（osascript/cliclick/CGEvent 都吃这个空间） */"],
  // Comment describes existing connector read timeout; no new execution.
  "src/host/services/roleAssets/nativeSourceProbe.ts": ["// 单次探测的耗时上限沿用 osascript 的 AppleScript 调用上限，不另设超时。"],
  // Comment describes existing screen context source.
  "src/host/services/voice/voiceScreenContext.ts": ["// 前台 app/窗口名走 computerSurfaceContext 既有的 osascript，附件与隐藏上下文形状"],
  // S1 comment classifies an existing failure, never executes it.
  "src/host/permissions/envAssist/screenshotFailureCause.ts": ["// osascript without Automation (Apple Events) permission reports"],
  // Comment describes existing connector tool preloading.
  "src/host/agent/runtime/contextAssembly/deferredToolPreload.ts": ["// 才拿得到，模型常直接绕 Bash osascript（FB-498）。命中意图才预载，避免每轮多挂"],
  // Photo archive plugin comments describe connector execution.
  "src/host/plugins/builtin/photoArchive/index.ts": ["// - src/host/connectors/native/photos.ts — Photos.app osascript connector", "// - 'shell' — 调用 photos connector 的 osascript 和 vision-tagger 子进程"],
  // Existing named-window screenshot tool uses AppleScript window lookup.
  "src/host/tools/vision/screenshot.ts": ["command = `screencapture -l$(osascript -e 'tell app \"${windowName}\" to id of window 1') \"${outputPath}\"`;"],
  // Comment describing existing coordinate consumers; no execution.
  "src/host/tools/vision/coordinateTransform.ts": ["// 而 osascript / cliclick / CGEvent 执行器吃的是\"逻辑屏幕点\"（pointWidth × pointHeight）。"],
  // Existing desktop platform action executes AppleScript.
  "src/host/tools/vision/computerUsePlatformActions.ts": ["await execFileAsync('osascript', ["],
  // Existing GUI tool executes click, key and scroll actions.
  "src/host/tools/vision/guiAgent.ts": ["`osascript -e 'tell application \"System Events\" to click at {${Math.round(pos.x)}, ${Math.round(pos.y)}}'`", "`osascript -e 'tell application \"System Events\" to click at {${Math.round(pos.x)}, ${Math.round(pos.y)}}' && ` +", "`osascript -e 'tell application \"System Events\" to click at {${Math.round(pos.x)}, ${Math.round(pos.y)}}'`", "`osascript -e 'tell application \"System Events\" to click at {${Math.round(pos.x)}, ${Math.round(pos.y)}} with control down'`", "`osascript -e 'tell application \"System Events\" to key code ${specialKeys[mainKey]}${modStr}'`", "`osascript -e 'tell application \"System Events\" to keystroke \"${mainKey}\"${modStr}'`", "`osascript -e 'tell application \"System Events\" to keystroke \"${mainKey}\"${modStr}'`", "`osascript -e 'tell application \"System Events\" to keystroke \"${escaped.slice(0, -1)}\"' && ` +", "`osascript -e 'tell application \"System Events\" to key code 36'`", "`osascript -e 'tell application \"System Events\" to keystroke \"${escaped}\"'`", "`osascript -e 'tell application \"System Events\" to scroll {${deltaX}, ${deltaY}}'`"],
  // Existing reminders write tool failure handling and safety copy.
  "src/host/tools/modules/connectors/remindersCreate.ts": ["} from '../../../connectors/native/osascript';", "'Do not work around this by running osascript or AppleScript through Bash or any script; at most retry reminders_create once or tell the user.';", "'Do not work around this by running osascript or AppleScript through Bash or any script; do not retry reminders_create blindly and tell the user.';", "ctx.logger.warn('reminders_create osascript failed', {"],
  // Existing connector failure logging and safety guidance.
  "src/host/tools/modules/connectors/appleScriptWriteFailure.ts": ["} from '../../../connectors/native/osascript';", "'Do not work around this by running osascript or AppleScript through Bash or any script; tell the user what failed.';", "logger.warn(`${toolName} osascript failed`, {"],
  // Calendar connector execution/failure translation (S4).
  "src/host/tools/modules/connectors/calendar.ts": ["} from '../../../connectors/native/osascript';", "const osascriptFailure = isAppleScriptFailure(error);", "const failureCode = osascriptFailure ? failure.code : 'connector_error';", "error: osascriptFailure", "...(osascriptFailure ? { code: failure.code } : {}),"],
  // Reminders connector execution/failure translation (S4).
  "src/host/tools/modules/connectors/reminders.ts": ["} from '../../../connectors/native/osascript';", "const osascriptFailure = isAppleScriptFailure(error);", "code: osascriptFailure ? failure.code : 'connector_error',", "error: osascriptFailure", "...(osascriptFailure ? { code: failure.code } : {}),"],
  // Mail connector execution/failure translation (S4).
  "src/host/tools/modules/connectors/mail.ts": ["} from '../../../connectors/native/osascript';", "const osascriptFailure = isAppleScriptFailure(error);", "code: osascriptFailure ? failure.code : 'connector_error',", "error: osascriptFailure", "...(osascriptFailure ? { code: failure.code } : {}),"],
  // Photos connector executes user-requested Apple Events (S4).
  "src/host/connectors/native/photos.ts": ["import { escapeAppleScriptString, runAppleScript } from './osascript';", "const output = await runAppleScript([", "const output = await runAppleScript(lines);", "const output = await runAppleScript(lines);", "const output = await runAppleScript(scriptLines);"],
  // Calendar connector execution/failure translation (S4).
  "src/host/connectors/native/calendar.ts": ["runAppleScript,", "} from './osascript';", "const output = await runAppleScript([", "const output = await runAppleScript([", "const output = await runAppleScript(buildSingleCalendarEventsScript(calendarName, fromMs, toMs, eventLimit));", "const output = await runAppleScript(buildSingleCalendarEventsScript(i + 1, fromMs, toMs, eventLimit));", "const output = await runAppleScript([", "const output = await runAppleScript([", "const output = await runAppleScript(lines);", "const output = await runAppleScript(["],
  // Reminders connector execution/failure translation (S4).
  "src/host/connectors/native/reminders.ts": ["runAppleScript,", "} from './osascript';", "const output = await runAppleScript([", "const output = await runAppleScript(lines);", "const output = await runAppleScript([", "const output = await runAppleScript(lines);", "const output = await runAppleScript(lines);", "const output = await runAppleScript(["],
  // Shared existing AppleScript subprocess executor (S4).
  "src/host/connectors/native/osascript.ts": ["// TCC 拒绝 Apple Events 自动化时 osascript 以 errno -1743 退出（典型文案", "* 把 osascript 异常转成一句给用户/模型看的人话。execFile 的 error.message 以", "* \"Command failed: osascript -e <整段脚本>\" 开头，绝不能原样外露；这里只按错误码/信号分类，", "* 是否为 osascript/execFile 失败（而非连接器自己 throw 的参数/平台校验错误）。", "/** 写 host 日志用的排查详情：stderr 优先；否则去掉开头的 \"Command failed: osascript …\" 命令行，截断 300 字。 */", "// 脚本以多个 -e 参数内联，命令行之后的最后几行是 osascript 的 stderr（取末 3 行，避开脚本正文）", "export async function runAppleScript(lines: string[]): Promise<string> {", "const { stdout } = await execFileAsync('osascript', args, {"],
  // Mail connector execution/failure translation (S4).
  "src/host/connectors/native/mail.ts": ["runAppleScript,", "} from './osascript';", "return await runAppleScript(lines);", "const output = await runAppleScript([", "const output = await runAppleScript(lines);", "const output = await runAppleScript(lines);", "const output = await runAppleScript(lines);", "const output = await runAppleScript(lines);", "await runAppleScript(["],
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

it('static-contract: diagnosis contains no prompting calls or grant imports', () => {
  const violations: string[] = [];
  for (const file of files('src/host')) {
    const path = relative('.', file).replaceAll('\\', '/');
    if (path === grant) continue;
    const source = readFileSync(file, 'utf8');
    if (/AEDeterminePermissionToAutomateTarget\([^;]*,\s*true\s*\)/.test(source)) violations.push(path);
    if (path !== 'src/host/ipc/envAssist.ipc.ts' && /from\s*['"][^'"]*grants\//.test(source)) violations.push(path);
    if (path.startsWith(probes)) {
      // Required bridge declarations describe both native interfaces. They execute
      // nothing; all imports and all executable statements are scanned unchanged.
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const executable = ast.statements.filter((node) => !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node))
        .map((node) => node.getFullText(ast)).join('\n');
      if (forbidden.test(executable) || /PromptingBridge|grants\//.test(executable)) violations.push(path);
    } else {
      const remaining = [...(legacyLines[path] ?? [])];
      for (const line of source.split('\n')) {
        if (!forbidden.test(line) && !/PromptingBridge/.test(line)) continue;
        const index = remaining.indexOf(line.trim());
        if (index < 0) violations.push(`${path}: ${line.trim()}`);
        else remaining.splice(index, 1);
      }
    }
  }
  expect(violations, 'prompting symbols outside the grant boundary').toEqual([]);
});
