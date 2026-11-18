# 核心用户路径地图（E2E Feature Map）

> 用途：改了主路径的 PR / 工人，拿这一页对照「哪些路径绝不能坏、怎么走、该看到什么」。
> 只列**必须能用**的路径，不是现有自动化的清单。选择依据：近期 main 上审批 / 日历 / 后台任务 / 浏览器类修复最密集。
> 静态守护：`tests/unit/docs/featureMap.static.test.ts` 保证文中引用的 `data-testid` 真实存在、卡片字段齐全、流程数 15-20。
> 证据档位词汇见 [`docs/testing-evidence-classes.md`](../testing-evidence-classes.md)。
> 范围：本页只是地图；夜间跑批命令和结果文件由上级单负责，不在这里。

约定：`surface: web` = Web 构建（`tests/e2e/playwright.e2e.config.ts` + `/api/dev/emit-agent-events`）即可真跑；`surface: shell` = 依赖 Tauri 壳 / 原生能力，Web 构建跑不了真的，只能靠封闭协议测试或真机批。
可观测量里的表在本地库 `code-agent.db`（隔离真跑时在 `<out>/neo/home/.code-agent/`，`neo-realrun.mjs dump` 导出为 `db-N.json`）。

## 索引

| ID | 用户的话 | surface | 现有自动化 | 证据档位 |
|----|---------|---------|-----------|---------|
| F01 | 「明天下午三点帮我约个评审会」 | shell | none（审批卡形状见 approval-command-card.spec.ts） | hermetic-protocol；真机批 |
| F02 | 「把评审会改到四点」 | shell | none | 真机批 |
| F03 | 「把明天的评审会删了」→ 点撤销 | shell | none（撤销组件有单测） | hermetic-protocol；真机批 |
| F04 | 「我这周日程怎么样」 | shell | none | 真机批 |
| F05 | 审批卡：允许一次 | web | tests/e2e/approval-command-card.spec.ts | hermetic-protocol；real-runtime（本单真跑） |
| F06 | 审批卡：拒绝 | web | tests/e2e/approval-command-card.spec.ts（只验卡片渲染） | hermetic-protocol |
| F07 | 审批卡：本次任务内允许 | web | none | 暂无（尚无真跑样本） |
| F08 | 「放后台去做，做完告诉我」 | web | tests/e2e/task-panel-session-tasks.spec.ts | real-runtime（本单真跑） |
| F09 | 跑到一半点停止 | web | tests/e2e/run-lifecycle-stability.spec.ts | hermetic-protocol |
| F10 | 丢一个 xlsx / PDF / 图片让它分析 | web | none | real-runtime（本单真跑） |
| F11 | 「打开这个网页告诉我讲了什么」 | shell | none | 真机批 |
| F12 | 网站要登录，我接手登录后让它继续 | shell | none | 真机批 |
| F13 | 开会时录音，会后看纪要 | shell | none | 真机批 |
| F14 | 「记住我的周报格式」→ 新会话里用上 | web | none | real-runtime（本单真跑，确认由脚本代答） |
| F15 | 「每周一早上 9 点帮我整理周报」 | web | tests/e2e/cronEditorFooterVisible.spec.ts（只验编辑器布局） | hermetic-protocol |
| F16 | 重新打开一个很长的旧会话 | web | tests/e2e/chat-return-blank-log.spec.ts | hermetic-protocol |
| F17 | 界面语言中英切换 | web | tests/e2e/settings-ia-folding.spec.ts（只覆盖设置布局） | hermetic-protocol |
| F18 | 第一次打开，配好模型开始聊 | web | tests/e2e/app.spec.ts | hermetic-protocol |

## 流程卡

