// ============================================================================
// 协作空间错误文案（zh/en）
// locale 由 host 侧 getHostUiLocale() 在抛错时读入；code 不变，只换文案。
// ============================================================================
export type ProjectCollaborationErrorLocale = 'zh' | 'en';

export type ProjectCollaborationErrorCode =
  | 'COLLAB_AUTH_REQUIRED'
  | 'COLLAB_LOCAL_USER_FORBIDDEN'
  | 'COLLAB_OFFLINE'
  | 'COLLAB_FORBIDDEN'
  | 'COLLAB_PROJECT_NOT_FOUND'
  | 'COLLAB_NOT_CLOUD_SPACE'
  | 'COLLAB_INVITE_NOT_FOUND'
  | 'COLLAB_INVITE_REVOKED'
  | 'COLLAB_INVITE_EXPIRED'
  | 'COLLAB_INVITE_EXHAUSTED'
  | 'COLLAB_INVALID_ARGS'
  | 'COLLAB_SERVICE_ERROR';

const messages: Record<ProjectCollaborationErrorLocale, Record<ProjectCollaborationErrorCode, string>> = {
  zh: {
    COLLAB_AUTH_REQUIRED: '请先登录后再使用协作空间。',
    COLLAB_LOCAL_USER_FORBIDDEN: '本地访客身份不能写入云端，请先登录正式账号。',
    COLLAB_OFFLINE: '协同服务当前不可用，请检查网络后重试。',
    COLLAB_FORBIDDEN: '只有空间所有者可以执行此操作。',
    COLLAB_PROJECT_NOT_FOUND: '本地项目不存在或已被删除。',
    COLLAB_NOT_CLOUD_SPACE: '该项目尚未升级或加入云协作空间。',
    COLLAB_INVITE_NOT_FOUND: '邀请码不存在。',
    COLLAB_INVITE_REVOKED: '邀请码已被撤销。',
    COLLAB_INVITE_EXPIRED: '邀请码已过期。',
    COLLAB_INVITE_EXHAUSTED: '邀请码使用次数已达上限。',
    COLLAB_INVALID_ARGS: '协作空间参数无效。',
    COLLAB_SERVICE_ERROR: '协同服务暂时出错，请稍后重试。',
  },
  en: {
    COLLAB_AUTH_REQUIRED: 'Please sign in before using a collaboration space.',
    COLLAB_LOCAL_USER_FORBIDDEN: 'A local guest cannot write to the cloud. Please sign in with a full account first.',
    COLLAB_OFFLINE: 'The collaboration service is unavailable right now. Check your network and try again.',
    COLLAB_FORBIDDEN: 'Only the space owner can do this.',
    COLLAB_PROJECT_NOT_FOUND: 'The local project does not exist or has been deleted.',
    COLLAB_NOT_CLOUD_SPACE: 'This project has not been upgraded to, or joined, a cloud collaboration space.',
    COLLAB_INVITE_NOT_FOUND: 'The invite code does not exist.',
    COLLAB_INVITE_REVOKED: 'The invite code has been revoked.',
    COLLAB_INVITE_EXPIRED: 'The invite code has expired.',
    COLLAB_INVITE_EXHAUSTED: 'The invite code has reached its usage limit.',
    COLLAB_INVALID_ARGS: 'Invalid collaboration space arguments.',
    COLLAB_SERVICE_ERROR: 'The collaboration service ran into a problem. Please try again later.',
  },
};

export function getProjectCollaborationErrorMessage(
  locale: ProjectCollaborationErrorLocale,
  code: ProjectCollaborationErrorCode,
): string {
  return messages[locale][code];
}
