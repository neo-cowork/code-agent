# ADR-090：环境自愈（Env Assist）——遇到权限 / 缺运行时 / 登录过期 / 额度用尽 / 断网，Neo 自己诊断、能修的自己修、只留用户一次点击、修完自己把原任务做完

- 状态：**草稿·待爸拍板**（只出设计，不改 `src/`、`scripts/`、`src-tauri/`）
- 单号：N-ENV-ASSIST-DESIGN
- 基线：`origin/main@fc597060f`（工作树 `mq/env-assist-design`）
- 编号：origin/main 上最新是 ADR-089，故取 090
- 相关：[ADR-085](./ADR-085-cloud-connector-auth.md)（云端连接器授权）、[ADR-086](./ADR-086-native-dep-manifest.md)（原生依赖清单）、[ADR-087](./ADR-087-cloud-run-ledger.md)（停车沿用同一 run）、[ADR-037](./ADR-037-durable-run-kernel.md)（一 run 一 owner）、[ADR-011 Chat-Native Workbench](../workbench.md)（聊天里能完成的动作不要求先开 TaskPanel）
- 吸收的散单：N-FIX-DESKTOP-DIAG-RESOURCE-ROWS、连接器诊断区、N-QUOTA-429-PLAIN-NOTICE 系列、N-PY-RUNTIME（按需安装）。对应关系见 §9。

## 0. 要爸拍板的几件事（人话版）

1. **一个统一出口**：所有环境类失败（失败卡、停车卡）共用同一张「环境提示卡」——一句人话 + 一个直达按钮，不出现错误码、不出现 TCC / osascript 原文。同一任务里同一类问题只出现一次。（§4）
2. **Neo 能自己修的绝不打扰用户**：缺运行时自己装并显示进度、额度用完自己换一个能用的模型并告诉用户、断网自己等并重试。用户只做「只有用户的手能做的那一步」。（§3、§6）
3. **诊断绝不弹系统授权框**：诊断只用「被动探针」（只读状态 API），弹框的动作只在用户点按钮之后才会发生。靠代码结构 + 静态门 + 故障注入测试三层保证。（§5）
4. **修完自动续做**：失败的那次工具调用被「停车」成可恢复状态，探针确认修好后沿用同一个 run 接着干，用户不用再说一遍。（§7）
5. **确认不了怎么办**：超时 / 用户拒绝时，老实说「还没检测到」，给一个不依赖该修复的替代路径，仍然不出现原文。（§8）
6. **范围**：先做 macOS（桌面包 + web 构建里同一宿主）；Windows 只做「老实说不支持 + 替代路径」，不做深链。

建议：全按本稿推进；唯一需要爸明确定的取舍是 §10 的两条（拒绝后多久可以再问；额度换模型是否需要确认）。

## 1. 现状（全部引自本仓库代码，grep 为准）

### 1.1 用户今天看到的是什么

| 场景 | 代码位置 | 现在的行为 |
|------|----------|-----------|
| Apple Events 被拒（-1743） | `src/host/connectors/native/osascript.ts` `describeAppleScriptFailure` / `describeAppleScriptFailureText` | 文案是「`${label} 未获授权：请在「系统设置 > 隐私与安全性 > 自动化」中允许 Neo 控制 ${label}，然后重试。`」——让用户**自己去找**设置页，没有按钮、没有深链、没有自动续做；`isAppleEventsDenied` 只正则匹配 `-1743|not authorized to send apple events` |
| 同一错误的另外三份私有判断 | 同文件注释自述：「screenshotFailureCause / photos.ts 各有私有同款判断」；`src/host/tools/vision/screenshotFailureCause.ts` 的 `CAUSE_TEXT` 直接是英文 `'screen recording permission denied'` | 同一类问题 4 处各判各的，文案不一致 |
| 系统设置深链 | `src-tauri/src/native_desktop.rs` `desktop_open_system_settings` 的 match：只有 `screenCapture / accessibility / microphone / inputMonitoring / notifications`，**没有 automation**，其余 `Err("Unsupported settings pane: …")`；`src/host/ipc/desktop.ipc.ts:46` 另有一份写死的 `FULL_DISK_ACCESS_SETTINGS_URL` | 最常见的自动化授权（Mail/Calendar/Reminders）反而没有深链 |
| 权限状态读取 | `src/shared/contract/nativeDesktop.ts` `NativePermissionKind` 含 `automation`；`native_desktop.rs` 里 `probe_accessibility_permission`（`AXIsProcessTrusted()`）、`probe_screen_capture_permission`（`CGPreflightScreenCaptureAccess()`）都是**被动探针**；但 `automation` 在 Rust 里只有一处注释「per-app Automation permissions persist」，没有探针 | 辅助功能/录屏有被动探针可复用；自动化没有 |
| 模型失败 | `src/shared/modelErrorDiagnostics.ts` `classifyModelErrorMessage` → `auth_failed / quota_exhausted / upstream_unavailable …`，其 `suggestion` 是「用 /login <provider> 重新配置 API Key，或用 /model 切换…」；`agentEngineFailureDiagnostics.ts` 把外部引擎失败归 `auth/quota/network/missing_cli…` 并把 `suggestion` 当 `rawMessage` 塞进 `AgentErrorMetadata` | 术语（`/login`、`/model`、engine）外露给非程序员 |
| 失败卡 | `src/renderer/components/features/chat/AgentErrorCard.tsx`：按 `AgentErrorCategory` 查 i18n；动作是「重试 / 切换模型 / 新开会话 / 查账号」 | 动作都是**让用户去做**，没有「Neo 已经替你做了什么」；`AgentErrorMetadata.rawMessage` 进错误报告 |
| 额度停车 | `src/host/runtime/quotaWaitTimer.ts` `armQuotaWaitOnPark`（到点自动续跑）、`runRegistry.ts:389`（`interruptCause==='quota_wait'`）、`quotaWaitNotice.tsx` | **已经有**「停车 → 到点自动续跑」的完整闭环，但只服务 quota_wait 一种原因 |
| 模型降级 | `src/host/agent/runtime/contextAssembly/inferenceProviderFallback.ts`、`shared/constants/providers.ts` `PROVIDER_FALLBACK_CHAIN`、`renderer/.../chat/fallbackNotice.ts`（`ModelFallbackNoticePayload`） | 已有自动降级与「已降级」提示，但与失败卡是两条独立通路；`modelConfigResolver.ts` 的 `resolveRunModelConfig` 只按会话 override 选模型，不会「当前 key 无额度 → 找一个有 key 的」 |
| 缺 LibreOffice | `src/host/tools/media/officeRaster.ts`：`isLibreOfficeAvailable()` 缺失时静默 `triggerLibreOfficeInstallOnce()`（`ensureLibreOffice`，`src/host/runtime/libreOffice/ensure.ts`，有 `setInstallPercent`、`offlineError`、`checksumError`），同时 `getLibreOfficePath` 抛 **英文** `LibreOffice preview is being prepared in the background. Retry in a moment.` | 安装是自动的，但**进度只在「设置→本机功能」可见**（`RuntimeAssetRow.tsx`）；聊天里用户看到的是一句英文异常，装完也不会续做 |
| 缺 Python | `src/host/tools/modules/shell/managedPythonEnv.ts`（fail-closed，返回结构化 code + 白话说明，后台 `ensurePythonEnv()`）、`runtime/pythonEnv/ensure.ts`（`getInflight` 去重、进度百分比） | 同上：装得对，但聊天里没有进度、装完不自动重跑 |
| 通用运行时安装器 | `src/host/runtime/runtimeAssetInstaller.ts`（`installRuntimeAssetFromManifest`，sha256 校验、`ensureInside`）、`updateService.prepareRuntimeAssetOnDemand`（`desktop.ipc.ts` 引用） | 只覆盖 manifest 里的 node 模块资产；LibreOffice / Python 各有自己的 `ensure*`，三套互不相通 |
| 登录过期 | `src/host/mcp/mcpReauthorize.ts` `reauthorizeMcpServer`（作废 tokens → 重连 → `waitForPendingOAuthAuthorization` → `isConnected`）；`cliConnector.ts` `authSteps`（`pty-url`）；引擎侧 `reliability.authState: 'needs_login'` | 重连逻辑完整，但入口是「聊天卡的重新授权按钮」，文案与失败卡不统一；成功后不会续做原任务 |
| 停车卡 | `src/shared/contract/pendingApproval.ts`：`PendingApprovalKind = plan / launch / tool_approval / directory_access / channel_pairing`；`runRegistry` 停车 | 停车种类里**没有**「环境问题」 |

