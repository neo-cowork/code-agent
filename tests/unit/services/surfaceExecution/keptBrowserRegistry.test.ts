import { describe, expect, it, vi } from 'vitest';
import { BrowserService } from '../../../../src/host/services/infra/browserService';
import {
  KeptBrowserRegistry,
  type KeptBrowserPoolFacade,
} from '../../../../src/host/services/surfaceExecution/keptBrowserRegistry';

function createFakePool() {
  const released: string[] = [];
  const keptFlags = new Map<string, boolean>();
  const pool: KeptBrowserPoolFacade = {
    isServiceAlive: vi.fn(() => true),
    setKept: vi.fn((key: string, kept: boolean) => keptFlags.set(key, kept)),
    releaseAgent: vi.fn(async (key: string) => {
      released.push(key);
    }),
  };
  return { pool, released, keptFlags };
}

function createFakeService() {
  const listeners = new Set<(reason: string) => void>();
  return {
    onSessionChanged: vi.fn((listener: (reason: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit: (reason: string) => {
      for (const listener of listeners) listener(reason);
    },
    listenerCount: () => listeners.size,
  };
}

function baseInput(overrides: Partial<{ conversationId: string; serviceKey: string; url: string }> = {}) {
  return {
    conversationId: overrides.conversationId ?? 'conversation-a',
    serviceKey: overrides.serviceKey ?? 'surface-key-1',
    url: overrides.url ?? 'https://example.test/result',
    title: 'Result',
    browserService: createFakeService(),
  };
}

describe('KeptBrowserRegistry (N-BROWSER-KEEP-RESULT-PAGE)', () => {
  it('keeps result and human-wait lifecycles independent, including shared services', () => {
    const { pool, released, keptFlags } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    const result = baseInput();
    registry.register(result);
    registry.register({ ...result, parkedForUser: true });
    registry.unpark(result.conversationId);
    expect(keptFlags.get(result.serviceKey)).toBe(true);
    expect(registry.snapshot(result.conversationId).state).toBe('kept');
    registry.register({ ...result, parkedForUser: true });
    const replacement = baseInput({ serviceKey: 'new-result' });
    registry.register(replacement);
    expect(released).toEqual([]);
    expect(registry.getParkedAlive(result.conversationId)?.serviceKey).toBe(result.serviceKey);
    result.browserService.emit('close');
    expect(released).toEqual([result.serviceKey]);
    expect(registry.getParkedAlive(result.conversationId)).toBeNull();
    expect(registry.snapshot(result.conversationId).state).toBe('kept');
    replacement.browserService.emit('crashed');
    expect(released).toEqual([result.serviceKey, replacement.serviceKey]);
    expect(registry.snapshot(result.conversationId).state).toBe('closed');
  });

  it('replaces only the parked window and closes shared slots exactly once', () => {
    const { pool, released } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    const result = baseInput();
    const parked = baseInput({ serviceKey: 'parked' });
    registry.register(result);
    registry.register({ ...parked, parkedForUser: true });
    registry.register({ ...result, parkedForUser: true });
    expect(released).toEqual(['parked']);
    result.browserService.emit('close');
    expect(released).toEqual(['parked', result.serviceKey]);
    expect(registry.getAlive(result.conversationId)).toBeNull();
    expect(registry.snapshot(result.conversationId).state).toBe('closed');
  });

  it('registers a kept entry and reports the three-state snapshot', () => {
    const { pool } = createFakePool();
    const registry = new KeptBrowserRegistry(pool, () => 1000);
    const input = baseInput();

    const entry = registry.register(input);

    expect(entry).toEqual({
      conversationId: 'conversation-a',
      serviceKey: 'surface-key-1',
      url: 'https://example.test/result',
      title: 'Result',
      keptAt: 1000,
      state: 'kept',
    });
    expect(registry.get('conversation-a')?.serviceKey).toBe('surface-key-1');
    expect(registry.isKeptServiceAlive('surface-key-1')).toBe(true);
    expect(registry.isKeptServiceAlive('surface-other')).toBe(false);
    expect(registry.get('conversation-a')).toMatchObject({
      state: 'kept',
      url: 'https://example.test/result',
      title: 'Result',
    });
    expect(registry.get('conversation-b')).toBeNull();
    expect(pool.setKept).toHaveBeenCalledWith('surface-key-1', true);
  });

  it('flips the entry to closed (URL remembered) on the service close/crashed event and frees the pool slot', () => {
    const { pool, released } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    const input = baseInput();
    registry.register(input);

    input.browserService.emit('page_load');
    expect(registry.get('conversation-a')?.state).toBe('kept');

    input.browserService.emit('close');
    expect(registry.get('conversation-a')?.state).toBe('closed');
    expect(registry.get('conversation-a')).toMatchObject({
      state: 'closed',
      url: 'https://example.test/result',
      title: 'Result',
    });
    expect(released).toEqual(['surface-key-1']);
    expect(pool.setKept).toHaveBeenCalledWith('surface-key-1', false);

    input.browserService.emit('crashed');
    expect(registry.get('conversation-a')?.state).toBe('closed');
  });

  it('a newer keep closes the older kept window (one kept window per conversation)', () => {
    const { pool, released } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    const first = baseInput({ serviceKey: 'surface-key-1' });
    registry.register(first);
    const second = baseInput({ serviceKey: 'surface-key-2', url: 'https://example.test/next' });
    registry.register(second);

    expect(released).toEqual(['surface-key-1']);
    // 旧窗的 close 事件不会把新条目翻 closed（serviceKey 捕获在注册时）。
    first.browserService.emit('close');
    expect(registry.get('conversation-a')?.serviceKey).toBe('surface-key-2');
    expect(registry.get('conversation-a')).toMatchObject({
      state: 'kept',
      url: 'https://example.test/next',
      title: 'Result',
    });
  });

  it('re-keeping the same service refreshes url/title without closing the window', () => {
    const { pool } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    const service = createFakeService();
    registry.register({
      conversationId: 'conversation-a',
      serviceKey: 'surface-key-1',
      url: 'https://example.test/before',
      title: 'Before',
      browserService: service,
    });

    registry.register({
      conversationId: 'conversation-a',
      serviceKey: 'surface-key-1',
      url: 'https://example.test/after',
      title: 'After',
      browserService: service,
    });

    expect(registry.get('conversation-a')?.url).toBe('https://example.test/after');
    expect(pool.releaseAgent).not.toHaveBeenCalled();
    expect(service.listenerCount()).toBe(1);
  });

  it('refreshTarget updates a kept entry only (final URL at run release)', () => {
    const registry = new KeptBrowserRegistry(createFakePool().pool);
    const input = baseInput();
    registry.register(input);

    registry.refreshTarget('conversation-a', 'https://example.test/final', 'Final');
    expect(registry.get('conversation-a')).toMatchObject({
      url: 'https://example.test/final',
      title: 'Final',
    });

    input.browserService.emit('close');
    registry.refreshTarget('conversation-a', 'https://example.test/ignored', 'Ignored');
    expect(registry.get('conversation-a')).toMatchObject({
      url: 'https://example.test/final',
    });
  });

  it('markClosed on a stale entry (window dead without close event) frees the pool slot', () => {
    const { pool, released } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    registry.register(baseInput());

    registry.markClosed('conversation-a');

    expect(registry.get('conversation-a')?.state).toBe('closed');
    expect(registry.get('conversation-a')?.state).toBe('closed');
    expect(released).toEqual(['surface-key-1']);
    registry.markClosed('conversation-a');
    expect(released).toEqual(['surface-key-1']);
  });

  it('kept windows from different conversations coexist', () => {
    const registry = new KeptBrowserRegistry(createFakePool().pool);
    registry.register(baseInput({ conversationId: 'conversation-a', serviceKey: 'surface-key-a' }));
    registry.register(baseInput({ conversationId: 'conversation-b', serviceKey: 'surface-key-b' }));

    expect(registry.get('conversation-a')?.serviceKey).toBe('surface-key-a');
    expect(registry.get('conversation-b')?.serviceKey).toBe('surface-key-b');
  });

  it('getAlive returns the entry only while kept, null once closed or absent', () => {
    const registry = new KeptBrowserRegistry(createFakePool().pool);
    expect(registry.getAlive('conversation-a')).toBeNull();

    const input = baseInput();
    registry.register(input);
    expect(registry.getAlive('conversation-a')?.serviceKey).toBe('surface-key-1');

    input.browserService.emit('close');
    expect(registry.getAlive('conversation-a')).toBeNull();
    expect(registry.get('conversation-a')?.state).toBe('closed');
  });

  it('snapshot reports the IPC three states: none / kept / closed with url+title', () => {
    const registry = new KeptBrowserRegistry(createFakePool().pool);
    expect(registry.snapshot('conversation-a')).toEqual({ state: 'none', url: null, title: null });

    const input = baseInput();
    registry.register(input);
    expect(registry.snapshot('conversation-a')).toEqual({
      state: 'kept',
      url: 'https://example.test/result',
      title: 'Result',
    });

    input.browserService.emit('close');
    expect(registry.snapshot('conversation-a')).toEqual({
      state: 'closed',
      url: 'https://example.test/result',
      title: 'Result',
    });
  });

  it('FU2: 进程死掉且没有 close/crashed 事件时，读取侧（snapshot/getAlive）按活性探针当场翻 closed', () => {
    const { pool, released } = createFakePool();
    let alive = true;
    pool.isServiceAlive = vi.fn(() => alive);
    const registry = new KeptBrowserRegistry(pool);
    registry.register(baseInput());

    alive = false;
    expect(registry.snapshot('conversation-a')).toEqual({
      state: 'closed',
      url: 'https://example.test/result',
      title: 'Result',
    });
    expect(registry.getAlive('conversation-a')).toBeNull();
    expect(released).toEqual(['surface-key-1']);
  });

  it('FU2: 活窗读取仍返回 kept，不释放窗口', () => {
    const { pool } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    registry.register(baseInput());

    expect(registry.snapshot('conversation-a').state).toBe('kept');
    expect(registry.getAlive('conversation-a')?.serviceKey).toBe('surface-key-1');
  });
});

function serviceState({ connected = true, open = true, processHandle = null }: {
  connected?: boolean;
  open?: boolean;
  processHandle?: { pid?: number; exitCode: number | null; signalCode: string | null } | null;
} = {}) {
  const service = Object.create(BrowserService.prototype) as BrowserService;
  Reflect.set(service, 'browser', { isConnected: () => connected });
  Reflect.set(service, 'context', { pages: () => [{ isClosed: () => !open }] });
  Reflect.set(service, 'browserProcess', processHandle);
  return service;
}

describe('kept window liveness across managed browser providers', () => {
  it('keeps a connected bundled Playwright window without a child process handle', () => {
    expect(serviceState().isProcessAlive()).toBe(true);
  });
  it('rejects disconnected browsers and closed pages', () => {
    expect(serviceState({ connected: false }).isProcessAlive()).toBe(false);
    expect(serviceState({ open: false }).isProcessAlive()).toBe(false);
  });
  it('rejects exited or unspawned system Chrome without probing unrelated processes', () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      expect(serviceState({ processHandle: { exitCode: 1, signalCode: null, pid: 123 } }).isProcessAlive()).toBe(false);
      expect(serviceState({ processHandle: { exitCode: null, signalCode: null } }).isProcessAlive()).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });
  it('checks the recorded Chrome pid when cached references survive process death', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    try {
      expect(serviceState({ processHandle: { exitCode: null, signalCode: null, pid: 123 } }).isProcessAlive()).toBe(false);
      expect(kill).toHaveBeenCalledWith(123, 0);
    } finally { kill.mockRestore(); }
  });
});
