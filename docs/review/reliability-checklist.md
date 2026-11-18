# 评审可靠性清单（diff 触发）

> 用途：把「踩过的坑」从评审者的记忆里搬到文件里。评审时先跑
> `node scripts/review/checklist-match.mjs --base origin/main`，只逐条核对**命中**的条目，没命中的不重查。
> 思路来源：Anthropic 10-15《Claude Code 团队如何做代码评审》——由 diff 触发的可靠性清单。
> 本文件被 `scripts/review/checklist-match.mjs` 直接解析，不要在脚本里另存一份。

## 条目格式

每条是一个 ` ```rc ` 围栏块，块内每行一个 `key: value`（单行，不换行，不缩进）：

| key | 必填 | 含义 |
|-----|------|------|
| `id` | 是 | `RC-NN`，全表唯一 |
| `paths` | 与 diff 至少一个 | glob 列表，用 ` \| ` 分隔；`**` 跨目录，`*` 不跨 `/`；`!` 开头是排除 |
| `diff` | 与 paths 至少一个 | `/正则/标志`，对命中文件里**新增行**（不含 `+` 前缀）逐行匹配 |
| `diff-del` | 同上 | `/正则/标志`，对命中文件里**删除行**逐行匹配 |
| `check` | 是 | 一两句祈使句，评审者能只看 diff 核实 |
| `incident` | 是 | 至少 2 条来源，用 ` ; ` 分隔：`<短sha> #PR`、工单号，或「规则文件 + 小节」 |
| `expiry` | 是 | 什么条件满足后这条可删（例如「被某道门机器化之后」） |

触发语义：`paths`、`diff`、`diff-del` 同时给出 = AND（同一个文件必须同时满足）；只给 `paths` = 改到该路径即命中。
解析失败（缺字段、id 重复、正则编译不过）匹配脚本退出码 2 并点名条目 id。

## 新增条目的门槛

1. 同一类事故在 **≥2 个不同 PR / 工单**里出现过（`incident` 里列两条）；只有一次的不收，写进 PR 描述等第二次再说。
2. 能从 diff 的路径或文本认出来；认不出来的（纯流程类）不属于本清单。
3. 已被 CI/husky 机器门完全挡住、且 REVIEW.md「不要审」里点名的（硬编码常量、provider 对称、PROMPT_VERSION、design-system 静态门）不收。
4. 触发要窄：一个典型 PR 命中 3–10 条为宜，中位数超过 10 就收紧 triggers。

## 季度修剪规则

**每个季度删除两类条目：① `expiry` 条件已经满足的；② 该季度内没有命中过任何 PR 的。**
修剪走普通 PR，PR 描述里列出删除的 id 与理由。

## 条目

```rc
id: RC-01
paths: src/host/services/core/repositories/**
diff: /(?<!\?\?\s)Date\.now\(\)/
check: 仓库层写 updated_at / 时间戳的方法必须接受可选时间戳参数，未传才 `?? Date.now()`；裸 Date.now() 会在云端同步时抹掉远端原始时间戳。
incident: 06818172a updateSession 恒写 Date.now() 导致云端同步把所有会话时间戳写坏 ; 6d5a5b884 #2636 仓库层改为传入时间戳（CLAUDE.md「时间戳更新」禁令）
expiry: 仓库层 Date.now() 由 lint 规则或门机器化拦截之后
```

```rc
id: RC-02
paths: src/renderer/**/*.ts | src/renderer/**/*.tsx | !src/renderer/i18n/** | !**/*.test.ts | !**/*.test.tsx
diff: /[一-鿿]/
check: 用户可见文案不得在组件里写中文字面量，必须走 i18n 词表，英文 UI 才不会漏中文；注释里的中文不算。
incident: 12323119e #3360 en ui hardcoded zh systemic ; 55a9d53be #3535 en ui hardcoded zh redesign（另见 050f1c9ce #3527 审批卡标题）
expiry: scripts/renderer-cjk-literal-baseline.json 存量清零且门改为零容忍之后
```

```rc
id: RC-03
paths: src/host/tools/shell/** | src/host/sandbox/** | src/host/tools/modules/shell/**
check: 审批通过的授权（如 approved rm grant）与沙箱升级判定必须在同一条路径上对账；改一边要证明另一边仍放行，并用真 seatbelt 用例而非 mock 验证。
incident: a3f3365f8 #2961 已批准的 rm 仍被沙箱拒 ; 74ae4fa02 #3246 与 a991d633c #3321 同类连续返修（sandboxEscalation.ts）
expiry: 授权与沙箱判定合并为单一决策点并有真沙箱回归覆盖之后
```

