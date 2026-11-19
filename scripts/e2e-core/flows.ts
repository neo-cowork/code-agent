import { f05, f06 } from './approvalFlows';
import { f07 } from './approvalRunFlow';
import { f10 } from './attachmentFlow';
import { f08 } from './backgroundFlow';
import { f15 } from './cronFlow';
import { f16 } from './longSessionFlow';
import { f17 } from './languageFlow';
import { f18 } from './onboardingFlow';
import { f09 } from './stopFlow';
import { f14 } from './memoryFlow';
import type { FlowDef } from './types';

// 地图（docs/e2e/feature-map.md）18 条流程全部有归属：
//  - 下面 CORE_FLOW_IDS 里的由本 runner 真跑（真实服务 + dogfood 模型，每晚 3 次）；
//  - SHELL_WEB_FLOWS 依赖 Tauri 壳 / 原生能力，Web 构建跑不了真的，归真机批。
// F18：隔离 home 上模型已被预配好，引导默认不出现；流程用产品自带的
// CODE_AGENT_E2E_FORCE_MODEL_ONBOARDING_AFTER 钩子让它出现。引导配出的 custom
//（OpenAI 兼容）首条消息若被中转以 400/422 拒绝 reasoning_effort，fetch 层摘掉该字段重试一次。
export const CORE_FLOW_IDS = ['F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F14', 'F15', 'F16', 'F17', 'F18'];

export const CORE_FLOWS: FlowDef[] = [f05, f06, f07, f08, f09, f10, f14, f15, f16, f17, f18];

/** surface: shell 的 7 条：Web 构建跑不了真的，每条一句原因（地图索引的约定）。 */
export const SHELL_WEB_FLOWS: ReadonlyArray<{ id: string; reason: string }> = [
  { id: 'F01', reason: '写系统日历走原生 EventKit，Web 构建没有这条能力' },
  { id: 'F02', reason: '改系统日历走原生 EventKit，Web 构建没有这条能力' },
  { id: 'F03', reason: '删系统日历 + 撤销走原生 EventKit，Web 构建没有这条能力' },
  { id: 'F04', reason: '读系统日历走原生 EventKit，Web 构建没有这条能力' },
  { id: 'F11', reason: '托管浏览器窗口是壳能力，Web 构建跑不了' },
  { id: 'F12', reason: '浏览器人工接管是壳能力，Web 构建跑不了' },
  { id: 'F13', reason: '会议录音要麦克风 / 系统音频采集，Web 构建跑不了' },
];
