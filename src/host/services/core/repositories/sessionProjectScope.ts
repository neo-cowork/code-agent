// ============================================================================
// 跨会话搜索的「本项目」范围 —— 主机在 SQL 层按项目描述符过滤整库，
// 不再依赖渲染端已加载（侧栏最新 50 条）的会话 id 列表。
// 语义与渲染端 getProjectSearchKey 一致：有 projectId 按 project_id；否则按 working_directory，
// 且只命中没有 project_id 的会话（同一目录下归属别的项目的会话不算本项目）。
// ============================================================================

import type { CrossSessionSearchProjectScope } from '../../../../shared/ipc/types';

/** 追加「本项目」条件到 sessions 别名 `s` 上；scope 为空/无有效描述符时不加条件。 */
export function pushProjectScopeCondition(
  conditions: string[],
  params: unknown[],
  scope: CrossSessionSearchProjectScope | undefined,
): void {
  const projectId = scope?.projectId?.trim();
  if (projectId) {
    conditions.push('s.project_id = ?');
    params.push(projectId);
    return;
  }
  const workingDirectory = scope?.workingDirectory?.trim();
  if (workingDirectory) {
    conditions.push("COALESCE(s.project_id, '') = '' AND s.working_directory = ?");
    params.push(workingDirectory);
  }
}