### 1.2 Neo 自己的 TCC 与"目录授权"是两回事

`directory_access`（`request_directory` 工具）是 Neo 自己的目录白名单审批，不是 macOS 的「文件和文件夹」授权。用户任务「把下载文件夹的 PPT 转成 PDF」可能同时撞到两层：Neo 白名单（已有停车卡）+ macOS TCC 文件夹授权。本 ADR 只管后者；前者保持现状但卡片外观并入同一出口（§4.4）。

### 1.3 实机 141 条环境拦截的分布（任务书给出的主要几类）

权限弹窗约 23、模型额度/能力 17、外部账号登录过期 13、全新首启 13、缺运行时 6，合计约 72；其余 69 条任务书未分类，**本稿不假装覆盖**，实现时第一步（S1）要把真机日志按本稿 12 类重新归桶，归不进去的列为新类再补。

## 2. 设计依据（外部做法 + 本仓库实证）

| # | 做法 | 来源 | 我们借什么 |
|---|------|------|-----------|
| E1 | **Alfred**：把权限讲成一页「需要什么权限 → 为什么 → 去哪里勾」，卡住时给 `tccutil reset` 兜底指引；明确只有 Accessibility（模拟按键/片段）才要，不用的功能不提前要 | <https://www.alfredapp.com/help/getting-started/permissions/> | **按需才要**（用到才提示，不在首启一股脑弹）；「勾了也不生效」要有兜底路径（§8） |
| E2 | **Keyboard Maestro**：Accessibility 要同时勾主程序和 Engine；Big Sur 之后 Input Monitoring 可覆盖 Accessibility；「勾选框亮着但仍被拦」是常见现象，修法是关掉再开 / 重启 Engine | <https://wiki.keyboardmaestro.com/assistance/Accessibility_Permission_Problem> | 授权**要靠探针复查而不是信用户点过**；授权后可能需要重启进程（对应我们的 `needs_restart` 状态） |
| E3 | **Raycast**：故障排查页教用户在「系统设置 → 隐私与安全性 → 辅助功能」里确认 Raycast 已启用（热键、片段展开需要） | <https://manual.raycast.com/troubleshooting.md> | 把权限与具体功能绑定，一句话说清「开了它你能得到什么」 |
| E4 | **Apple `AEDeterminePermissionToAutomateTarget`**：`askUserIfNeeded=false` 时不弹框，未决定返回 `errAEEventWouldRequireUserConsent`（-1744），拒绝返回 `errAEEventNotPermitted`（-1743）；目标 App 必须在运行；hardened runtime 需 Apple Events entitlement | 讨论与实测：<https://developer.apple.com/forums/thread/130949>、<https://mjtsai.com/blog/2018/08/31/aedeterminepermissiontoautomatetarget-added-but-aepocalyse-still-looms/trackback> | **自动化权限的被动探针**——§5 的基石。注意：mjtsai 记录说「未决定」与「曾被拒」在 false 模式下行为不完全可区分，所以设计上把「首次请求」放在用户点击里（§3 行 1），不依赖区分 |
| E5 | **uv**：需要某版 Python 而本机没有时，自动下载 python-build-standalone，可用开关禁用；先用本机已有解释器；装在 uv 自己的目录里不污染全局 | <https://docs.astral.sh/uv/guides/install-python/> | 「缺运行时 → **按需、静默、装在私有目录**」，且「先找已有的再装」——与我们 `getLibreOfficeCandidates`/`ensurePythonEnv` 同构，差的只是**把进度和续做接回聊天** |
| E6 | **本仓库自己的先例**：`quotaWaitTimer` + `runRegistry` 停车 + `QuotaWaitNotice` | `src/host/runtime/quotaWaitTimer.ts`、`src/renderer/components/features/chat/quotaWaitNotice.tsx` | 「停车 → 外部条件满足 → 沿用同一 run 自动续」的机制已经在生产跑，本 ADR 把它**泛化**而不是另起炉灶（§7） |

