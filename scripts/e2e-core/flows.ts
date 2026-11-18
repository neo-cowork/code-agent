import { f05, f06 } from './approvalFlows';
import { f07 } from './approvalRunFlow';
import { f10 } from './attachmentFlow';
import { f08 } from './backgroundFlow';
import { f15 } from './cronFlow';
import { f16 } from './longSessionFlow';
import { f17 } from './languageFlow';
import { f09 } from './stopFlow';
import { f14 } from './memoryFlow';
import type { FlowDef } from './types';

// 地图（docs/e2e/feature-map.md）18 条流程全部有归属：
//  - 下面 CORE_FLOW_IDS 里的由本 runner 真跑（真实服务 + dogfood 模型，每晚 3 次）；
//  - SHELL_WEB_FLOWS 依赖 Tauri 壳 / 原生能力，Web 构建跑不了真的，归真机批；
//  - F18 见 NOT_SCRIPTTABLE_FLOWS：引导本身能在隔离 home 出现（产品自带 e2e 钩子），
//    但走完引导后第一条消息在这台 dogfood 中转上必 400，凑不出 3 次绿的样本，证据见证据档。
export const CORE_FLOW_IDS = ['F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F14', 'F15', 'F16', 'F17'];

export const CORE_FLOWS: FlowDef[] = [f05, f06, f07, f08, f09, f10, f14, f15, f16, f17];

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

/**
 * F18（首启引导）在隔离 home 上能出现也能走完（CODE_AGENT_E2E_FORCE_MODEL_ONBOARDING_AFTER
 * 钩子让引导出现；密钥路线验证、默认模型、继续进入聊天、completedAt 落盘都真跑通过），但引导
 * 配出来的 custom（OpenAI 兼容）provider 发第一条消息时，产品对推理模型必带 reasoning_effort，
 * dogfood 中转对该字段一律 400（其余字段全组合实测 200）—— nightly 里只能永远红，收不进
 * CORE_FLOW_IDS。真跑证据（probe 截图 + 请求体抓包 + 走完引导的 result.json）见证据档 F18 节。
 */
export const NOT_SCRIPTTABLE_FLOWS: ReadonlyArray<{ id: string; reason: string }> = [
  { id: 'F18', reason: '引导可出现可走完，但引导后首条消息在 dogfood 中转上必 400（产品对推理模型发 reasoning_effort，中转只拒这个字段），凑不出 3 次绿' },
];
