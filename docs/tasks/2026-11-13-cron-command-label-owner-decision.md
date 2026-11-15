# 命令行文案验收：2026-11-13 owner 决定记录

状态：已收到的授权决定；本文件只归档决定，不新增授权。

适用工单：`N-FIX-ROLE-WAKE-PROMPT-AND-THINKING-EXPOSED-THINKING-COLLAPSE-VERIFY-FU1-RECHECK`。
关联审查：PR #3293；被替代的验收要求来自 ai-review #1741。

## 决定出处与原文

出处是本工单同一工作会话中，用户通过 Resume 消息送达的
「编排答复（劳拉，2026-11-13）」。该消息明确回复上一轮 ATTENTION：
能否更新旧验收断言，将其要求展示原始命令的行为改为本单要求的人话文案。
以下逐字归档用户送达的决定：

> 这是对你 ATTENTION 问题的决定，不是建议。任务书其余要求照旧。真跑用的模型照 realrun-dev-model，不用 GLM。
>
> 决定：可以。把旧验收断言改成本单要求的人话文案，不再要求展示原始命令。用户看到原始命令属于内部文本外露，正是本单要修的。证据档写明改了哪条断言、改前改后。

这不是编写代码的 agent 自行 override 审查。决定先于测试改动到达，
此前仅记在仓外工单证据档；本次补入仓内，使审查能核对决定内容和适用范围。

## 替代范围与用户体验取舍

本工单最初就要求定时任务的工具行不显示原始命令或路径，后续返修明确要求
修复 Bash、terminal_write、preflight 折叠行及 cron 审批条的内部文本外露。
因此命令文案属于本工单范围，分支名中的 wake/thinking 不代表排除该验收项。

ai-review #1741 原验收要求：被拦命令的折叠行包含命令原文，且两条不同命令的
行文可区分。该决定明确替代其中依赖命令原文的展示及断言：普通时间线使用
本地化动作和状态文案；连续被拦的 Bash 行允许有相同的「未执行」动作文案。
这项取舍不再承诺仅凭折叠行文字就能区分两条命令，不能把新的相同文案当作
仍满足旧的区分性要求。原始命令仍保留在工具参数及显式展开的命令详情中。

执行前被拦与真实执行失败仍必须区分；未执行的动作不得写成已经完成。
本决定不改变执行、权限、审批或同意边界。

## 对应实现和断言

- `src/renderer/utils/humanizeToolStep.ts`：Bash 和 terminal_write 使用本地化的状态文案，普通工具行不拼接命令或模型提供的命令描述。
- `src/renderer/utils/toolPreflightPresentation.ts`：被拦 shell 行使用「未执行」，不拼接原始命令。
- `src/renderer/components/features/chat/CronRunSessionStatusBar.tsx`：审批条使用本地化动作；原始命令由显式的查看命令入口展示。
- `tests/renderer/utils/humanizeToolStep.test.ts`：将完成/失败的命令预览断言替换为对应状态的人话文案；shell 描述统一采用本地化模板。
- `tests/renderer/components/demoAcceptance.presentation.test.tsx`：将「包含 npm test/npm run build，且两个标签不同」替换为每个标签均为「未执行」、不含命令、工具参数仍保存原始命令。真实执行失败不可误判成 preflight 拦截的相邻断言保留。
- `tests/renderer/utils/cronNamingResidue.test.ts`：中英文、完成/运行/待审批/失败状态均检查无原始命令与路径；另检查 preflight 和用户可见的英文部分失败状态。

## 共享调用范围

ToolHeader、ToolStepGroup、TurnCard、toolStatusLinePresentation、agentActivity、
MemberConversationView 和 SessionInspector/turnRow 使用上述共享呈现路径。
决定适用于共享的普通工具行，不是仅对某个 cron 页面隐藏命令。
显式命令详情保留，不能以该决定为由删除执行数据或更改审批内容。