未能核实的对照（诚实标注）：任务书点名的 Claude Desktop / ChatGPT desktop / Manus 的连接器重登与额度耗尽处理，本稿无法在无头环境里实测其产品行为，也没有找到可引用的官方文档，**不作为依据引用**；登录过期一节改以本仓库 `mcpReauthorize.ts` 的现成实现为依据（已有「作废 tokens → 重连 → 等授权 → 看连接态」闭环），实现阶段（S6）再做一次真机对照。

## 3. 环境拦截分类矩阵（每类一行：诊断 / 自修 / 用户一步 / 确认并续做）

约定：诊断**只用被动探针**（§5）；「用户一步」是唯一允许出现的按钮；「确认」写明轮询的状态、间隔、超时；「续做」统一走 §7 的停车续跑。深链 URL 为 macOS 13+ 的 `x-apple.systempreferences:` 形式，除已在仓库出现的外，标「待真机验证」。

| # | 类 (`EnvBlockerClass`) | 诊断：读什么 | Neo 不问就修的 | 用户唯一一步（按钮 → 落点） | 确认修好（探针 / 间隔 / 超时） | 续做原任务 |
|---|---|---|---|---|---|---|
| 1 | `perm_automation`（Mail / Calendar / Reminders / Photos / 其他 App 的 Apple Events） | 工具抛出的 osascript 失败经 `isAppleEventsDenied`（`osascript.ts`）归类为 -1743；目标 App 取自 connector id。**不重跑 osascript**；探针用 `AEDeterminePermissionToAutomateTarget(askUserIfNeeded=false)`（Rust 侧新增，E4）；目标 App 没运行则先 `open -a`（无弹框）再探 | 目标 App 未运行 → 自己启动；超时类 → 缩小范围重试一次（现有 `timeoutContext` 逻辑） | 按钮「去允许 Neo 控制「邮件」」。点击后 **先** 以 `askUserIfNeeded=true` 触发系统授权框（首次授权的正常路径，此时弹框有明确上下文）；若系统直接返回 -1743（曾被拒，不会再弹）→ 打开 `x-apple.systempreferences:com.apple.preference.security?Privacy_Automation`（**需在 `native_desktop.rs` 增加 `automation` 分支**，现缺） | 每 1.5s 被动探针，窗口重新获得焦点时立即补探；120s 超时 | 授权即时生效，无需重启；自动续做 |
| 2 | `perm_accessibility`（控制电脑 / 读 UI） | `AXIsProcessTrusted()`（`native_desktop.rs:612` 已有）；Computer Surface 失败种类 `permission_denied` / `ax_unavailable`（`desktop.ipc.ts` `COMPUTER_SURFACE_FAILURE_KINDS`） | — | 「打开辅助功能设置」→ `…?Privacy_Accessibility`（已有） | 同上 1.5s / 120s；若探针为 true 但动作仍失败 → 状态 `needs_restart`（E2） | 授权后若 `needs_restart`：按钮变「重启 Neo 并继续」，重启后 run 从停车点恢复（§7） |
| 3 | `perm_screen_recording` | `CGPreflightScreenCaptureAccess()`（`native_desktop.rs:653` 已有）；`screenshotFailureCause.ts` 现把它判为 `screen_recording_permission` | 非 GUI 会话（`ssh_session_no_gui`）直接走替代路径，不提示授权（授权也没用） | 「打开屏幕录制设置」→ `…?Privacy_ScreenCapture`（已有）；点击时调 `CGRequestScreenCaptureAccess()` 触发系统框 | 同上；录屏授权**必须重启进程才生效**，探针返回 true 后若截图仍失败 → `needs_restart` | 重启后续做 |
| 4 | `perm_input_monitoring` | 新增 `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)` 被动探针（只读，不弹框） | — | 「打开输入监控设置」→ `…?Privacy_ListenEvent`（已有） | 同上 | 同 2 |
| 5 | `perm_notifications` | `UNUserNotificationCenter.getNotificationSettings`（被动） | 通知不是任务主路径：**降级为应用内提示**，任务继续，不停车 | 「打开通知设置」→ `…Notifications-Settings.extension`（已有） | 低优先，不轮询，只在下次需要时复查 | 不阻塞，无续做 |
| 6 | `perm_files`（macOS 文件和文件夹 / 完全磁盘访问，如下载、桌面、文稿） | 读文件 `EPERM`/`EACCES` 且 Neo 白名单已放行（区分于 `directory_access` 停车）；`desktop.ipc.ts:46` 已有 FDA 深链 | 先试 `request_directory` 路径内的合法入口 | 「打开文件和文件夹设置」→ `…?Privacy_FilesAndFolders`（待真机验证）；仅当确需 FDA 时用 `…?Privacy_AllFiles`（已有） | 对同一路径做一次只读 `access()` 复查（不弹框），1.5s / 120s | 自动续做 |
| 7 | `runtime_missing`（LibreOffice / Python / 其他 optional 资产） | 工具模块自己的状态：`isLibreOfficeAvailable`/`getLibreOfficeCandidates`、`getPythonEnvState`（phase: installed/installing/failed/unsupported）、`getRuntimeAssetsStatus` | **自己装**：`ensureLibreOffice()` / `ensurePythonEnv()`（已存在，单飞去重）；进度百分比取 `setInstallPercent` / `getInstallPercent` 状态，经 §4 卡片在聊天里显示「正在准备 PPT 转换组件 42%」；先找已有再装（E5）；sha256 校验已由安装器做 | 一般**无**。仅在：磁盘不足 / 离线 / 校验失败 / Windows 不支持 时才出现按钮（「重试安装」或「改用别的方式」） | 每 1s 读安装状态（进程内，零成本），无硬超时但 5 分钟无进度变化判失败 | 装好即自动重跑那一次工具调用（沿用 toolCallId） |
| 8 | `login_expired`（MCP OAuth / CLI 连接器 / 外部引擎） | MCP：`client.getServerState` + 401/403 挑战（`mcpScopeUpgrade`）；CLI：`cliConnector` 的 `authSteps` 状态；引擎：`AgentEngineFailureDiagnostics.reliability.authState==='needs_login'` | 先静默刷新 token / 重连一次（不丢 client 注册）；失败再进入用户一步 | 「重新登录「飞书」」→ 宿主调 `reauthorizeMcpServer(client, serverName, requiredScope)`，浏览器授权页自动打开（已有 `pty-url` 流程） | `waitForPendingOAuthAuthorization` 之后读 `client.isConnected(serverName)`；`OAUTH_FLOW_TIMEOUT_MS`（`oauthCoordinator`）超时 | 连接后自动续做 |
| 9 | `quota_exhausted`（余额不足 / 配额用尽 / 套餐窗口用尽） | `classifyModelErrorMessage` → `quota_exhausted`、HTTP 402、`AgentErrorCategory` 的 `insufficient_balance` / `usage_limit`（带 `resetAt`）、引擎侧 `quotaState` | **自己换模型**：在 `PROVIDER_FALLBACK_CHAIN`（`shared/constants/providers.ts:423`）里挑「有 key、能力够（视觉/长上下文/工具）」的下一个，沿用 `inferenceProviderFallback.ts` 的降级执行；告诉用户「X 额度用完了，已改用 Y 继续」（§6）。`usage_limit` 且窗口很快恢复（`resetAt` 近）→ 走现有 `armQuotaWaitOnPark` | 仅当**没有任何可用模型**时：「去添加一个模型」→ App 内设置→模型页（非外链）；或「充值」外链（provider 控制台，无深链则不显示） | 换模型后即时（下一次请求成功即确认）；充值类每 10s 用一次廉价探测（`/models` 或最小请求）轮询，最多 10 分钟 | 自动续做 |
| 10 | `model_capability`（模型不支持图片/工具/温度） | `classifyModelErrorMessage` 的 `unsupported_temperature`、`fallback_not_configured`；`image_payload`；`model_not_found` | 自动降参重试（温度 1）；自动换到能力够的模型并说明 | 同 9 的「没有可用模型」分支 | 同 9 | 自动续做 |
| 11 | `offline`（无网 / 代理失效 / 上游 5xx） | 引擎侧 `network` 分类（`ECONNREFUSED/ENOTFOUND/fetch failed/502-504`）；`upstream_unavailable`；两点探测（目标 provider 端点 + 一个中立端点）区分「全断网」与「仅该服务」；国际 API 需 `HTTPS_PROXY`（见 `.claude/rules/security.md`） | 指数退避重试 3 次；仅该服务不可达 → 走 9 的换模型；全断网 → 停车等待恢复 | 全断网：**无按钮**，卡片只说「网络断了，恢复后我会自动继续」；仅当判断为代理问题：「打开网络设置」→ `…?Network`（待真机验证） | 每 5s 两点探测，最长 10 分钟（超时 → §8） | 恢复后自动续做 |
| 12 | `first_launch`（全新安装：无 key、无数据目录、权限全空） | `getRuntimeAssetsStatus`、`NativePermissionSnapshot.summary`、`resolveModelConfig` 日志里的「未配置 API Key」 | 建目录、解包随包资产、预热 optional 资产（不弹任何系统框） | 仅「没有任何模型 key」时一次：「添加模型」→ App 内设置；**权限一律不在首启预先要**（E1：用到才要） | 读 `configService.getApiKey` | 无原任务时不适用；有则自动续做 |

