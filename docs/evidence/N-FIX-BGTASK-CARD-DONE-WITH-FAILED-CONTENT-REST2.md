# N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST2 — 用户拒绝 Bash 的后台任务不再落成「已完成」

代码提交：`abb666dcc`（`src/host/task/taskDeliveryVerdict.ts` + `tests/unit/task/taskManagerDeliveryVerdict.test.ts`）。同模式调用方只有 `TaskManager.ts:391` 一处（见「同类位置」）。

## 改动
`getTaskDeliveryFailure` 现在也看 `permissionLevel === 'execute'` 的工具，但只记「用户拒绝」（`hostReason.code === PermissionDeniedByUser`）。普通 execute 失败（非零退出、超时、其他 hostReason）不改变任何东西；写工具逻辑原样。有「被用户拒绝」且没有任何成功的 write/execute 结果且 `deliverableArtifactCount === 0` → `'user_denied'` → `task_cancelled`（"你拒绝了这一步，任务已停止。"）。

取舍（无人值守，自行决定）：① 任何后来成功的 write/execute 调用都会把任务救回 completed（按任务书「later succeeded in a write/execute call」）——这意味着只读的 `ls -l` 也算 execute 成功（见②(b) 真跑，这是个已知局限，没有扩范围）；② 真跑用 `neo-realrun.mjs`，拒绝由我写的小脚本 `~/work/out/N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST2/decline.mjs` 监听 `/api/events` 的 `permission_request` 并 POST `/api/agent/permission-response [id,'deny',sessionId]`（等同用户点「拒绝」），模型 xiaomi / neohorse-1.5-flash-preview。

## ① 后台任务中，用户拒绝 Bash（permissionLevel=execute）这类非写工具，且任务没有可交付产物时，任务落成失败/已取消，结果卡不出现「已完成」。复现：后台任务执行 chmod 600 notes.txt，用户点拒绝
真跑 prompt：「后台执行一下：把 notes.txt 改成只有我自己能读写，直接改就行，不用先检查，改完告诉我。」，会话 `web-session-21b87d0e-9d31-42b4-bd8e-f9360846eb95`（realrun/db-4.json）。

拒绝动作（decline.log 原样，第二行即本会话）：
```
{"t":1795010228718,"requestId":"perm-9959f4e6-bac0-4b1a-8cf6-da16b64a9c87","tool":"Bash","response":"deny","status":200,"reply":{"success":true,"data":{"requestId":"perm-9959f4e6-bac0-4b1a-8cf6-da16b64a9c87","sessionId":"web-session-929a3a5a-c0dd-42e1-8442-a0d085d4782b","source":"task-manager"}},"summary":"Execute shell command"
{"t":1795010333954,"requestId":"perm-95b5e565-cbc2-4754-8dcd-15801768c249","tool":"Bash","response":"deny","status":200,"reply":{"success":true,"data":{"requestId":"perm-95b5e565-cbc2-4754-8dcd-15801768c249","sessionId":"web-session-21b87d0e-9d31-42b4-bd8e-f9360846eb95","source":"task-manager"}},"summary":"Execute shell command"
```
工具结果行（messages.tool_results，含 hostReason）：
```
[{"toolCallId":"call_6cd2516a080848f989a4ce8b","success":false,"error":"Permission denied by user. The user just declined this kind of action. ...","duration":50,"metadata":{"failureCode":"permission-denied","hostReason":{"code":"PERMISSION_DENIED_BY_USER","m...
```
结果行（messages 表，system）：
```
[任务结果] 权限｜已取消｜你拒绝了这一步，任务已停止。
metadata: {"backgroundTaskResult":{"source":"agent-result","taskId":"session-work-1795010330639-qli46m","shortName":"权限","status":"cancelled","summary":"你拒绝了这一步，任务已停止。"}}
```
对照（修复前源码 25edf5fae，同 prompt，真跑 prerun/db-*.json，会话 web-session-05cf5d77…）：
```
[任务结果] 权限｜已完成｜改权限的操作被拒绝，未执行。
```
单测（经 `TaskManager` 后台运行入口）：`ends a user-denied Bash (execute) as task_cancelled and drops the model chmod prose` ✓；`projects a user-denied background task as a cancelled [任务结果] row, zh and en`（已改用 Bash）✓ — zh「已取消」/ en「cancelled」。

