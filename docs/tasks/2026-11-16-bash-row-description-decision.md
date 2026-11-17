# Bash 时间线行改用模型的人话描述（2026-11-16 决策）

## 决策
2026-11-13 自动放行，选 B：Bash 行文案用模型写的人话描述（如「列出下载文件夹」），描述缺失或像命令/路径/语种不对时退回通用文案（「运行了一条命令」）。原始命令仍不上屏，展开明细里看命令不变。

## 取代了什么
`docs/tasks/2026-11-13-cron-command-label-owner-decision.md` 里「所有 Bash 行文案一致可以接受」这一条；#3293 之后连续命令无法区分的问题由此修掉。该文档里「隐藏原始命令」的部分保持不变。

## 过滤规则（`usableBashDescription`，humanizeToolStep.ts）
1. 只读 `arguments.description`；`shortDescription` 不用（宿主缺省时会兜成 `Run: <命令首行>`）。
2. 只对 `Bash` / `bash`；`terminal_write` / `Process` / `code_execute` 保持通用文案。
3. 去首尾空白后非空、单行、≤40 字。
4. 不含 `\ / ~ $ ` | & ; < >`、`·`（会破坏「 · 」分段）、`-x` / `--flag` 形词（也就挡掉 URL 与路径）。
5. 文字类型与界面语种一致（沿用 `matchesUiScript`）。
6. 不含原始工具名（Bash/bash/Process/code_execute/terminal_write，独立词）。
7. 不含命令首词（独立词），描述不是命令的片段，命令也不是描述的片段（≥3 字符）。
任何一条不满足 → 退回通用文案。

## 呈现
- 完成 / 进行中：只显示描述。
- 待审批 / 失败：`<该状态通用词> · <描述>`。
- 被拦（toolPreflightCopy）：`未执行 · <描述>`；无可用描述仍是 `未执行`。
- 中断：终态词只出现一次（前缀），行内为 `运行命令 · <描述>`。

## 不在范围
审批卡片、cron 状态条命令标签、展开明细、host 侧、Bash schema 提示词、分组计数。