## 4. 统一出口：`EnvAssistNotice`（一句话 + 一个按钮）

### 4.1 原则

1. 失败卡（`AgentErrorCard`）与停车卡（停车收件箱 / 会话停车卡）遇到环境原因时**都不再自己写文案**，一律渲染同一个 `EnvAssistCard`。
2. 卡片只有：**一句人话**（`sentenceKey` + `params` → i18n）和 **一个主按钮**（`action`）。进度条是同一句话的一部分，不算第二个动作。
3. 不出现：错误码、`-1743`、`osascript`、`TCC`、`Apple events`、`/login`、`/model`、引擎名、绝对路径、HTTP 状态码、provider 原始响应体。
4. **同一任务里同一类只出现一次**：去重键 `dedupeKey = ${runId}|${class}|${target ?? ''}`。重复命中只更新已有卡的 `phase`，不新建卡、不新弹。

### 4.2 宿主 ↔ 渲染层数据契约

新文件（实现阶段）`src/shared/contract/envAssist.ts`：

```ts
export type EnvBlockerClass =
  | 'perm_automation' | 'perm_accessibility' | 'perm_screen_recording'
  | 'perm_input_monitoring' | 'perm_notifications' | 'perm_files'
  | 'runtime_missing' | 'login_expired'
  | 'quota_exhausted' | 'model_capability' | 'offline' | 'first_launch';

export type EnvAssistPhase =
  | 'diagnosing'    // 正在查（≤2s 内不渲染，避免闪烁）
  | 'fixing'        // Neo 在自己修（安装/换模型/重试），可带进度
  | 'needs_user'    // 轮到用户点那一下
  | 'verifying'     // 用户点过了，Neo 在轮询确认
  | 'resolved'      // 已修好，原任务正在/已经继续
  | 'unconfirmed'   // 超时仍没确认（§8）
  | 'declined'      // 用户明确拒绝（§8）
  | 'unsupported';  // 本平台做不到（如 Windows），只给替代路径

export type EnvAssistActionKind =
  | 'open_settings_pane'   // 宿主打开系统设置某一页（payload.pane）
  | 'request_grant'        // 宿主触发系统授权框（仅在用户点击后）
  | 'reauthorize'          // 调 reauthorizeMcpServer / CLI 授权流
  | 'open_app_settings'    // App 内设置页（payload.route，如 settings/models）
  | 'restart_and_continue' // 重启 Neo，run 从停车点恢复
  | 'recheck'              // 再查一次（unconfirmed 态）
  | 'skip_step';           // 跳过这一步继续（declined / unconfirmed 的替代路径）

export interface EnvAssistNotice {
  /** 稳定 id = dedupeKey，渲染层按它去重/原地更新 */
  id: string;
  sessionId: string;
  runId: string;
  class: EnvBlockerClass;
  /** 具体对象，如 { id:'mail', labelKey:'env.target.mail' }；label 永远是 Neo 自己的人话名，不是进程名/路径 */
  target?: { id: string; labelKey: string };
  phase: EnvAssistPhase;
  /** 人话一句：i18n key + 填空参数（模型名、App 名、百分比）。host 不发整句文案，语言钉死风险同 AgentErrorMetadata 的注释 */
  sentenceKey: string;
  sentenceParams?: Record<string, string | number>;
  /** fixing 态进度 0–100 */
  progress?: { percent: number };
  /** 唯一按钮；phase 不是 needs_user/unconfirmed/declined 时通常省略 */
  action?: {
    kind: EnvAssistActionKind;
    labelKey: string;
    payload?:
      | { pane: 'automation' | 'accessibility' | 'screenCapture' | 'inputMonitoring' | 'notifications' | 'filesAndFolders' | 'fullDiskAccess' | 'network' }
      | { serverName: string; requiredScope?: string }
      | { route: string };
  };
  /** 修好后怎么续：auto=Neo 自己续；manual 仅用于 skip_step 选择后 */
  resume: { mode: 'auto' | 'manual'; parkId?: string };
  /** 仅 phase==='resolved' 且发生了自动换模型等「Neo 替你做了什么」时的补充一句 */
  doneKey?: string;
  updatedAt: number;
  /** 仅开发者模式可见的原始诊断；默认不序列化到渲染层 */
  devDiagnostic?: { rawRef: string };
}
```

