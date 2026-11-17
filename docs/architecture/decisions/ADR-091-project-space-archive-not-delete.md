# ADR-091：协作空间用「归档」代替「删除」

- 状态：**已接受（方案 B，2026-11-16，爸拍板）**
- 单号：N-FIX-PROJECT-SPACE-DELETE-FAIL-SILENT-FU1

## 背景

只要空间里聊过天（会话有 `conversation_branches` 记录），`ProjectRepository.assignSessionProject` 就会抛 `PROJECT_BOUNDARY_IMMUTABLE`，所以这类空间无法删除：`projectService.deleteProject` 要先把会话挪到「未归类」，这一步被项目边界挡住。#3558 只让失败可见，而空间列表里的确认框仍写着「会话会移到未归类」，与事实不符。用户用完的周常空间清不掉。

## 方案

- 方案 A：放宽 `PROJECT_BOUNDARY_IMMUTABLE`，允许删除时把会话挪走（不采纳：破坏项目/会话隔离边界）
- 方案 B：新增「归档」：空间从列表隐藏，会话保留原归属仍可查看（采纳）
- 方案 C：保留删除，只把失败原因和确认框文案讲清楚（不采纳：用户仍清不掉有聊天的空间）

## 决策

采用方案 B。空间列表行操作里用「归档」替换「删除」；列表页头部在存在归档空间时显示「已归档（N）」入口，归档行有「恢复」。

## 后果

- 归档空间从默认列表隐藏，`projects.status='archived'`，不删任何会话或话题；确认框文案如实说明，不再出现「未归类」。
- 会话保持原项目归属，仍可从侧边栏和会话搜索找到；可在「已归档」视图里恢复。
- 项目/会话隔离边界和 `PROJECT_BOUNDARY_IMMUTABLE` 不变，后端不改（沿用已有 `project.setStatus`）。
- `ProjectSettingsDialog` 里的删除路径本次未改，仍保留原行为；已归档空间不支持永久删除。

## 设计依据

参照 Claude Projects：归档用来整理、收起项目列表；归档项目里的对话仍可访问；在「已归档」标签页查看，并有取消归档操作。ChatGPT Projects 只有连聊天一起删除，社区反复请求「归档 + 恢复」。
