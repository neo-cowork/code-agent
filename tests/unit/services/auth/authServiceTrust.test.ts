import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureSupabaseInitialized: vi.fn(),
  isSupabaseInitialized: vi.fn(),
  getSupabase: vi.fn(),
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(),
  },
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clearSessionFromKeychain: vi.fn(),
    clearAuthData: vi.fn(),
    hasAnyPastLoginTrace: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../src/host/platform', () => ({
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  ensureSupabaseInitialized: (settings?: unknown) => mocks.ensureSupabaseInitialized(settings),
  getSupabase: () => mocks.getSupabase(),
  isSupabaseInitialized: () => mocks.isSupabaseInitialized(),
}));

vi.mock('../../../../src/host/services/core', () => ({
  getConfigService: () => ({
    getSettings: () => ({}),
  }),
  getSecureStorage: () => mocks.storage,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

describe('authService session trust', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.isSupabaseInitialized.mockReturnValue(false);
    mocks.ensureSupabaseInitialized.mockImplementation(() => {
      throw new Error('init failed');
    });
    mocks.getSupabase.mockReturnValue(mocks.supabase);
    mocks.supabase.auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    mocks.supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    mocks.supabase.auth.signInWithPassword.mockResolvedValue({ data: { user: null }, error: null });
    mocks.supabase.auth.signOut.mockResolvedValue({ error: null });
    mocks.supabase.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null }),
        }),
      }),
    });
    mocks.storage.clearSessionFromKeychain.mockResolvedValue(undefined);
    mocks.storage.hasAnyPastLoginTrace.mockReturnValue(false);
    mocks.storage.get.mockReturnValue(JSON.stringify({
      id: 'admin-1',
      email: 'admin@example.com',
      isAdmin: true,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats cached users as unverified and clears them on sign out without Supabase', async () => {
    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();

    expect(authService.getCurrentUser()).toMatchObject({
      id: 'admin-1',
      isAdmin: true,
    });
    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: true,
      sessionTrustState: 'cached',
      authBackendAvailable: false,
      hasCachedAdminClaim: true,
      user: {
        id: 'admin-1',
        isAdmin: false,
      },
    });
    expect(authService.getSessionTrustState()).toBe('cached');
    expect(authService.hasVerifiedSession()).toBe(false);

    await authService.signOut();

    expect(mocks.storage.clearSessionFromKeychain).toHaveBeenCalledOnce();
    expect(mocks.storage.clearAuthData).toHaveBeenCalledOnce();
    expect(authService.getCurrentUser()).toBeNull();
    expect(authService.getSessionTrustState()).toBe('none');
  });

  it('keeps cached admin profile after the session is verified when profile fetch fails', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockResolvedValue({
      data: {
        session: {
          user: {
            id: 'admin-1',
            email: 'admin@example.com',
          },
        },
      },
    });
    mocks.supabase.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockRejectedValue(new Error('profile timeout')),
        }),
      }),
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(authService.getSessionTrustState()).toBe('verified');
    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: true,
      sessionTrustState: 'verified',
      authBackendAvailable: true,
      hasCachedAdminClaim: false,
      user: {
        id: 'admin-1',
        isAdmin: true,
      },
    });
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      ' Profile fetch failed; preserving in-memory profile',
    );
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      ' Failed to fetch profile, using basic user:',
      expect.anything(),
    );
  });

  it('keeps startup session validation timeout quiet when a cached user remains available', async () => {
    vi.useFakeTimers();
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {}));

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await vi.advanceTimersByTimeAsync(5000);

    expect(authService.getSessionTrustState()).toBe('cached');
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      ' Background session validation deferred; keeping cached user',
      { errorMessage: 'Session fetch timeout', timeout: true },
    );
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      ' Background session validation failed:',
      expect.anything(),
    );
    // deferred 不降级：登录态保留，不触发 restore-degrade warn
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      'Auth restored login degraded to signed-out',
      expect.anything(),
    );
  });

  it('network error during startup validation defers without downgrade or degrade warn', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockRejectedValue(new Error('socket hang up'));

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(authService.getSessionTrustState()).toBe('cached');
    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: true,
      sessionTrustState: 'cached',
      sessionExpired: false,
    });
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      ' Background session validation deferred; keeping cached user',
      { errorMessage: 'socket hang up', timeout: false },
    );
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      'Auth restored login degraded to signed-out',
      expect.anything(),
    );
  });

  it('verified session restores with no degrade warn (outcome: verified)', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockResolvedValue({
      data: {
        session: {
          user: {
            id: 'admin-1',
            email: 'admin@example.com',
          },
        },
      },
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(authService.revalidateSession()).resolves.toBe('verified');
    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: true,
      sessionTrustState: 'verified',
      sessionExpired: false,
    });
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      'Auth restored login degraded to signed-out',
      expect.anything(),
    );
  });

  it('initializes Supabase lazily when signing in after startup missed it', async () => {
    const profileQuery = {
      select: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'user-2',
          username: 'user',
          nickname: null,
          avatar_url: null,
          is_admin: false,
        },
      }),
    };
    mocks.storage.get.mockReturnValue(undefined);
    mocks.ensureSupabaseInitialized.mockImplementation(() => {
      mocks.isSupabaseInitialized.mockReturnValue(true);
      return mocks.supabase;
    });
    mocks.supabase.from.mockReturnValue(profileQuery);
    mocks.supabase.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: {
          id: 'user-2',
          email: 'user@example.com',
        },
      },
      error: null,
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    const result = await authService.signInWithEmail('user@example.com', 'password');

    expect(mocks.ensureSupabaseInitialized).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      user: {
        id: 'user-2',
        email: 'user@example.com',
      },
    });
    expect(authService.getSessionTrustState()).toBe('verified');
  });

  it('logs sign-in auth failures without credentials', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid login credentials' },
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    const result = await authService.signInWithEmail('user@example.com', 'secret-password');

    expect(result).toEqual({
      success: false,
      error: 'Invalid login credentials',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith('Email sign-in failed', {
      error: 'Invalid login credentials',
    });
    const logged = JSON.stringify(mocks.logger.warn.mock.calls);
    expect(logged).not.toContain('user@example.com');
    expect(logged).not.toContain('secret-password');
  });

  it('曾登录但 session 失效 → 标记 sessionExpired 并清用户（2c/ADR-030，非默默清零）', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    // beforeEach 已设缓存 admin 用户；getSession 返回 null = session 失效/过期
    mocks.supabase.auth.getSession.mockResolvedValue({ data: { session: null } });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等后台验证跑完

    expect(authService.getCurrentUser()).toBeNull();
    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: false,
      sessionExpired: true,
    });
    // FB 03：降级 warn 必须说清根因——getSession 无 session 且无 error
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth restored login degraded to signed-out', {
      reason: 'session_not_restorable',
      hadCachedIdentity: true,
      sessionTrustState: 'cached',
    });
    // Keychain 清除不在这条过期标记路径上。失效 refresh 由 storage adapter 的
    // removeItem 清掉 Keychain；AuthService.signOut() 仍是这里唯一的清除点。
    expect(mocks.storage.clearSessionFromKeychain).not.toHaveBeenCalled();
  });

  it('expired outcome also reachable through revalidateSession after a deferred startup', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockReturnValueOnce(new Promise(() => {})); // 启动后台校验挂起 → deferred
    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    expect(authService.getSessionTrustState()).toBe('cached');

    mocks.supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    await expect(authService.revalidateSession()).resolves.toBe('expired');

    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: false,
      sessionExpired: true,
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth restored login degraded to signed-out', {
      reason: 'session_not_restorable',
      hadCachedIdentity: true,
      sessionTrustState: 'cached',
    });
  });

  it('no cached identity + no session → outcome no-session with no degrade warn', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.storage.get.mockReturnValue(undefined);
    mocks.storage.hasAnyPastLoginTrace.mockReturnValue(false); // 从未登录过的机器
    mocks.supabase.auth.getSession.mockResolvedValue({ data: { session: null } });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(authService.revalidateSession()).resolves.toBe('no-session');
    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: false,
      sessionExpired: false,
    });
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      'Auth restored login degraded to signed-out',
      expect.anything(),
    );
  });

  it('cached user missing while past login traces exist → warn reason cached_user_missing', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.storage.get.mockReturnValue(undefined);
    mocks.storage.hasAnyPastLoginTrace.mockReturnValue(true); // 有历史 session 键/记住密码，但 auth.user 没了
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {})); // 挂起后台校验，隔离缓存路径

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();

    expect(authService.getCurrentUser()).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth restored login degraded to signed-out', {
      reason: 'cached_user_missing',
    });
  });

  it('cached user with wrong shape → warn reason cached_user_invalid', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.storage.get.mockReturnValue(JSON.stringify({ id: 'admin-1' })); // 缺 email，形状不对
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {}));

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();

    expect(authService.getCurrentUser()).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth restored login degraded to signed-out', {
      reason: 'cached_user_invalid',
    });
  });

  it('cached user read throwing → warn reason cached_user_read_error with error message', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.storage.get.mockImplementation(() => {
      throw new Error('cache boom');
    });
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {}));

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();

    expect(authService.getCurrentUser()).toBeNull();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      ' Failed to load cached user:',
      expect.any(Error),
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth restored login degraded to signed-out', {
      reason: 'cached_user_read_error',
      errorMessage: 'cache boom',
    });
  });

  it('Supabase not ready at initialize with cached identity → warn reason auth_backend_unavailable', async () => {
    // beforeEach 默认：isSupabaseInitialized false + ensureSupabaseInitialized 抛错；缓存 admin 用户在
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {}));

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();

    expect(authService.getSessionTrustState()).toBe('cached');
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth restored login degraded to signed-out', {
      reason: 'auth_backend_unavailable',
      hadCachedIdentity: true,
    });
  });

  it('getSession error with cached identity → warn reason get_session_error with message and numeric status', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'boom', status: 400 },
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(authService.getCurrentUser()).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth restored login degraded to signed-out', {
      reason: 'get_session_error',
      hadCachedIdentity: true,
      sessionTrustState: 'cached',
      errorMessage: 'boom',
      status: 400,
    });
  });

  it('从未登录（无缓存用户）+ session 失效 → 不标记 sessionExpired（不打扰）', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.storage.get.mockReturnValue(undefined); // 无缓存用户
    mocks.supabase.auth.getSession.mockResolvedValue({ data: { session: null } });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: false,
      sessionExpired: false,
    });
  });

  // 回归（dogfood 实测发现）：真实 supabase 启动时以 INITIAL_SESSION + 空 session 触发
  // onAuthStateChange，这才是"默默清零"的主路径。旧 mock 从不触发回调，漏掉了它。
  it('onAuthStateChange: INITIAL_SESSION 空 session + 缓存身份 → sessionExpired（2c 主路径）', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {})); // 挂起后台验证，隔离回调路径
    let cb: ((event: string, session: unknown) => Promise<void>) | undefined;
    mocks.supabase.auth.onAuthStateChange.mockImplementation((fn: typeof cb) => {
      cb = fn;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    expect(cb).toBeDefined();
    await cb!('INITIAL_SESSION', null);

    expect(authService.getCurrentUser()).toBeNull();
    await expect(authService.getStatus()).resolves.toMatchObject({ sessionExpired: true });
    // FB 03：warn 必须携带 event 与 explicitSignOut，空 session 事件才可归因
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth restored login degraded to signed-out', {
      reason: 'empty_session_event',
      event: 'INITIAL_SESSION',
      explicitSignOut: false,
      hadCachedIdentity: true,
      sessionExpired: true,
    });
  });

  it('onAuthStateChange: SIGNED_OUT（非本机主动退出）→ sessionExpired', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {}));
    let cb: ((event: string, session: unknown) => Promise<void>) | undefined;
    mocks.supabase.auth.onAuthStateChange.mockImplementation((fn: typeof cb) => {
      cb = fn;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await cb!('SIGNED_OUT', null);

    await expect(authService.getStatus()).resolves.toMatchObject({ sessionExpired: true });
    // 同上：SIGNED_OUT 回调只标记 sessionExpired，不碰 Keychain。
    expect(mocks.storage.clearSessionFromKeychain).not.toHaveBeenCalled();
  });

  it('本机主动退出使用 local scope，SIGNED_OUT 回调不标记 sessionExpired', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {}));
    let cb: ((event: string, session: unknown) => Promise<void>) | undefined;
    mocks.supabase.auth.onAuthStateChange.mockImplementation((fn: typeof cb) => {
      cb = fn;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    mocks.supabase.auth.signOut.mockImplementation(async () => {
      await cb!('SIGNED_OUT', null);
      return { error: null };
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await authService.signOut();

    expect(mocks.supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.storage.clearSessionFromKeychain).toHaveBeenCalledOnce();
    await expect(authService.getStatus()).resolves.toMatchObject({ sessionExpired: false });
    expect(mocks.logger.info).toHaveBeenCalledWith(' Explicit sign-out requested');
    expect(mocks.logger.info).toHaveBeenCalledWith(' Explicit sign-out confirmed by auth state change');
    // 主动退出也走 empty_session_event warn，但 explicitSignOut=true 让日志可分辨
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth restored login degraded to signed-out', {
      reason: 'empty_session_event',
      event: 'SIGNED_OUT',
      explicitSignOut: true,
      hadCachedIdentity: true,
      sessionExpired: false,
    });
  });

  it('degrade warn arguments never contain the cached email or token strings', async () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-signature';
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.storage.get.mockReturnValue(JSON.stringify({
      id: 'admin-1',
      email: 'victim@example.com',
      nickname: token,
    }));
    mocks.supabase.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'refresh rejected', status: 401 },
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authService.revalidateSession();

    // 触发过 get_session_error 降级（含 error message / status 字段）
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Auth restored login degraded to signed-out',
      expect.objectContaining({ reason: 'get_session_error' }),
    );

    // 序列化全部日志调用：不得出现 email / token
    const logged = JSON.stringify([
      mocks.logger.info.mock.calls,
      mocks.logger.warn.mock.calls,
      mocks.logger.error.mock.calls,
      mocks.logger.debug.mock.calls,
    ]);
    expect(logged).not.toContain('victim@example.com');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('super-secret-signature');
  });
});