传输：沿用现有 agent event 通道新增事件 `env_assist_notice`（带完整快照，幂等覆盖）；同时写入该轮消息 `metadata.envAssist`，使历史回放一致（`AgentErrorMetadata` 增加可选 `envAssist?: EnvAssistNotice`）。渲染层动作回调走一个 IPC：`envAssist.act({ noticeId, actionKind, payload })`，宿主**只**接受 noticeId 对应的当前卡的合法 action（防止渲染层伪造任意 `open`）。`rawMessage` 保留给错误报告，但**当 `envAssist` 存在时不得出现在任何用户可见位置**（单测钉死）。

### 4.3 渲染组件

`src/renderer/components/features/chat/EnvAssistCard.tsx`（新）：中性面卡片（沿用 `AgentErrorCard` 视觉真源）、一句话 + 一个按钮 + 可选进度条。`AgentErrorCard` 在 `metadata.envAssist` 存在时直接委托给它；停车卡同理。`quotaWaitNotice.tsx` 的「预计 HH:MM 自动继续 / 立即重试」并入 `quota_exhausted` 的 `fixing/verifying` 态（`resetAt` 走 `sentenceParams`）。

### 4.4 与 Neo 白名单停车（`directory_access`）的关系

保持 `PendingApprovalKind` 不变，那是「Neo 要不要做」的审批；`EnvAssist` 是「系统/外部条件不具备」。同一任务既有审批又有环境问题时，先审批后环境，两张卡各一次，不合并。

### 4.5 文案规则示例（全部 i18n，不含内部词）

- `perm_automation`：「要看你的日程，需要你允许 Neo 控制「日历」。」〔去允许〕
- `runtime_missing`（fixing）：「正在准备 PPT 转换组件…42%（只需一次）」
- `quota_exhausted`（resolved）：「Kimi 的额度用完了，已改用 DeepSeek 接着做。」
- `login_expired`：「飞书登录过期了，登录一下我就继续。」〔重新登录飞书〕
- `offline`：「网络断了，恢复后我会自动继续。」（无按钮）

## 5. 只读诊断永不触发授权框——如何保证

**问题实质**：macOS 上很多 API「读一下状态」和「用一下能力」是同一个调用——例如直接跑一次 `osascript tell application "Mail"` 来试探，首次就会弹授权框；`CGRequestScreenCaptureAccess()` 会弹框，`CGPreflightScreenCaptureAccess()` 不会。

**保证（三层，缺一不可）**：

1. **结构隔离（代码形状）**：新增 `src/host/envAssist/probes/`，只导出 `ReadOnlyProbe = () => Promise<ProbeResult>` 类型的函数；探针**只允许**是：`AXIsProcessTrusted`、`CGPreflightScreenCaptureAccess`、`IOHIDCheckAccess`、`getNotificationSettings`、`AEDeterminePermissionToAutomateTarget(askUserIfNeeded=false)`、文件 `access()`、进程内状态读取（`getPythonEnvState` 等）、网络两点探测。所有「会弹框」的调用（`CGRequestScreenCaptureAccess`、`askUserIfNeeded=true`、任何 `osascript`）**只存在于** `envAssist/grants/requestGrant.ts`，且该函数入参必须是一个由 `envAssist.act` 在**用户点击事件**里签发的一次性 `ClickToken`（带 noticeId + 时间戳，30s 过期）。没有 token 编译不过。
2. **静态门（static-contract）**：新增测试 `tests/envAssist/noPromptProbes.test.ts`，对 `src/host/envAssist/probes/**` 做源码扫描：禁止出现 `osascript`、`execFile('osascript'`、`runAppleScript`、`CGRequest`、`askUserIfNeeded: true`、`requestAccess`、`AEDeterminePermissionToAutomateTarget` 以外的 AppleEvent 调用；并扫描全仓：除 `grants/requestGrant.ts` 与既有连接器执行路径外，不得新增调用这些符号。
3. **故障注入（fault-injection）**：测试里把 Rust/原生桥替换成「计数器」假实现，任何「会弹框」的入口被调用即计数+1。跑一遍全部 12 类的诊断路径，断言计数恒为 0；再模拟用户点击，断言计数恰为 1 且发生在 token 之后。夹具要用**真实形状**（错题本 2026-08-14：手搓 plain-object mock 掩盖了 `InferenceSession` 是 class 的存量 bug）——探针桥的假实现必须复刻真实返回的错误码集合（0 / -1743 / -1744 / -600）。