### F01 — 新建日程（自然语言 + 写入审批）
- **Preconditions**: surface shell；已授权系统日历；已配置模型；新会话。
- **Steps**: 1. 在输入框说「明天下午三点帮我约个评审会」并发送。2. 出现审批卡，核对时间 / 标题。3. 点「创建」。
- **Selectors**: `testid:chat-composer-textarea` @ `src/renderer/components/features/chat/ChatInput/InputArea.tsx`；`testid:permission-card` @ `src/renderer/components/PermissionDialog/PermissionCard.tsx`；按钮文案「创建」「取消」见 `src/renderer/i18n/decisionCard.ts`（`optionCreateItem` / `optionDenyCreate`）。
- **Expected UI**: 审批卡标题是日程语义（不是「执行工具」），点「创建」后卡片收起，回复里说明已创建及时间。
- **Observable**: `tool_execution_events` 有 `tool_name='calendar_create_event'` 的 `begin` + `complete`(status success)；`permission_decisions` 对应行 `final_outcome='allow'`。
- **Failure looks like**: 审批卡不出现直接写入；卡片空壳 / 只显示工具名；时间差几小时（时区）；点创建后日历里没有事件。
- **Proof**: 原生 EventKit 只在壳里，Web 构建跑不了；靠 hermetic 审批卡形状测试 + 真机批。

### F02 — 修改日程
- **Preconditions**: surface shell；日历里已有 F01 创建的事件。
- **Steps**: 1. 说「把评审会改到四点」。2. 审批卡点「更新」。
- **Selectors**: `testid:permission-card` @ `src/renderer/components/PermissionDialog/PermissionCard.tsx`；按钮文案见 `src/renderer/i18n/decisionCard.ts`（`optionUpdate`）。
- **Expected UI**: 卡片展示改前 / 改后时间；确认后回复写明新时间。
- **Observable**: `tool_execution_events.tool_name='calendar_update_event'` complete success；日历事件开始时间 = 16:00。
- **Failure looks like**: 改成了新增一条（出现两条评审会）；改错了事件；没经审批就改。
- **Proof**: 真机批（EventKit）。

### F03 — 删除日程并撤销
- **Preconditions**: surface shell；日历里有一个事件。
- **Steps**: 1. 说「把明天的评审会删了」。2. 审批卡点「删除」。3. 回复里出现「撤销」按钮，点它。
- **Selectors**: `testid:calendar-delete-undo` @ `src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/CalendarDeleteUndo.tsx`；`testid:calendar-delete-undone` @ `src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/CalendarDeleteUndo.tsx`；`testid:calendar-delete-undo-failed` @ `src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/CalendarDeleteUndo.tsx`。
- **Expected UI**: 删除后出现撤销入口；点后变为已撤销状态；日历里事件回来。
- **Observable**: `tool_execution_events.tool_name='calendar_delete_event'` success；撤销后事件重新存在（真机），`calendar-delete-undo-failed` 不应出现。
- **Failure looks like**: 没有撤销入口；点撤销报失败；撤销后事件内容丢字段（地点 / 备注）。
- **Proof**: 撤销组件单测（hermetic）+ 真机批。

### F04 — 查看日程
- **Preconditions**: surface shell；已授权日历；本周有若干事件。
- **Steps**: 1. 说「我这周日程怎么样」。
- **Selectors**: `testid:chat-composer-textarea` @ `src/renderer/components/features/chat/ChatInput/InputArea.tsx`；`testid:turn-run-header` @ `src/renderer/components/features/chat/TurnCard.tsx`。
- **Expected UI**: 不弹审批（只读）；回复按天列出事件，数量与系统日历一致。
- **Observable**: `tool_execution_events.tool_name='calendar'` complete success；无对应 `permission_decisions` 的 deny。
- **Failure looks like**: 读日历也弹写入审批；漏事件；回复里出现英文内部状态词。
- **Proof**: 真机批。

