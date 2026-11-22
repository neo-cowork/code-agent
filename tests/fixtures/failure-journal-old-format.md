---
name: failure-journal
description: 跨会话失败模式日志（自动沉淀，1 条），新会话注入避免重复踩坑
type: failure-journal
source: learning-pipeline
---

> 自动从 telemetry 提取的重复失败模式（同一模式 ≥3 次）。
> 新会话执行同类操作前先检查这里，避免重复踩坑。

## Write · unknown

- **模式**: 无法保存文件
- **累计次数**: 3（跨 1 个 session）
- **最近出现**: 1970-01-01
- **错误样本**: 无法保存文件


<!-- FAILURE_JOURNAL_JSON: [{"key":"Write:unknown:无法保存文件","toolName":"Write","errorCategory":"unknown","pattern":"无法保存文件","count":3,"sessions":["session-1"],"firstSeen":1000,"lastSeen":2000,"sampleError":"无法保存文件"}] -->