**自动化权限的已知缺口**：E4 记录显示「未决定」与「已拒绝」在被动模式下可能不可区分。设计上**不依赖区分**：二者都进入 `needs_user`，点击后先试 `askUserIfNeeded=true`（未决定会弹框；已拒绝会直接返回 -1743 不弹），-1743 立即落到打开 Automation 设置页。目标 App 未运行时探针返回 ApplicationNotRunning，Neo 先 `open -a`（不弹授权框）再探。

**降级留痕**（错题本 2026-08-14）：探针不可用（非 macOS、web 构建里宿主没有原生桥、缺 entitlement）时，一律 `phase` 保守置 `needs_user` 并 `logger.warn` 带**可区分原因**（`probe_unavailable:no_native_bridge` / `…:missing_entitlement` / `…:target_not_running`），不得静默当作「已授权」或「无问题」。

## 6. 自修（不打扰用户）及其挂接点

| 自修 | 挂接点（要改/要接的代码位置） | 说明 |
|------|------------------------------|------|
| **运行时自动安装 + 聊天内进度** | `src/host/runtime/libreOffice/ensure.ts`（`setInstallPercent`）、`src/host/runtime/pythonEnv/ensure.ts`（`getInflight`、进度百分比）、`src/host/tools/media/officeRaster.ts`（`isLibreOfficeAvailable` / `getLibreOfficePath` 里那句英文异常）、`src/host/tools/modules/shell/managedPythonEnv.ts` | 新增统一 `EnvRuntimeAdapter`：`{ id, isReady(), ensure(onProgress) }` 把三套安装（LibreOffice / Python / manifest 资产 `installRuntimeAssetFromManifest`）适配成一个接口，不重写安装逻辑。工具模块缺运行时时**不再抛英文字符串**，而是抛 `EnvBlockedError({ class:'runtime_missing', target:'libreoffice' })`；`getLibreOfficePath` 的 `'LibreOffice preview is being prepared…'` 改为该异常。进度经 `env_assist_notice` 推到聊天，设置页 `RuntimeAssetRow.tsx` 读同一份状态，二者不再各自维护 |
| **额度 → 换可用模型并说明** | `src/shared/constants/providers.ts:423` `PROVIDER_FALLBACK_CHAIN`；`src/host/agent/runtime/contextAssembly/inferenceProviderFallback.ts`（降级执行 + trace）；`src/host/agent/orchestrator/modelConfigResolver.ts`（`resolveRunModelConfig` 新增 `pickAvailableModel(need)`：过滤「有 key / 未被本任务标记为耗尽 / 能力满足」）；`src/shared/modelErrorDiagnostics.ts`（分类结果加 `envClass`）；渲染层 `fallbackNotice.ts` 的 `ModelFallbackNoticePayload` 并入 `EnvAssistNotice`（`doneKey` 承载「已改用 Y」） | 复用已有降级链而不是新造一套；新增的只是「**说明**」与「**本任务内记住耗尽的 provider**，不再重复撞」。`usage_limit`+近 `resetAt` 仍走 `armQuotaWaitOnPark` |
| **只读诊断永不弹框** | 新目录 `src/host/envAssist/probes/`（§5）；Rust 侧 `src-tauri/src/native_desktop.rs` 新增 `automation`/`inputMonitoring` 被动探针并把它们并入既有 `NativePermissionSnapshot`（`nativeDesktop.ts` 已有 `automation`、`inputMonitoring` kind，无需改类型） | web 构建：宿主进程在同一台机器，经 `desktop.ipc.ts` 里已有的 `execFile('open', …)` 路径打开深链（该文件 `:225` 已为 FDA 这样做）；探针在 web 构建里无原生桥 → 走 §5 降级留痕 |
| **统一归类入口** | 新 `src/host/envAssist/classify.ts`：吸收 `osascript.ts` 的 `isAppleEventsDenied`/`describeAppleScriptFailure`、`screenshotFailureCause.ts`、`photos.ts` 私有判断、`modelErrorDiagnostics.ts`、`agentEngineFailureDiagnostics.ts` 的 `category`，输出 `{class, target}`。旧函数保留为薄封装（避免大面积改调用方），其中 `describeAppleScriptFailure` 的 `not_authorized` 分支不再返回「请在系统设置…」整句，只返回类别（原 message 仅写 host 日志，沿用 `appleScriptFailureLogDetail`） | 修一类不修一个：所有「把环境错误改成人话」的地方都经过这一层 |

## 7. 修完自动续做：沿用停车 / 续跑机制

1. **工具层**抛 `EnvBlockedError(class, target)`（不是普通 Error）。`toolExecutionEngine` 捕获后：生成/更新 `EnvAssistNotice`（去重），并把本次工具调用**停车**——复用 `runRegistry` 的 `interruptCause` 机制，新增取值 `'env_blocked'`（现有 `'quota_wait'` 与 `'user_stop'` 之外；`runRegistry.ts:389` 处）并在 checkpoint 里记 `{ class, target, toolCallId }`。停车是持久的（durable run），重启后仍在。
2. **等待者**：把 `quotaWaitTimer.ts` 的「单个到点定时器」泛化为 `envResumeWaiter`——对每个停车 run 启动探针轮询（§3 各类的间隔/超时），探针转绿 → 调已注册的 continuer（与 `registerQuotaWaitContinuer` 同形，由 web 进程注册一次；**启动恢复不自动调用**，避免重启后无人在场时乱跑，保持 `quotaWaitTimer` 注释里的既有约束）。`quota_wait` 保持原样，作为 `class=quota_exhausted` 的一个实现。
3. **续跑**：以同一 `runId`、同一 `toolCallId` 重放被拦的那次调用（`ToolApprovalPayload.argsRef` 与账本 sha256 比对的做法可直接借鉴，防「点的是 A、执行的是 B」）。**不**让模型重新理解需求，也**不**要求用户重发。
4. **只读/幂等边界**：被拦的调用若是写操作且上一次可能已部分成功（如 `describeAppleScriptFailureText` 里 `write` 超时「结果无法确认」），**不自动重放**，改为带着人话说明让 Neo 先核对再决定（现有文案已强调「不要直接重试」，保持）。
5. **进程重启类**（录屏授权、`needs_restart`）：停车 → 「重启 Neo 并继续」→ 启动后用户在场即由 continuer 续跑（用户刚点过重启，视为在场）。