### F05 — 审批卡：允许一次
- **Preconditions**: surface web；任一需审批的操作（shell 命令、写全局文件）；新会话。
- **Steps**: 1. 让 Neo 执行一个需审批的命令。2. 审批卡出现，核对命令正文只出现一次。3. 点「允许一次」。
- **Selectors**: `testid:permission-card` @ `src/renderer/components/PermissionDialog/PermissionCard.tsx`；`testid:permission-args-preview` @ `src/renderer/components/PermissionDialog/PermissionCard.tsx`；按钮文案「允许一次」见 `src/renderer/i18n/decisionCard.ts`（`optionOnce`）。
- **Expected UI**: 点后卡片消失，该工具继续执行，回合正常收尾。
- **Observable**: `permission_decisions` 新增行 `final_outcome='allow'`、`history_outcome='ask-approved'`、`reason='user'`；随后 `tool_execution_events` 同工具 complete success。
- **Failure looks like**: 点了没反应卡片还在；工具没继续跑；同一命令再问第二次。
- **Proof**: 本单真跑：`realrun2/db-4.json` 里 `ExcelAutomate` / `Bash` 为 `allow | ask-approved | user`。

### F06 — 审批卡：拒绝
- **Preconditions**: 同 F05。
- **Steps**: 1. 触发审批卡。2. 点「拒绝」。
- **Selectors**: `testid:permission-card` @ `src/renderer/components/PermissionDialog/PermissionCard.tsx`；按钮文案「拒绝」见 `src/renderer/i18n/decisionCard.ts`（`optionDeny`）。
- **Expected UI**: 卡片收起；回复说明没有执行，且不是报「失败」；不再重试同一动作。
- **Observable**: `permission_decisions` 行 `final_outcome='deny'`；无该工具的 `complete success` 事件。
- **Failure looks like**: 拒绝后仍然执行；回复把拒绝说成「出错了」；任务被记为失败。
- **Proof**: 无人点击（超时）时同样走拒绝：本单真跑 `realrun/db-4.json` 里 `deny | ask-denied | timeout`（等待 60 秒）。

### F07 — 审批卡：本次任务内允许
- **Preconditions**: 同 F05，且任务会连续多次调用同类工具。
- **Steps**: 1. 触发审批卡。2. 点「本次任务内允许」。3. 任务继续，后续同类操作不再弹卡。
- **Selectors**: `testid:permission-card` @ `src/renderer/components/PermissionDialog/PermissionCard.tsx`；按钮文案「本次任务内允许」见 `src/renderer/i18n/decisionCard.ts`（`optionRun`）。
- **Expected UI**: 之后同会话同类操作直接执行；换新会话仍会再问。
- **Observable**: `permission_decisions` 首行 `ask-approved`，后续同工具行 `history_outcome='auto-approve'`（授权记忆命中）。
- **Failure looks like**: 每步都重新弹卡；授权泄漏到别的会话。
- **Proof**: 尚无真跑样本（本单用 auto-approve 直接放行，只覆盖 F05）。

### F08 — 转后台并收到完成通知
- **Preconditions**: surface web；已配置模型。
- **Steps**: 1. 说「把这三个页面整理成周报，放后台去做，做完告诉我」。2. 看到「后台任务」面板出现任务。3. 任务完成后回到会话看结果。
- **Selectors**: `testid:background-handoff-button` @ `src/renderer/components/features/chat/ChatInput/BackgroundHandoffButton.tsx`（运行中点「转后台继续聊」）；`testid:background-session-panel` @ `src/renderer/components/features/background/BackgroundSessionPanel.tsx`；`testid:background-session-item` @ `src/renderer/components/features/background/BackgroundSessionPanel.tsx`；`testid:background-session-stop` @ `src/renderer/components/features/background/BackgroundSessionPanel.tsx`。
- **Expected UI**: 先回复「已交给后台」，面板里出现带短名的任务；完成后会话里出现交付结果，面板条目变为已完成。
- **Observable**: `tool_execution_events.tool_name='delegate_task'` complete success，输出含「后台任务「…」已开始，尚未完成；完成后会在这里告诉你结果。」；会话 `status='completed'`。
- **Failure looks like**: 任务完成了没人通知；面板里一直「运行中」；重启后任务凭空消失；审批卡在后台没人看到导致 60 秒后静默超时。
- **Proof**: 本单真跑：模型自行走 `delegate_task`（`realrun2/db-4.json` 有 `"tool_name": "delegate_task"`）。手动点 `background-handoff-button` 的路径真跑脚本驱动不了，靠 Playwright / 真机批。