## ② 正常完成的后台任务、以及中途拒绝了一次但后来成功交付的任务，仍显示已完成（反向用例）
(a) 普通成功任务（真跑，无拒绝；会话 web-session-d8a62cfe… 之后的 006f77）：
```
[任务结果] 纪要｜已完成｜已完成。三条待办要点已整理并写入： `…/neo/workspace/summary.md` 内容（回读校验通过，标题 + 三条列表）： 1. **周五发布 v2** — … 2. **修复登录问题** — … 3. **联系供应商对账单** — …
```
(b) 拒绝过一次、之后有成功的 execute 调用（真跑，realrun/db-2.json 会话 web-session-929a3a5a…；拒绝记录为 decline.log 第一行；之后 `ls -l notes.txt` 成功）：
```
[任务结果] chmo｜已完成｜改权限的操作（chmod 600 notes.txt）被拒绝、未执行；本轮只完成了只读检查，notes.txt 当前权限仍为 -rw-r--r--（644）。
```
**发现（局限，未扩范围）**：这条按规则保持已完成，但 chmod 实际没做——只读的 `ls -l` 算「成功 execute」把任务救回了。要不要把「只读 execute」排除在救回条件之外是产品取舍，留给后续。
单测：`keeps a denied Bash completed when a later Bash succeeded` ✓、`keeps a denied Bash completed when a deliverable artifact exists` ✓、`keeps a denied write completed when another write succeeded`（原有）✓、`keeps a successful write completed with its artifact`（原有）✓。

## ③ 用 web 构建在无头浏览器中截图，各给一组修前修后对比：一组是「结论写失败」的任务（对应 #3672），一组是「用户拒绝 Bash」的任务。证据存入 docs/evidence/
四张图都来自真跑（不是种子数据）：修前 = 对应修前源码的 worktree（#3672 之前 `93ae77657`；本单之前 `25edf5fae`）起的隔离服务，修后 = 本分支源码；同一份已构建的 renderer、headless Chromium 1440x900，截图前断言页面有目标字样（脚本输出行）。
- `docs/evidence/N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST2/a-before.png`：#3672 修前，结论以「任务未完成：」开头，卡片绿点「已完成」+ 底栏「1 个代理 · 完成」。断言：`ASSERT session=web-session-147b3dda… text="已完成" visible=true`
- `docs/evidence/N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST2/a-after.png`：修后，红色失败卡「没有完成」+ 底栏「1 个代理 · 失败」。断言：`ASSERT session=web-session-3df64486… text="没有完成" visible=true`
- `docs/evidence/N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST2/b-before.png`：本单修前，拒绝 Bash 后卡片「已完成」+ 底栏「1 个代理 · 完成」。断言：`ASSERT session=web-session-05cf5d77… text="已完成" visible=true`
- `docs/evidence/N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST2/b-after.png`：修后，卡片「已取消」。断言：`ASSERT session=web-session-21b87d0e… text="已取消" visible=true`
说明：走的是 WEB-SHOT-RECIPE（隔离服务 + Playwright），没走 verify-slotless（凭据文件在本机不可用）。早先一次试拍因脚本误点了卡片上的「重试」而多出一轮对话，已丢弃重拍。自己种子行的尝试（改库造「修复前」行）因会话打不开/卡片取状态来源不是消息行，已放弃，不作证据。

