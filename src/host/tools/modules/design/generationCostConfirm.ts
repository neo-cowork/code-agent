// ============================================================================
// confirmGenerationCost — 会话内成本确认卡（Slice A）
//
// 付费生成（图片/视频/演示稿配图）出图前的「消耗 ¥X，是否继续？」确认。
// 复用 promptUserInChat round-trip，渲染成对话流卡片，不落画布审批条 / 不弹
// window.confirm —— 决策在会话区做，不抢用户焦点（产物仍落画布/预览 tab）。
//
// 文案跟随 UI 语言（FB-1285）：readUiLanguage() 读 ui.language，读不到按中文。
//
// fail-closed：无 renderer / 超时 / abort / 取消 → false，绝不花钱。
// ============================================================================
import type { UserQuestion } from '../../../../shared/contract';
import { formatCny } from '../../../../shared/media/imageCost';
import { promptUserInChat } from '../../utils/userQuestionPrompt';
import { readUiLanguage } from '../../../session/sessionTitleHostPrompt';

/** 媒介键：不再收自由文本中文，zh/en 名词由 MEDIA_COPY 映射（FB-1285）。 */
type CostConfirmMedia = 'image' | 'video' | 'slideImages';

/**
 * 媒介名词表：zh 存裸名词（进「本次生成…」槽位），en 存带单复数冠词的完整短语
 * （进「Generating …」槽位）——slideImages 是复数名词短语，用 these 其余 this。
 */
const MEDIA_COPY: Record<CostConfirmMedia, { zh: string; en: string }> = {
  image: { zh: '图片', en: 'this image' },
  video: { zh: '视频', en: 'this video' },
  slideImages: { zh: '演示稿配图', en: 'these slide images' },
};

interface CostConfirmCopy {
  header: string;
  question: (media: string, cost: string, detailSuffix: string) => string;
  confirmLabel: (cost: string) => string;
  confirmDescription: string;
  cancelLabel: string;
  cancelDescription: string;
  notifyTitle: string;
  /** zh 全角括号，en 半角括号且前置空格。 */
  detailSuffix: (detail: string) => string;
}

const COST_CONFIRM_COPY: Record<'zh' | 'en', CostConfirmCopy> = {
  zh: {
    header: '成本确认',
    question: (media, cost, detailSuffix) => `本次生成${media}将消耗 ${cost}${detailSuffix}，是否继续？`,
    confirmLabel: (cost) => `确认 ${cost}`,
    confirmDescription: '确认并开始生成，将产生上述费用',
    cancelLabel: '取消',
    cancelDescription: '不生成，不产生费用',
    notifyTitle: '生成成本确认',
    detailSuffix: (detail) => `（${detail}）`,
  },
  en: {
    header: 'Cost confirmation',
    question: (media, cost, detailSuffix) => `Generating ${media} will cost ${cost}${detailSuffix}. Continue?`,
    confirmLabel: (cost) => `Confirm ${cost}`,
    confirmDescription: 'Confirm and start generating; the cost above will be charged',
    cancelLabel: 'Cancel',
    cancelDescription: "Don't generate; no charge",
    notifyTitle: 'Generation cost confirmation',
    detailSuffix: (detail) => ` (${detail})`,
  },
};

export interface GenerationCostConfirmInput {
  /** 媒介键（image/video/slideImages），zh/en 名词由 MEDIA_COPY 按 UI 语言映射。 */
  mediaLabel: 'image' | 'video' | 'slideImages';
  /** 预估成本（人民币元），取自共享价表（imageCost/videoCost），禁硬编码。 */
  estCny: number;
  /** 数量/时长等明细，如「2 张」/「2 images」；单位词由调用方按 UI 语言本地化。 */
  detail?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
}

/**
 * 弹出会话内成本确认卡，返回用户是否同意花钱。
 * 仅当用户明确点「确认」才返回 true；其余一律 false（不花钱）。
 * 确认 label 与 header 键在同一次调用内同源生成，答案匹配两种语言下都成立。
 */
export async function confirmGenerationCost(
  input: GenerationCostConfirmInput,
): Promise<boolean> {
  const lang = readUiLanguage();
  const copy = COST_CONFIRM_COPY[lang];
  const cost = formatCny(input.estCny);
  const confirmLabel = copy.confirmLabel(cost);
  const detailSuffix = input.detail ? copy.detailSuffix(input.detail) : '';

  const question: UserQuestion = {
    header: copy.header,
    question: copy.question(MEDIA_COPY[input.mediaLabel][lang], cost, detailSuffix),
    options: [
      { label: confirmLabel, description: copy.confirmDescription },
      { label: copy.cancelLabel, description: copy.cancelDescription },
    ],
  };

  const result = await promptUserInChat([question], {
    sessionId: input.sessionId,
    abortSignal: input.abortSignal,
    notify: { title: copy.notifyTitle, body: question.question },
  });

  if (result.status !== 'answered' || !result.response || result.response.declined) return false;
  const answer = result.response.answers[copy.header];
  const picked = Array.isArray(answer) ? answer[0] : answer;
  return picked === confirmLabel;
}