## 8. 确认不了怎么办（超时 / 用户拒绝）

统一原则：老实说、给替代路径、不甩原文、不无限轮询、不重复弹。

| 情形 | 卡片一句话（示意） | 唯一按钮 | 替代路径 |
|------|-------------------|---------|---------|
| 权限轮询超时（120s） | 「还没检测到你允许「日历」。如果刚刚已经点了，再查一次；不想开也行，我先做不需要它的部分。」 | 「再查一次」（`recheck`）；次要文字链「先跳过这一步」（`skip_step`，**不算第二个主按钮**，只在 unconfirmed/declined 态出现） | 跳过后 Neo 继续做能做的部分，结尾明确列出「没做的是：看日程（因为没有日历权限）」，仍不出现 TCC 字样 |
| 系统框里用户点了「不允许」（`request_grant` 立即返回 -1743） | 「好的，这次不看「日历」。需要时再告诉我。」→ `declined` | 无 | 同上，任务以部分结果收尾；**本任务内不再就同一对象追问**（去重键保证）；是否跨任务记住 → 见 §10 |
| 权限已授但仍被拦（E2：勾了不生效） | 「已经允许了，但需要重启 Neo 才生效。」 | 「重启 Neo 并继续」 | 若重启后仍失败 → 降为 unconfirmed，引导「打开设置、关掉再打开」一次（E2 的修法），不展示 `tccutil` |
| 运行时安装失败（离线 / 校验失败 / 磁盘满） | 「PPT 转换组件没装上（网络不通）。联网后我会再试，也可以先用不转换的方式。」 | 「重试安装」 | 工具自带降级（如不做 VLM 视觉审查——`pptGenerate.schema.ts` 本就把 LibreOffice 标为可选）；Windows → `unsupported` 直接给替代，不假装能装 |
| 登录授权被拒 / 超时（`OAUTH_FLOW_TIMEOUT_MS`） | 「飞书还没登录成功。你可以再试一次，或者这次先不用飞书。」 | 「再试一次」 | `mcpReauthorize.ts` 现已「不自动重试」，保持；替代路径：请求用户提供文本/文件走无连接器方案 |
| 额度：无任何可用模型 | 「现有的模型都用不了了，添加一个我就能继续。」 | 「添加模型」→ App 内设置 | 无；诚实停在这里，不假装 |
| 断网超过 10 分钟 | 「还是没连上网。联网后点一下，我从刚才的地方继续。」 | 「现在继续」（`recheck`） | 保持停车，不丢任务 |

## 9. 子工单拆分（不立单，只列在此）

每张的验收**必须含一次真实用户任务在 web 构建或 Dev 包上的运行 + 截图**，并证明「提示只出现一次 + 授权/安装后任务自己完成」。截图走 `WEB-SHOT-RECIPE`，真跑 Neo 走 `neo-realrun.mjs`（`REALRUN-RECIPE`），引用原始文件里能证明走到了该分支的那一行。

| 编号 | 标题 | 范围 | 验收（真实任务） | 风险 | 替代的散单 |
|------|------|------|-----------------|------|-----------|
| **S1** | 统一出口：契约 + 归类 + 卡片 | `shared/contract/envAssist.ts`；`host/envAssist/classify.ts`（吸收 §6 列出的 5 处私有判断）；`EnvAssistCard.tsx`；`AgentErrorCard` / 停车卡委托；去重；`rawMessage` 不外露；141 条日志重新归桶 | 真跑「帮我看下今天的日程」且日历未授权：卡片一句话 + 一个按钮；DOM 里不含 `-1743`/`osascript`/`Apple events`（断言后再截图）；同一任务内再次触发同类不新增卡 | 中：触及 `AgentErrorMetadata` 共享类型与 agent event schema（需 `agent-event-schema-gate --write`）；先过多模型对抗审查 | N-FIX-DESKTOP-DIAG-RESOURCE-ROWS（资源行诊断文案走同一出口）；连接器诊断区的「内部词外露」部分 |
| **S2** | 被动探针 + 无弹框保证 | `host/envAssist/probes/`；Rust 侧新增 `automation`（`AEDeterminePermissionToAutomateTarget(false)`）/`inputMonitoring` 探针与 `automation` 深链分支；`requestGrant` + `ClickToken`；§5 的静态门与故障注入测试 | Dev 包上**授权被重置**后，只做诊断（打开任务触发卡片但不点按钮）全程**零系统弹框**（录屏/截图佐证）；点按钮后恰一次系统框 | 高：原生桥 + entitlement + 目标 App 未运行等边缘；web 构建无原生桥走降级留痕 | —（新能力；吸收 `screenshotFailureCause` 的权限判断） |
| **S3** | 停车 + 自动续跑泛化 | `interruptCause:'env_blocked'`；`envResumeWaiter`（泛化 `quotaWaitTimer`）；`EnvBlockedError`；重放同 toolCallId；写操作不自动重放 | 真跑「把这封邮件存草稿」且 Mail 自动化被拒：授权后**不重发指令**，草稿自己存好；重启 Neo 后停车仍在 | 高：durable run / 账本 / 幂等；必须 fault-injection（授权后进程被杀再恢复） | N-QUOTA-429-PLAIN-NOTICE 系列中「等待后自动继续」的部分（`quota_wait` 成为 `quota_exhausted` 的一个实现） |
| **S4** | Apple Events 类（邮件/日历/提醒/照片）接入 | `osascript.ts` `describeAppleScriptFailure`、`mail/calendar/reminders/photos.ts` 改抛 `EnvBlockedError`；Automation 深链；目标 App 自启 | 「帮我看下今天的日程」（日历未授权）与「把这封邮件存草稿」（邮件自动化被拒）各一轮：提示一次、授权后自己完成；另跑「系统框点不允许」分支，卡片转 `declined` 且任务以部分结果收尾 | 中：`describeAppleScriptFailureText` 有现成测试，需同步改而非删 | 连接器诊断区散单（原生连接器部分） |
| **S5** | 运行时按需安装 + 聊天进度 | `EnvRuntimeAdapter` 统一 LibreOffice / Python / manifest 资产；`officeRaster.ts` 英文异常 → `EnvBlockedError`；`RuntimeAssetRow.tsx` 读同一份进度 | 真跑「把下载文件夹的 PPT 转成 PDF」且**本机无 LibreOffice**：聊天里出现「正在准备…%」恰一次，装完 PDF 自己产出；离线分支显示 §8 文案 | 中：下载 ~数百 MB、磁盘/离线/校验失败；Windows 走 `unsupported` | N-PY-RUNTIME（按需安装的聊天侧部分；设置页已有 K2 行保留） |
| **S6** | 额度/能力 → 自动换模型并说明 | `pickAvailableModel`；`PROVIDER_FALLBACK_CHAIN` 消费；`ModelFallbackNoticePayload` 并入 `EnvAssistNotice.doneKey`；本任务内记住耗尽 provider；429 / 402 / usage_limit 白话；「无可用模型」分支 | 真跑一个普通任务，把当前模型的 key 换成会 429/402 的（用 `~/.ship/grab/realrun-dev-model` 指定的 dogfood 模型作为后备）：Neo 自动换模型完成，卡片一句话说明且仅一次；后备也不可用时出现「添加模型」一个按钮 | 中：换模型改变成本与能力，涉及 §10 取舍 1；改模型可见请求组装需重录快照（`acceptance:snapshot-replay:record`） | N-QUOTA-429-PLAIN-NOTICE 系列（文案与降级说明部分） |
| **S7** | 登录过期统一 | MCP `reauthorizeMcpServer`、`cliConnector.authSteps`、引擎 `needs_login` 接入 `login_expired`；成功后续跑 | 真跑一个依赖已过期飞书/外部连接器的任务：一句话 +「重新登录」；登录后任务自己完成；中途取消 → §8 文案 | 中：OAuth 浏览器流程、web 构建与桌面差异；先静默刷新再提示 | 连接器诊断区散单（连接器重登部分） |
| **S8** | 断网 + 全新首启 | `offline` 两点探测与退避、全断网停车；`first_launch` 无 key 才提示、权限不预先要 | 真跑：断网（关代理/断网络）时发任务，恢复后自己完成，全程无按钮；全新数据目录首启发一个任务，只在需要时出现一次「添加模型」 | 低–中：探测端点的选择与代理环境（国际 API 需 `HTTPS_PROXY`）；首启要新数据目录（用 `rm -rf ~/.code-agent-devN`，不要开新槽） | —（首启/断网此前无单；N-QUOTA-429 系列里的「网络」文案） |
| **S9** | 防回退门 | 一道静态门：用户可见字符串里出现 `-1743`/`osascript`/`Apple events`/`TCC`/`/login`/`/model` 即红；`AgentErrorMetadata.rawMessage` 在 `envAssist` 存在时不得出现在渲染产物 | 先造一个反例（把某处文案改回含 `-1743`）确认门变红，再还原（变异验证） | 低 | 防止「同类文案外露」再立一串单（爸 11-08 规则） |

