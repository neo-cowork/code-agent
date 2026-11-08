/** 子代理与运行中收紧共用的权限档顺序；未知旧档按 default 处理。 */
const PERMISSION_MODE_RESTRICTIVENESS: Readonly<Record<string, number>> = {
  bypassPermissions: 0,
  acceptEdits: 1,
  default: 2,
  delegate: 3,
  readOnly: 4,
  plan: 5,
  dontAsk: 6,
};

export function moreRestrictivePermissionMode<T extends string>(a: T, b: T): T {
  const aRank = PERMISSION_MODE_RESTRICTIVENESS[a] ?? PERMISSION_MODE_RESTRICTIVENESS.default;
  const bRank = PERMISSION_MODE_RESTRICTIVENESS[b] ?? PERMISSION_MODE_RESTRICTIVENESS.default;
  return aRank >= bRank ? a : b;
}
