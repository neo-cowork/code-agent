import { beforeEach, describe, expect, it, vi } from 'vitest';

const language = vi.hoisted(() => ({ value: 'zh' as string | undefined }));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: language.value } }) }),
}));
vi.mock('../../../src/host/services/auth/authService', () => ({ getAuthService: vi.fn() }));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: vi.fn() }));
vi.mock('../../../src/host/services/infra/supabaseService', () => ({ getSupabase: vi.fn() }));

import {
  ProjectCollaborationError,
  type ProjectCollaborationErrorCode,
} from '../../../src/host/services/project/projectCollaborationService';

const ZH: Record<ProjectCollaborationErrorCode, string> = {
  COLLAB_AUTH_REQUIRED: '请先登录后再使用协同空间。',
  COLLAB_LOCAL_USER_FORBIDDEN: '本地访客身份不能写入云端，请先登录正式账号。',
  COLLAB_OFFLINE: '协同服务当前不可用，请检查网络后重试。',
  COLLAB_FORBIDDEN: '只有空间所有者可以执行此操作。',
  COLLAB_PROJECT_NOT_FOUND: '本地项目不存在或已被删除。',
  COLLAB_NOT_CLOUD_SPACE: '该项目尚未升级或加入云协同空间。',
  COLLAB_INVITE_NOT_FOUND: '邀请码不存在。',
  COLLAB_INVITE_REVOKED: '邀请码已被撤销。',
  COLLAB_INVITE_EXPIRED: '邀请码已过期。',
  COLLAB_INVITE_EXHAUSTED: '邀请码使用次数已达上限。',
  COLLAB_INVALID_ARGS: '协同空间参数无效。',
  COLLAB_SERVICE_ERROR: '协同服务暂时出错，请稍后重试。',
};
const CODES = Object.keys(ZH) as ProjectCollaborationErrorCode[];
const CJK = /[㐀-鿿]/;

describe('ProjectCollaborationError locale', () => {
  beforeEach(() => {
    language.value = 'zh';
  });

  it.each(CODES)('zh: %s keeps the original Chinese text byte-for-byte', (code) => {
    language.value = 'zh';
    const error = new ProjectCollaborationError(code);
    expect(error.message).toBe(ZH[code]);
    expect(error.code).toBe(code);
  });

  it.each(CODES)('en: %s is English without CJK', (code) => {
    language.value = 'en';
    const error = new ProjectCollaborationError(code);
    expect(error.message).not.toMatch(CJK);
    expect(error.message.length).toBeGreaterThan(10);
    expect(error.code).toBe(code);
  });

  it('switching ui.language between two throws changes the text', () => {
    language.value = 'en';
    const en = new ProjectCollaborationError('COLLAB_AUTH_REQUIRED').message;
    language.value = 'zh';
    const zh = new ProjectCollaborationError('COLLAB_AUTH_REQUIRED').message;
    expect(en).toBe('Please sign in before using a collaboration space.');
    expect(zh).toBe('请先登录后再使用协同空间。');
  });

  it('falls back to zh when ui.language is missing', () => {
    language.value = undefined;
    expect(new ProjectCollaborationError('COLLAB_OFFLINE').message).toBe(ZH.COLLAB_OFFLINE);
  });
});