```rc
id: RC-04
paths: src/web/webShutdownFinalizers.ts | src/host/mcp/cuaHelper*.ts | src/host/services/infra/browser/** | src/host/services/infra/browserPool.ts
check: 新起或改动的子进程/helper/受管浏览器，退出与 detach 路径是否都有回收（含 stop 意图取消等待时的保底窗口），不能只在正常路径关闭。
incident: cb66ea51c #3422 完整退出后 cua helper 成孤儿 ; dd1569ddb #3468 reap 被取消等待吃光预算仍成孤儿 ; eb5a9886e #3238 shell detach 时受管 Chrome 未关
expiry: 子进程生命周期收口到统一 supervisor 且有进程残留回归之后
```

```rc
id: RC-05
diff: /\b(pkill|killall)\b/
check: pkill/killall 的匹配模式是否会误杀其他槽、其他 worktree 或生产 app；优先按端口监听者或记录的 pid/进程组精确杀。
incident: 02762b5cf #2765 install 脚本 pkill webserver 过宽 ; 2e6c15666 #2794 同类（清理改为只看监听端口）
expiry: 清理逻辑统一到按端口/pid 的单一脚本，且其余 pkill 调用被门禁止之后
```

```rc
id: RC-06
paths: tests/e2e/** | scripts/verify-*.mjs | scripts/e2e*.mjs | tests/**/playwright*.ts
diff: /channel:\s*['"]chrome['"]|headless:\s*false|--headed|--headless=false/
check: 默认验证必须 headless 走 Playwright 自带浏览器；引入系统 Chrome / 有头模式要确认是明确的真机验收，且中断后有整棵进程树清理。
incident: .claude/rules/testing.md「后台浏览器任务清理（错题本 2026-07-30）」孤儿 Playwright 90 秒连崩 Chrome 25 次 ; eadb9d58d vitest 浏览器冒烟强制走 Playwright bundled headless shell
expiry: 有头配置被 CI 门禁止、或验证脚本统一由带进程组清理的 runner 启动之后
```

```rc
id: RC-07
diff: /Contents\/MacOS\/code-agent-tauri/
check: 不得直接执行 .app 内的 code-agent-tauri 二进制；构建+安装+启动只走 scripts/run-dev-slot.sh。
incident: CLAUDE.md「红线：禁止直接执行 *.app/Contents/MacOS/code-agent-tauri」（2026-09-25 连崩三次） ; 47a642a05 #2412 桌面包启动红线文档化
expiry: 仓内不再存在任何直接 exec 该二进制的脚本，且有门扫描之后
```

```rc
id: RC-08
paths: src/host/** | src/web/**
diff: /catch\s*(\(\s*\w*\s*\))?\s*\{\s*(return\b|\}|\/\/)|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(null|undefined|\{\s*\}|void 0)\s*\)/
check: 降级/吞异常分支必须 warn 出可区分的原因（A 缺还是 B 缺），装载类逻辑带出每个候选路径的真实错误；fail-open 指行为不变，不是失败不留痕。
incident: .claude/rules/testing.md「降级路径必须留痕 / 假 mock 掩盖真形状（错题本 2026-08-14）」声纹整链静默 ; 9b9fa763d #2179 telegram 入站 fail-open ; 2c24f0181 #2135 checkpoint 写目标解析在 fail-open try 之外
expiry: 降级分支统一经带日志的 helper 并有 lint 规则拦裸吞之后
```

```rc
id: RC-09
paths: tests/**
diff: /vi\.mock\(\s*['"][^'"]+['"]\s*,\s*\(\)\s*=>|vi\.fn\(\)\.mockReturnValue\(\{/
check: 夹具/mock 要用真实模块形状（class 就是 class、必需字段齐全）；对照被 mock 对象的真实导出与生产初始化顺序，别用手搓 plain object。
incident: .claude/rules/testing.md「假 mock 掩盖真形状（错题本 2026-08-14）」onnxruntime InferenceSession ; 6f92a28b0 #3436 夹具未像生产初始化 TaskManager ; 3b86142a6 #3209 夹具缺 messageHistory/getWorkingDirectory
expiry: 关键模块提供官方 test double 工厂且旧手搓 mock 被清理之后
```