顺序建议：S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9；S2 与 S3 可并行。S1–S3 是地基，S4 起每张都带真实任务验收。

### 散单 → 子工单映射

| 散单 | 去向 |
|------|------|
| N-FIX-DESKTOP-DIAG-RESOURCE-ROWS | S1（统一出口文案）+ S5（资源行进度并入同一状态源） |
| 连接器诊断区（`ConnectorStatus.readiness/detail`、连接器设置里的诊断信息） | S4（原生连接器）+ S7（MCP / CLI 连接器） |
| N-QUOTA-429-PLAIN-NOTICE 系列 | S6（白话 + 换模型说明）+ S3（等待后自动续跑） |
| N-PY-RUNTIME（按需安装） | S5 |

> 说明：本稿所在环境无 `fleet` 命令，未能 `fleet show` 逐条读散单正文；上表依据任务书对四组散单的描述 + 仓库里对应代码（`RuntimeAssetRow.tsx` 注释自称 N-PY-RUNTIME-K2；`quotaWaitTimer.ts`/`quotaWaitNotice.tsx` 即 429 系列产物）推定。立单前需用 `fleet show` 核对每张散单的真实范围，不一致处以散单为准并回改本表。

## 10. 需要爸拍板的两条取舍

1. **用户拒绝之后，多久之内不再问同一类？** 建议：本任务内绝不再问；跨任务默认可再问，但同一对象 24 小时内只问一次；设置里提供「不再提示」。备选：永不再问（容易变成永久残缺能力）。
2. **额度用尽自动换模型要不要先问？** 建议：**不问**（「只显示用户必须亲手做的那一步」），但仅在「同档位或更低价」时静默换；换到明显更贵的模型时才出现一个确认按钮。备选：一律先问（违背本单目标）。

## 11. 不做什么

- 不改 `src/`、`scripts/`、`src-tauri/`（本稿只是设计）。
- 不读 TCC 数据库（需要完全磁盘访问权限，诊断本身会变成一个权限问题）。
- 不在首启预先申请任何系统权限。
- 不引入新的安装器：三套现有 `ensure*` 用适配器统一，不重写。
- 不在 Windows 上做深链（只做 `unsupported` + 替代路径）。
- 不假装覆盖任务书里未分类的 69 条拦截（§1.3，S1 第一步归桶）。

## 12. 后果

- 好处：用户遇到环境问题**只点一次**，不读错误、不重发任务；失败卡/停车卡/设置页三处不再各讲各的；「内部词外露」类的单从根上收口（S9 防回退）。
- 代价：`AgentErrorMetadata`、agent event schema、`PendingApproval`/`interruptCause` 取值四处共享类型扩展；原生桥新增探针；停车续跑的幂等边界要严格（§7.4）。
- 未决：自动化权限「未决定 vs 已拒绝」的被动区分依赖真机行为（§5），S2 必须先做真机实验再定探针语义；`…?Privacy_Automation`、`…?Privacy_FilesAndFolders`、网络设置的深链在目标 macOS 版本上需真机核对（仓库里目前只出现了 ScreenCapture / Accessibility / Microphone / ListenEvent / AllFiles / Notifications 六条）。