### F09 — 停止正在运行的回合
- **Preconditions**: surface web；发送一个会跑较久的任务。
- **Steps**: 1. 发送长任务。2. 输入框右侧发送键变成停止键，点它。
- **Selectors**: `testid:composer-stop-button` @ `src/renderer/components/features/chat/ChatInput/SendButton.tsx`；`testid:composer-stop-stopping` @ `src/renderer/components/features/chat/ChatInput/SendButton.tsx`；`testid:chat-composer-textarea` @ `src/renderer/components/features/chat/ChatInput/InputArea.tsx`。
- **Expected UI**: 点后进入「停止中」，随后回合以「已停止」收尾，输入框恢复可发送，已有输出保留。
- **Observable**: 事件流出现回合终止事件（非 error）；会话可立即再发一条并正常回复。
- **Failure looks like**: 停止键点了没反应；一直停在「停止中」；停止后下一条消息被吞。
- **Proof**: run-lifecycle 类 Playwright 用例（hermetic）。

### F10 — 附件分析（xlsx / PDF / 图片）
- **Preconditions**: surface web；工作目录里有 `q1-sales.xlsx`（或拖入附件）。
- **Steps**: 1. 说「帮我看一下 q1-sales.xlsx，哪个区域哪个月卖得最好」。2. 遇到读文件审批点允许。3. 读回复。
- **Selectors**: `testid:composer-upload-status` @ `src/renderer/components/features/chat/ChatInput/ComposerUploadStatus.tsx`；`testid:chat-composer-textarea` @ `src/renderer/components/features/chat/ChatInput/InputArea.tsx`；附件入口是 `src/renderer/components/features/chat/ChatInput/InputAddMenu.tsx` 里的隐藏文件框（无 testid，用 `input[type=file]`）。
- **Expected UI**: 回复给出「华东区 3 月、150,000 元」这类具体结论，并带季度小结；数字与表一致。
- **Observable**: `tool_execution_events` 里 `Glob` → `delegate_task` →（后台）`ExcelAutomate` / `Bash`；`permission_decisions` 为 `ask-approved`。
- **Failure looks like**: 编造数字；说读不了文件；审批卡无人看见导致超时、回复变成「审批请求超时了，重新发起」。
- **Proof**: 本单真跑：`realrun2/db-4.json` 最终回复含「华东区 3 月卖得最好，150,000 元」，合计 405,000 / 663,000 与表一致。

### F11 — 浏览器读网页
- **Preconditions**: surface shell；托管浏览器可用。
- **Steps**: 1. 说「打开 https://example.com 告诉我讲了什么」。2. 看工作台里的浏览器窗口。
- **Selectors**: `testid:browser-agent-window-stage` @ `src/renderer/components/workbench/BrowserAgentWindow.tsx`；`testid:browser-agent-window-address-input` @ `src/renderer/components/workbench/BrowserAgentWindow.tsx`；`testid:browser-surface-content` @ `src/renderer/components/features/browser/BrowserSurfaceContent.tsx`。
- **Expected UI**: 浏览器窗口显示该页，地址栏地址一致；回复概括页面内容。
- **Observable**: `tool_execution_events.tool_name` 为 `browser_navigate` 或 `browser_action`，complete success。
- **Failure looks like**: 用户说「打开网页」被当成 shell `open` 命令；窗口空白；回复编造内容。
- **Proof**: 真机批（托管浏览器是壳能力）。

### F12 — 浏览器人工接管（登录）
- **Preconditions**: surface shell；目标站点需要登录。
- **Steps**: 1. 让 Neo 访问需登录站点。2. 出现接管提示条，用户在窗口里登录。3. 点「继续」。
- **Selectors**: `testid:browser-human-takeover-bar` @ `src/renderer/components/workbench/BrowserHumanTakeoverBar.tsx`；`testid:browser-human-takeover-continue` @ `src/renderer/components/workbench/BrowserHumanTakeoverBar.tsx`；`testid:browser-takeover-park-continue` @ `src/renderer/components/features/surfaceExecution/BrowserTakeoverParkCard.tsx`。
- **Expected UI**: 提示条出现并说明要用户做什么；点继续后任务接着往下跑，不重新登录。
- **Observable**: 接管前后 `tool_execution_events` 属同一回合；继续后出现新的 `browser_action` success。
- **Failure looks like**: 提示条不出现，任务卡死；点继续后丢失登录态；把密码让用户贴进聊天。
- **Proof**: 真机批。

