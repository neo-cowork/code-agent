// ============================================================================
// Cron event chat names (N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN)
// ----------------------------------------------------------------------------
// 事件 run 的可读目标：把 replyTargets 里的平台会话 id 解析成群名（决策台账 /
// 审批卡 / 观察行都用群名，不裸奔 oc_/ou_ 原始 id）。通道入站事件本身不带群名
// （飞书 im.message.receive_v1 无 chat_name），这里按账号从通道的会话目录解析，
// 带进程内 TTL 缓存——事件 run 可能高频，不能每 run 全量拉目录。
// 解析失败 fail-open：返回空表，调用方回落原始会话 id（可读性降级，不阻断回复）。
// ============================================================================

import type { CronEventReplyTarget } from '../../shared/contract/cron';

/** 会话目录缓存有效期：过长会让改名滞后，过短会让事件 run 频繁打目录 API。 */
const CHAT_NAME_CACHE_TTL_MS = 10 * 60 * 1000;

interface ChatNameCacheEntry {
  /** chatId → 群名 的快照。 */
  names: ReadonlyMap<string, string>;
  fetchedAt: number;
  /** 在途请求：并发 run 共用一次目录拉取。 */
  inflight?: Promise<ReadonlyMap<string, string>>;
}

const cacheByAccount = new Map<string, ChatNameCacheEntry>();

async function fetchChatNames(accountId: string): Promise<ReadonlyMap<string, string>> {
  const { getChannelManager } = await import('../channels/channelManager');
  const channel = getChannelManager().getActiveChannel(accountId);
  if (!channel?.listConversations) return new Map();
  const conversations = await channel.listConversations();
  return new Map(conversations.map((conversation) => [conversation.id, conversation.name]));
}

/**
 * 解析一批 replyTargets 涉及的会话名：命中缓存直接用，未命中（且缓存过期）拉一次
 * 会话目录。任何失败都吞成空表（fail-open）——名字只是展示位，不值得拖垮 run。
 */
async function resolveEventChatNames(
  accountId: string,
  chatIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(chatIds)];
  if (wanted.length === 0) return new Map();
  const now = Date.now();
  const cached = cacheByAccount.get(accountId);
  if (cached && now - cached.fetchedAt < CHAT_NAME_CACHE_TTL_MS) {
    return new Map(wanted.flatMap((chatId) => {
      const name = cached.names.get(chatId);
      return name ? [[chatId, name]] : [];
    }));
  }
  if (cached?.inflight) {
    const names = await cached.inflight;
    return new Map(wanted.flatMap((chatId) => {
      const name = names.get(chatId);
      return name ? [[chatId, name]] : [];
    }));
  }
  const inflight = fetchChatNames(accountId)
    .then((names) => {
      cacheByAccount.set(accountId, { names, fetchedAt: Date.now() });
      return names;
    })
    .catch((error) => {
      // fail-open：解析失败只留痕，目标回落原始会话 id。
      console.warn(`[CronEventChatNames] chat directory lookup failed for account ${accountId}:`, error);
      cacheByAccount.set(accountId, { names: new Map(), fetchedAt: Date.now() });
      return new Map<string, string>() as ReadonlyMap<string, string>;
    })
    .finally(() => {
      const entry = cacheByAccount.get(accountId);
      if (entry?.inflight === inflight) entry.inflight = undefined;
    });
  cacheByAccount.set(accountId, { names: cached?.names ?? new Map(), fetchedAt: cached?.fetchedAt ?? 0, inflight });
  const names = await inflight;
  return new Map(wanted.flatMap((chatId) => {
    const name = names.get(chatId);
    return name ? [[chatId, name]] : [];
  }));
}

/** 就地补齐 replyTargets 缺失的群名（已有名字的不覆盖）。 */
export async function enrichReplyTargetChatNames(
  accountId: string,
  targets: readonly CronEventReplyTarget[],
): Promise<CronEventReplyTarget[]> {
  const missing = targets.filter((target) => !target.chatName?.trim()).map((target) => target.chatId);
  if (missing.length === 0) return [...targets];
  const names = await resolveEventChatNames(accountId, missing);
  if (names.size === 0) return [...targets];
  return targets.map((target) => {
    const name = !target.chatName?.trim() ? names.get(target.chatId) : undefined;
    return name ? { ...target, chatName: name } : target;
  });
}

/** 账号显示名缓存（决策台账「命中规则」的账号位不裸奔内部 UUID）。 */
const accountNameCache = new Map<string, { name?: string; fetchedAt: number }>();

/**
 * 解析通道账号的用户可见名（账户列表里配置的 name）。失败/缺名回落 accountId。
 * 与群名同一条 fail-open 原则：名字只是展示位。
 */
export async function resolveEventAccountName(accountId: string): Promise<string> {
  const cached = accountNameCache.get(accountId);
  if (cached && Date.now() - cached.fetchedAt < CHAT_NAME_CACHE_TTL_MS) return cached.name ?? accountId;
  try {
    const { getChannelManager } = await import('../channels/channelManager');
    const account = getChannelManager().getAllAccounts().find((candidate) => candidate.id === accountId);
    const name = account?.name?.trim() || undefined;
    accountNameCache.set(accountId, { name, fetchedAt: Date.now() });
    return name ?? accountId;
  } catch (error) {
    console.warn(`[CronEventChatNames] account name lookup failed for ${accountId}:`, error);
    accountNameCache.set(accountId, { name: undefined, fetchedAt: Date.now() });
    return accountId;
  }
}