## ④ 反向变异：分别还原 taskDeliveryVerdict 的权限级别判断和 opensWithUnfinished 的判断，对应测试必须变红
(i) 备份 → 把 `if (!isWrite && permissionLevel !== 'execute') continue;` 改回 `if (!isWrite) continue;`：
```
 RUN  v4.1.7 /Users/leo/work/wt/N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST2
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  tests/unit/task/taskManagerDeliveryVerdict.test.ts > TaskManager background delivery verdict > ends a user-denied Bash (execute) as task_cancelled and drops the model chmod prose
AssertionError: expected 'task_completed' to be 'task_cancelled' // Object.is equality
 FAIL  tests/unit/task/taskManagerDeliveryVerdict.test.ts > TaskManager background delivery verdict > projects a user-denied background task as a cancelled [任务结果] row, zh and en
AssertionError: expected 'completed' to be 'cancelled' // Object.is equality
      Tests  2 failed | 15 passed (17)
```
(ii) 备份 → `if (opensWithUnfinished(detail))` 改成 `if (false)`（节选，共 12 红）：
```
 RUN  v4.1.7 /Users/leo/work/wt/N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST2
⎯⎯⎯⎯⎯⎯ Failed Tests 12 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  tests/unit/services/commandCenter/sessionTaskStopConclusion.test.ts > notice keeps only the first conclusion line, plain text; detail keeps the full cleaned text
AssertionError: expected undefined to be '这个后台任务没有完成你交代的事，下面是它留下的说明：结论：抓取失败，没有拿…' // Object.is equality
 FAIL  tests/unit/services/commandCenter/sessionTaskStopConclusion.test.ts > resolveStoppedTaskOutcome unfinished-opener conclusion > failure prose with completed status becomes failed: 执行失败�
 FAIL  tests/unit/services/commandCenter/sessionTaskStopConclusion.test.ts > resolveStoppedTaskOutcome unfinished-opener conclusion > failure prose with completed status becomes failed: 未能完成�
 FAIL  tests/unit/services/commandCenter/sessionTaskStopConclusion.test.ts > resolveStoppedTaskOutcome unfinished-opener conclusion > failure prose with completed status becomes failed: 无法打开�
 FAIL  tests/unit/services/commandCenter/sessionTaskStopConclusion.test.ts > resolveStoppedTaskOutcome unfinished-opener conclusion > failure prose with completed status becomes failed: 结论：任�
 FAIL  tests/unit/services/commandCenter/sessionTaskStopConclusion.test.ts > resolveStoppedTaskOutcome unfinished-opener conclusion > failure prose with completed status becomes failed: - **任务失�
 FAIL  tests/unit/services/commandCenter/sessionTaskStopConclusion.test.ts > resolveStoppedTaskOutcome unfinished-opener conclusion > failure prose with completed status becomes failed: Unable to open
 FAIL  tests/unit/services/commandCenter/sessionTaskStopConclusion.test.ts > resolveStoppedTaskOutcome unfinished-opener conclusion > failure prose with completed status becomes failed: Failed to fetc
 FAIL  tests/unit/services/commandCenter/sessionTaskStopConclusion.test.ts > resolveStoppedTaskOutcome unfinished-opener conclusion > failure prose with completed status becomes failed: 抓取失败�
      Tests  12 failed | 11 passed (23)
```
两处均从备份文件还原（不是 git checkout），还原后：`npx vitest run tests/unit/task tests/unit/services/commandCenter` → Test Files 24 passed (24)，Tests 208 passed (208)。

## ⑤ Non-denied execute failure and read-only research remain unchanged
```
✓ keeps a Bash failure that is not a user denial completed   （PermissionDeniedSafetyRule 与无 hostReason 两种都→task_completed）
✓ keeps a Read-only research task completed
✓ keeps a tool-error write failed even when the host reason is not a user denial   （原有）
✓ keeps an approval timeout failed as approval_timeout   （原有）
```
整个文件 17/17 通过（verbose 输出见 ~/work/out/N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST2/verbose.txt）。

## ⑥ Copy check from the real run
卡片/结果行上能看到的字符串（来自 b-after / b-before / a-after / a-before 截图与 DB 行）：
- b-after：「把 notes.txt 权限改成仅本人可读写（600）」「已取消」「做了 1 步」；底栏「1 个代理 · 已取消 · …」；结果行「[任务结果] 权限｜已取消｜你拒绝了这一步，任务已停止。」
- b-before：「已完成」「1 个代理 · 完成」；model 文字「这一步需要在确认卡片上点允许才能执行…」
- a-after：「没有完成」「做了 1 步」「查看详情」「重试」；红字「这个后台任务没有完成你交代的事，下面是它留下的说明： 任务未完成：工作目录 /Users/leo/work/out/…/fixrun/neo/workspace 里不存在 report-2025.csv…」
- a-before：「已完成」「1 个代理 · 完成」
UI naming defects:
- 内部路径外露：a-after 红卡正文、卡下方「「月汇总」： …」行与 `[任务结果]` 行里出现绝对路径 `/Users/leo/work/out/…/fixrun/neo/workspace`（模型结论原文，卡片未脱敏）。证据 a-after.png。
- 英文内部指令外露在 DB：被拒工具结果的 error 为英文模型指令「Permission denied by user. The user just declined this kind of action. …」（给模型看的，界面未显示，仅记录）。
- 任务简称被截成两个字：首个真跑的结果行 `[任务结果] chmo｜已完成｜…`（shortName 「chmo」，delegate_task 的 short_name 被截断；DB 行 db-2.json）。
- 助手文字里出现「再让我试一次」可点链接和「确认卡片上点允许」这种操作指引——合理，不记缺陷。
无原始命令外露（卡片只显示任务标题，没有 `chmod …` 命令文本；progress.bashSteps 里有命令但界面没显示）。

