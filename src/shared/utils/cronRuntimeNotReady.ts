// 启动后 agent 运行时迟迟没就绪的固定报文（N-FIX-CRON-START-ORCHESTRATOR-NOT-READY）。
// 失败分类靠「文本里含这句」识别 runtime_starting；句子是唯一判据，改字必须连着分类与测试一起动。

export const CRON_RUNTIME_NOT_READY_MESSAGE_EN =
  'Neo was still starting up, so this run could not start.';

export function isCronRuntimeNotReadyError(text: string): boolean {
  return text.includes(CRON_RUNTIME_NOT_READY_MESSAGE_EN);
}