### F13 — 会议记录
- **Preconditions**: surface shell；麦克风 / 系统音频授权。
- **Steps**: 1. 在输入区「+」菜单开始会议记录。2. 说几句话后结束。3. 打开会议页看纪要。
- **Selectors**: `testid:input-add-meeting` @ `src/renderer/components/features/chat/ChatInput/InputAddMenu.tsx`；`testid:meeting-bar` @ `src/renderer/components/features/chat/ChatInput/MeetingBar.tsx`；`testid:meeting-page` @ `src/renderer/components/features/meetings/MeetingPage.tsx`；`testid:meeting-minutes` @ `src/renderer/components/features/meetings/MeetingPage.tsx`。
- **Expected UI**: 录制中有会议条；结束后会议页有转写和纪要，可「交给 Neo」继续处理。
- **Observable**: 会议记录落库，`meeting_records` 工具可查到；纪要状态不停在「生成中」。
- **Failure looks like**: 录音没有声音；纪要空白或一直生成中；结束后会议条残留。
- **Proof**: 真机批（音频采集是壳能力）。

### F14 — 记忆写入并在新会话召回
- **Preconditions**: surface web；记忆开启（默认自动）。
- **Steps**: 1. 说「记住：周报用本周进展 / 风险 / 下周计划三段式，数字用万」。2. 出现一个弹窗「确认用户规则」（不是审批卡），点「确认保存规则」；2 分钟内不点会自动关闭、本次不写入。点了就直接写入，不会再出现「写入项目目录外」审批卡。3. 新开一个会话说「帮我起草这周周报」。
- **Selectors**: 确认弹窗是 `src/renderer/components/features/memory/MemoryConfirmModal.tsx`，**没有 data-testid**，用可见文字定位：标题「确认用户规则」、按钮「确认保存规则」（文案在 `src/renderer/i18n/zh.ts` 的 `memory.confirmDirectiveTitle` / `confirmDirectiveSave`）；超时常量 `MEMORY_TIMEOUTS.DIRECTIVE_CONFIRM` = 120000 毫秒（`src/shared/constants/timeouts.ts`）；`testid:sidebar-new-task` @ `src/renderer/components/features/sidebar/SidebarNewTaskRow.tsx`；`testid:memory-settings-tab` @ `src/renderer/components/features/settings/tabs/MemoryTab.tsx`；`testid:memory-entry-row` @ `src/renderer/components/features/settings/tabs/MemoryEntriesManager.tsx`。
- **Expected UI**: 第一轮明确说「已记住」；设置里记忆列表多一条；第二个会话的草稿直接用三段式。
- **Observable**: 成功：`<home>/.code-agent/memory/` 下出现新的 .md 文件，`Write` 的 `tool_execution_events` 为 complete success；`permission_decisions` **没有** `W3: outside_project` 行，该次写入的 trace 规则为 `directive_memory_write_confirmed`（确认弹窗的授权只豁免弹窗里确认过的那几个记忆文件；写别的项目外目录仍走 `W3: outside_project` 审批卡）；`approvals.jsonl` 对该次写入为空；第二个会话的工具事件里有对该文件的 `Read`。失败（弹窗没点或超时）：`Write` 工具结果带错误码 `DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED`，文案含「确认窗口等了 2 分钟没有等到响应，已自动关闭，这次没有写入」，目录里没有新文件，也没有审批卡。
- **Failure looks like**: 说「记住了」但没落盘；每次新会话都忘；写入被拦了却不告诉用户；点完「确认保存规则」后又冒出「写入项目目录外」审批卡（回到两次确认）。
- **Proof**: 单测 `tests/unit/tools/toolExecutor.directiveMemoryOneConfirm.test.ts`（走 `ToolExecutor.execute`）：确认后不触发审批回调、trace 含 `directive_memory_write_confirmed`；拒绝/超时不写入且无审批卡；其他项目外目录、`../` 逃逸、指向外部的软链仍弹审批卡。真跑闭环：`neo-realrun.mjs` 在 `/api/events` 收到 `memory:confirm-request` 后向 `/api/memory/confirm-response` 回 `confirmed:true`，之后 `db-*.json` 无 `W3: outside_project`、`approvals.jsonl` 为空。脚本回应不是浏览器真点，标 partial。

