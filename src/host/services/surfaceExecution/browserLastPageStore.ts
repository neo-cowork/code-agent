import { createHash } from 'node:crypto';
import { getSecureStorage } from '../core/secureStorage';
import type { BrowserService } from '../infra/browserService';

const LAST_PAGE_SLOT_PREFIX = 'browser-last-page:';
const MIN_TOKEN_SEGMENT_LENGTH = 24;

interface SecureKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface BrowserLastPageLogger {
  info?(message: string, metadata?: unknown): void;
  warn?(message: string, metadata?: unknown): void;
}

export interface BrowserLastPageStore {
  recordForConversation(conversationId: string, rawUrl: string | null | undefined): Promise<void>;
  getForConversation(conversationId: string): Promise<string | null>;
  clearConversation(conversationId: string): Promise<void>;
  activateConversation(conversationId: string): void;
}

function createEphemeralKeyValueStore(): SecureKeyValueStore {
  const entries = new Map<string, string>();
  return {
    async getItem(key: string) {
      return entries.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      entries.set(key, value);
    },
    async removeItem(key: string) {
      entries.delete(key);
    },
  };
}

function conversationHash(conversationId: string): string {
  return createHash('sha256').update(conversationId).digest('hex');
}

function isTokenLikeSegment(rawSegment: string): boolean {
  if (!rawSegment) return false;
  let decoded = rawSegment;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    // Keep raw segment if percent-encoding is malformed.
  }
  const candidates = decoded === rawSegment ? [rawSegment] : [rawSegment, decoded];
  for (const candidate of candidates) {
    for (const run of candidate.split(/[^A-Za-z0-9._~+-]+/)) {
      if (
        run.length >= MIN_TOKEN_SEGMENT_LENGTH
        && /[A-Za-z]/.test(run)
        && /\d/.test(run)
      ) {
        return true;
      }
    }
  }
  return false;
}

function sanitizeLastPageUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (!parsed.origin || parsed.origin === 'null') {
    return null;
  }
  for (const segment of parsed.pathname.split('/')) {
    if (isTokenLikeSegment(segment)) {
      return null;
    }
  }
  return `${parsed.origin}${parsed.pathname}`;
}

export class SecureBrowserLastPageStore implements BrowserLastPageStore {
  private readonly secureStorage: SecureKeyValueStore;
  private readonly inactiveConversations = new Set<string>();

  constructor(options: { secureStorage?: SecureKeyValueStore; ephemeral?: boolean } = {}) {
    this.secureStorage = options.secureStorage
      ?? (options.ephemeral ? createEphemeralKeyValueStore() : getSecureStorage());
  }

  async recordForConversation(
    conversationId: string,
    rawUrl: string | null | undefined,
  ): Promise<void> {
    if (typeof rawUrl !== 'string') return;
    // Deleted/reset conversation: a run still releasing its window must not resurrect the record.
    if (this.inactiveConversations.has(conversationId)) return;
    const sanitized = sanitizeLastPageUrl(rawUrl);
    const slot = this.slot(conversationId);
    if (sanitized) {
      await this.secureStorage.setItem(slot, sanitized);
    } else {
      await this.secureStorage.removeItem(slot);
    }
  }

  async getForConversation(conversationId: string): Promise<string | null> {
    const slot = this.slot(conversationId);
    const stored = await this.secureStorage.getItem(slot);
    if (!stored) return null;
    const sanitized = sanitizeLastPageUrl(stored);
    if (!sanitized) {
      await this.secureStorage.removeItem(slot);
      return null;
    }
    return sanitized;
  }

  async clearConversation(conversationId: string): Promise<void> {
    this.inactiveConversations.add(conversationId);
    await this.secureStorage.removeItem(this.slot(conversationId));
  }

  activateConversation(conversationId: string): void {
    this.inactiveConversations.delete(conversationId);
  }

  private slot(conversationId: string): string {
    return `${LAST_PAGE_SLOT_PREFIX}${conversationHash(conversationId)}`;
  }
}

export async function restoreManagedBrowserLastPage(input: {
  conversationId: string;
  conversationIdHash: string;
  browserService: Pick<BrowserService, 'navigate'>;
  store: BrowserLastPageStore;
  logger?: BrowserLastPageLogger;
}): Promise<boolean> {
  let targetUrl: string | null;
  try {
    targetUrl = await input.store.getForConversation(input.conversationId);
  } catch (error) {
    input.logger?.warn?.('Failed to read managed browser last page; continuing on blank page', {
      reason: 'last_page_read_failed',
      conversationIdHash: input.conversationIdHash,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!targetUrl) return false;
  try {
    await input.browserService.navigate(targetUrl);
    input.logger?.info?.('Restored managed browser last page', {
      reason: 'last_page_restored',
      conversationIdHash: input.conversationIdHash,
      url: targetUrl,
    });
    return true;
  } catch (error) {
    input.logger?.warn?.('Failed to navigate to managed browser last page; continuing on blank page', {
      reason: 'last_page_navigation_failed',
      conversationIdHash: input.conversationIdHash,
      url: targetUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