```rc
id: RC-10
paths: src/host/agent/runtime/contextAssembly/** | src/host/context/readResultProjection.ts | src/host/prompts/** | src/host/agent/messageHandling/contextBuilder.ts | src/host/agent/messageHandling/converter.ts | src/host/tools/dispatch/toolDefinitions.ts | src/host/services/toolSearch/deferredTools.ts | src/host/tools/modules/**/*.schema.ts
check: 改了模型可见的请求字节（prompt、工具 schema、上下文组装），必须附 `npm run acceptance:snapshot-replay:record` 重录的快照，且 prompt 改动 bump PROMPT_VERSION。
incident: 54c7143ff #2062 readResultProjection 纳入快照敏感面 ; 1a0856774 #2151 snapshot 同步门补 contextBuilder 盲区
expiry: snapshot-replay-sync-gate 自动从 import 图推导敏感面而不再靠手写清单之后
```

```rc
id: RC-11
paths: scripts/*baseline*.json | scripts/ci/*baseline*.json | scripts/*allowlist*.json | scripts/ci/*allowlist*.json
check: 基线/白名单只准下降或收紧；数字上调、条目新增要有工单点名，否则按「削弱既有检查」处理。
incident: REVIEW.md 第三遍「削弱既有检查」 ; 391e37590 #1847 门的 --update 拒绝抬高基线 ; 79356eddc #1060 knip 棘轮标量净值抓不到新增，改为符号集合
expiry: 所有棘轮 --update 均机器拒绝抬高之后
```

```rc
id: RC-12
paths: src/host/security/commandSafety.ts | tests/security/commandSafety.test.ts
check: shell 安全档默认必须全平台 strict；不得恢复平台分支，lenient 只能由 CODE_AGENT_SHELL_SAFETY_MODE 显式开启。
incident: 06d0418e1 Windows 命令安全规则包引入 strict/lenient 双模式 ; e19643c64 win32 strict-flip 写入发版清单（CLAUDE.md v0.27.3 收口，由 commandSafety.test.ts 钉死）
expiry: lenient 档被删除之后
```

```rc
id: RC-13
paths: src/host/permissions/** | src/host/security/** | src/host/tools/permissionClassifier.ts
check: 审批/权限/沙箱改动对照 origin/main 同一输入的判决：基线 deny/ask 变 approve 才是放宽；扩白名单、跳过确认、扩大可写路径都要点名放宽理由。
incident: 715ce9f1f #1637 shell 解析重写追了 41 轮（REVIEW.md 基线对照规则） ; 2c3d19fa2 #2469 dryrun/dd 形状被误放行
expiry: 审批评测集（tests/fixtures/approval-eval）覆盖全部放宽形状并作为必过门之后
```

```rc
id: RC-14
diff: /\/Users\/(?!Shared\b|username\b|example\b|me\b|\w*test\w*\/)[A-Za-z][\w.-]*\//
check: diff（含夹具、快照、证据档）里不得出现真实家目录绝对路径或真名主机名，用占位或 os.homedir() 派生。
incident: REVIEW.md 第二遍「真名、绝对家目录路径是否进了 diff」 ; fbcb8107c #2470 夹具去真名主机名 ; f218cc8ae #1640 单测隔离真实家目录的用户配置
expiry: 有扫描门覆盖全部提交文件的家目录路径之后
```

```rc
id: RC-15
paths: docs/releases/v*.md
diff: /PR\s*#\d+|\bcommit\b|\b[A-Za-z][A-Za-z0-9]*\.(ts|tsx|mjs|json)\b|\b[a-z]+[A-Z][A-Za-z]+\b/
check: 发布说明会原样进 app 更新弹窗：只写用户现在能做什么，不得出现 PR 号、commit、文件名、驼峰代码标识符和架构黑话。
incident: 2b1148783 立用户向发布说明文案规则并改写 v0.20.0 ; d3ec9090d #951 补 v0.30.0 的用户向发布说明（CLAUDE.md「发布说明文案规则」）
expiry: 发布说明由门扫描禁用词并阻断 CI 之后
```

```rc
id: RC-16
paths: src/host/** | src/renderer/**
diff: /\.(startsWith|endsWith)\(\s*['"`][^'"`]{1,40}['"`]\s*\)|\.includes\(\s*['"`][^'"`]{1,40}['"`]\s*\)\s*(\)|&&|\|\|)/
check: 新判据若匹配别处写入的文本（前缀、占位符、错误串），先 grep 到写入点，用写入点真实产出的形状对照判据与夹具；同一字段多路径写入要逐条过。
incident: REVIEW.md 第一遍 + 7de82f30d #1741 占位符整条锚定、夹具产不出组头（第 5/6/7 轮同根因） ; dfb461b81 #3417 正文前缀判据配不上，活消息落进最新一轮
expiry: 该类判据改为读结构化字段（metadata kind）而非文本前缀之后
```