### F15 — 定时任务创建并运行
- **Preconditions**: surface web；已配置模型。
- **Steps**: 1. 说「每周一早上 9 点帮我整理周报」或在自动化页新建。2. 确认任务摘要。3. 手动「运行一次」。
- **Selectors**: `testid:cron-simple-create` @ `src/renderer/components/features/cron/CronSimpleCreate.tsx`；`testid:cron-job-detail` @ `src/renderer/components/features/cron/CronJobDetail.tsx`；`testid:cron-job-next-run` @ `src/renderer/components/features/cron/CronJobList.tsx`；`testid:cron-run-status` @ `src/renderer/components/features/chat/CronRunSessionStatusBar.tsx`。
- **Expected UI**: 列表出现任务及人话的执行时间，下次执行时间正确；运行一次后有执行记录和结果。
- **Observable**: `cron_jobs` 新增 `enabled=1` 的行；运行后 `cron_executions` 有该 `job_id` 的行，`status` 终态且 `session_id` 非空。
- **Failure looks like**: 任务建了但下次执行时间为空；到点不跑；执行记录一直 running；原始 cron 表达式暴露给用户。
- **Proof**: 编辑器布局类 Playwright 用例（hermetic）；运行链路尚无真跑样本。

### F16 — 重新打开很长的旧会话
- **Preconditions**: surface web；已有一条几十轮的会话。
- **Steps**: 1. 在侧栏点这条会话。2. 滚动到顶部 / 底部。
- **Selectors**: `testid:sidebar-session-scroll` @ `src/renderer/components/features/sidebar/SidebarSessionList.tsx`；`testid:turn-rail` @ `src/renderer/components/features/chat/TurnRail.tsx`；`testid:session-load-error` @ `src/renderer/components/features/chat/SessionSwitchSkeleton.tsx`。
- **Expected UI**: 会话内容完整出现，不是空白；滚动位置在底部；没有「加载失败」。
- **Observable**: `messages` 表该会话条数与界面轮数一致；`session-load-error` 不出现。
- **Failure looks like**: 打开是空白；只显示最后几条；切回来后输入框内容丢失。
- **Proof**: chat-return-blank-log 类 Playwright 用例（hermetic）。

### F17 — 界面语言中英切换
- **Preconditions**: surface web。
- **Steps**: 1. 设置里找到「界面语言」，选 English。2. 看主界面和输入框占位。3. 切回简体中文。
- **Selectors**: 设置项标题「界面语言」见 `src/renderer/i18n/zh.ts`（`language.title`）；`testid:chat-welcome-title` @ `src/renderer/components/features/chat/NewSessionWelcome.tsx`；`testid:sidebar-new-task` @ `src/renderer/components/features/sidebar/SidebarNewTaskRow.tsx`。
- **Expected UI**: 切换即时生效、不用重启；英文下无残留中文，中文下无残留英文内部状态词。
- **Observable**: `GET /api/settings` 返回 `ui.language` 为 `en` / `zh`；重启后保持。
- **Failure looks like**: 切了一半（侧栏还是中文）；重启后回到旧语言；审批卡按钮仍是另一种语言。
- **Proof**: 审批卡 spec 用 `PUT /api/settings` 切语言（hermetic）；全界面扫描尚无。

