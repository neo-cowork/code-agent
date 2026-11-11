// 页面刚加载时 SSE 由最早的一个 on()（如 posthog:identity）拉起，host 的审批快照
// （snapshot:true）比 renderer 的 agent:event 监听器注册早到几十毫秒，httpTransport 的
// dispatchSSEPayload 对「还没有监听器」的通道静默丢弃——后台子代理等着的审批卡因此
// 刷新后永远不出现（N-FIX-BGPANEL-STOP-TERMINAL-FU1-FU1-FU1）。
// 快照在窗口内留一份，补给之后才注册的 agent:event 监听器；host 收卡或用户应答后撤掉。
import { RENDERER_POLLING } from '../../shared/constants';

type SnapshotCallback = (args: unknown) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createPermissionSnapshotRetention() {
  const retained = new Map<string, { args: unknown; at: number }>();
  return {
    /** 看每一条 agent:event：留住未裁决的审批快照，撤掉已被 host 收口的。 */
    observe(args: unknown): void {
      if (!isRecord(args) || args.type !== 'permission_request' || !isRecord(args.data)) return;
      const id = args.data.id;
      if (typeof id !== 'string') return;
      if (args.data.resolved === true) retained.delete(id);
      else if (args.snapshot === true) retained.set(id, { args, at: Date.now() });
    },
    forget(requestId: unknown): void {
      if (typeof requestId === 'string') retained.delete(requestId);
    },
    /** 新的 agent:event 监听器注册时补发窗口内的快照。 */
    replayTo(callback: SnapshotCallback): void {
      const now = Date.now();
      for (const [id, entry] of [...retained]) {
        if (now - entry.at > RENDERER_POLLING.SSE_PERMISSION_SNAPSHOT_REPLAY_WINDOW) retained.delete(id);
        else callback(entry.args);
      }
    },
  };
}
