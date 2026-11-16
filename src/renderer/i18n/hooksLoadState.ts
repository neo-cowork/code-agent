// ============================================================================
// Hook 设置页「读取失败 / 无权限」词条 —— 独立文件避免 *SettingsWork.ts 撞 max-lines。
// 在 settings.hooks 里 spread 使用。
// ============================================================================

export const hooksLoadStateZh = {
  forbidden: 'Hook 设置需要管理员身份。当前账号没有这个权限，或管理员身份还在验证中。请联系管理员，或换用有管理员权限的账号登录；如果你本人就是管理员，稍等片刻后点「刷新」。',
  loadFailed: '暂时读不到 Hook 设置，请点「刷新」再试一次。',
  actionFailed: '这次操作没有成功，请点「刷新」后再试。',
};

export const hooksLoadStateEn = {
  forbidden: 'Hook settings require an administrator. This account does not have that permission, or administrator status is still being verified. Ask an administrator, or sign in with an administrator account. If you are the administrator, wait a moment and press "Refresh".',
  loadFailed: 'Could not read Hook settings right now. Press "Refresh" to try again.',
  actionFailed: 'That action did not go through. Press "Refresh" and try again.',
};