### F18 — 首次打开配置模型
- **Preconditions**: surface web；全新数据目录（无已配置模型）。
- **Steps**: 1. 首次打开，出现「初始化 Neo」引导。2. 选订阅或填 API Key。3. 点「继续」进入聊天。
- **Selectors**: `testid:onboarding-welcome` @ `src/renderer/components/onboarding/ModelOnboardingModal.tsx`；`testid:onboarding-model-step` @ `src/renderer/components/onboarding/ModelOnboardingModal.tsx`；`testid:onboarding-continue-to-chat` @ `src/renderer/components/onboarding/ModelOnboardingModal.tsx`；跳过按钮文案见 `src/renderer/i18n/onboarding.ts`（`skipButton`）。
- **Expected UI**: 引导分步可前进，配好后进入聊天并可发第一条消息；跳过不阻塞使用。
- **Observable**: `config.json` 的 `settings.onboarding.completedAt` 有值；第二次启动不再弹引导。
- **Failure looks like**: 引导弹窗盖住界面无法关闭；配好后仍提示「未配置模型」；第一条消息报 401 却不说明原因。
- **Proof**: app.spec.ts（hermetic）；真实 Key 流程需真机批。

## 改动路径 → 要复查的流程

| 改动路径 | 复查流程 |
|----------|---------|
| `src/host/permissions` / `src/host/security` / `src/renderer/components/PermissionDialog` | F01 F02 F03 F05 F06 F07 F14 |
| `src/host/tools/modules/connectors` | F01 F02 F03 F04 |
| `src/host/task` / `src/host/services/commandCenter` / `src/renderer/components/features/background` | F08 F10 F09 |
| `src/host/loop` / `src/host/session` | F08 F09 F16 |
| `src/host/tools/vision` / `src/renderer/components/workbench` / `src/renderer/components/features/browser` | F11 F12 |
| `src/host/memory` / `src/host/lightMemory` / `src/host/tools/modules/lightMemory` / `src/host/services/memory` | F14 F13 |
| `src/host/cron` / `src/host/scheduler` / `src/host/tools/modules/cron` / `src/renderer/components/features/cron` | F15 |
| `src/renderer/components/features/meetings` | F13 |
| `src/renderer/components/onboarding` | F18 |
| `src/renderer/i18n` | F17 F05 F18 |
| `src/renderer/components/features/chat` | F09 F10 F16 F05 |

## 评分标准（Rubric）

- **pass**：该流程卡的每一步都按文中走通；UI 预期和可观测量都对上；没有出现「失败长什么样」里的任何一条。
- **partial**：主链路走通但有一项不符（文案不对、可观测量缺失、需要额外点击才继续），或只能在 hermetic 层验证而真机未验。须写明缺哪一项。
- **fail**：任一步走不通、数据与预期不符（数字错、没落盘、没通知）、或出现「失败长什么样」里的症状。

PR 改了主路径时，描述里贴：
1. 受影响流程 ID（来自上表）和每个流程的 pass / partial / fail。
2. 每个流程一条原始证据：测试输出行，或真跑的 `run-N.sse` / `db-N.json` 里证明走到该路径的那一行。
3. 证据档位（见 `docs/testing-evidence-classes.md`）；surface 为 shell 的流程写明是 hermetic 测试还是真机批，不能写「已验证」。
4. 对地图本身的修正（选择器改名、预期变化）同 PR 更新本文件。

## 取舍记录

- 目标 15-20 条，最终 18 条：任务书点名的 15 类全部保留，把审批卡拆成允许一次 / 拒绝 / 本次任务内允许三条（近期审批类修复最多，粒度要细），日历拆成新建 / 修改 / 删除撤销 / 读取四条。
- 日历（F01-F04）、浏览器（F11 F12）、会议（F13）依赖原生能力，标 `shell`，Web 构建只能验审批卡形状和组件，真实效果走真机批。
- 未收入：语音通话、设计画布、多 Agent 团队、连接器（邮件 / 飞书）写入——它们重要但不属于「每个 PR 都该复查」的最小集，后续按改动频率再加。
- 真跑发现并已写进卡片：附件分析会被模型自行转后台（F10 与 F08 同路径）；后台任务里的审批无人处理会 60 秒静默超时；记忆写入要先在「确认用户规则」弹窗点确认，2 分钟内没点就不写入、也不会记入 `permission_decisions`（F14）。