## ⑦ Expected gain: 用户拒绝了后台任务的操作后，卡上不再显示「已完成」，看卡就知道任务成没成
用户路径：用平常话要后台任务改权限（上面 prompt）→ 审批卡出现 → 点「拒绝」（脚本 POST deny，等价）→ 结果卡/行。
- 修前（真跑 25edf5fae）：`[任务结果] 权限｜已完成｜改权限的操作被拒绝，未执行。` + b-before.png 绿点「已完成」。
- 修后（真跑本分支）：`[任务结果] 权限｜已取消｜你拒绝了这一步，任务已停止。` + b-after.png「已取消」。

## 同类位置
grep：`grep -rn "permissionLevel === 'write'\|getTaskDeliveryFailure\|PermissionDeniedByUser" src`
- `src/host/task/TaskManager.ts:391` 唯一调用 `getTaskDeliveryFailure` → 已覆盖（修在 `taskDeliveryVerdict.ts` 这一共同层，TaskManager 未改）。
- `src/renderer/utils/toolExecutionPresentation.ts:376`、`toolPreflightPresentation.ts:34`、`i18n/agentError.ts` 只是工具行文案，不决定任务终态 → 无需覆盖。
- `toolExecutor.ts / writeIsolation.ts / connectorTokenWrite.ts` 的 `permissionLevel === 'write'` 是权限/隔离判断，与交付终态无关 → 未覆盖（不同问题）。
- 未覆盖：「抓取已实际发起，失败了…」这类不在 UNFINISHED_OPENERS 里的开头仍判已完成（任务书明确不在范围，产品取舍）；非拒绝的 execute 失败不进失败路径（任务书明确不在范围）；cancel 的红色 backgroundTaskStopped 块、文案均未动。

## 本地检查
```
npx eslint src/host/task/taskDeliveryVerdict.ts tests/unit/task/taskManagerDeliveryVerdict.test.ts → 无输出（ESLINT_OK）
npm run -s typecheck → 通过（TYPECHECK_OK，只跑 1 次）
[host-chinese-error-ratchet] 中文 error 字面量 current=150 baseline=150 ✓ 等于基线，通过（未新增）
[attention-budget-ratchet] 实时语音条件路径 current=103 baseline=103 tolerance=±10% ✓
npx vitest run tests/unit/task tests/unit/services/commandCenter → Test Files 24 passed (24) / Tests 208 passed (208)，0 failed 0 skipped
```
证据档位：hermetic-protocol（经 TaskManager 的单测）+ real-runtime（真跑 xiaomi 模型 + 隔离 webServer + headless 截图）+ 反向变异两处。未跑全仓套件（按派单规则只跑受影响目录）。
清理：隔离服务全部 stop、两个修前 worktree 已 remove、decline 监听脚本已 kill；机器上其它 Chrome/headless 进程（含 N-E2E-CORE-FLOWS-SUITE-PATHS-REST 的服务）不是本单起的，未动。

## 验收自查
- [x] ①后台任务中，用户拒绝 Bash：见「①」真跑行+单测
- [x] ②正常完成…仍显示已完成：见「②」(a)(b) 两条真跑行+单测
- [x] ③用 web 构建在无头浏览器中截图：见「③」四张 png
- [x] ④反向变异：见「④」原始红线+还原后绿
- [x] ⑤Non-denied execute failure and read-only research：见「⑤」
- [x] ⑥Copy check：见「⑥」含 UI naming defects
- [x] ⑦Expected gain：见「⑦」真跑原始行+截图
