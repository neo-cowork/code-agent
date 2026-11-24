// 聊天图片批注：把用户在图上框出的区域，转成「编号 + 人话方位 + 百分比框 + 评论」的消息文本，
// 以及走现有 appshot 附件链路的 capture。纯函数，UI 只负责采集矩形与评论。

import type { AppshotCapture } from '@shared/contract/appshot';
import { interpolate } from '../i18n/interpolate';

/** 显示空间（像素）里用户拖出的矩形；w/h 允许为负（反向拖拽）或越出图片。 */
export interface ChatImageAnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 相对整张图的百分比框（整数，0–100，left<=right, top<=bottom）。 */
export interface RegionPercentBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ChatImageAnnotationRegion {
  /** 1-based 显示编号 */
  index: number;
  box: RegionPercentBox;
  comment: string;
}

/** 文案由 i18n 传入（zh/en），本文件不含任何用户可见字面量。 */
export interface ChatImageAnnotationCopy {
  /** 3x3 方位词：[上|中|下][左|中|右] */
  positionGrid: readonly (readonly string[])[];
  /** 整张图 / 横跨整行 / 贯穿整列 */
  positionWhole: string;
  positionWideBand: string;
  positionTallBand: string;
  /** 含 {count} */
  messageHeader: string;
  /** 含 {n} {position} {x1} {x2} {y1} {y2} {comment} */
  regionLine: string;
  noComment: string;
  /** 含 {note} */
  noteLine: string;
  /** 附件卡片名（用户在气泡里看得到） */
  captureName: string;
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

export function toRegionPercentBox(
  rect: ChatImageAnnotationRect,
  displayW: number,
  displayH: number,
): RegionPercentBox {
  const x1 = Math.min(rect.x, rect.x + rect.w);
  const x2 = Math.max(rect.x, rect.x + rect.w);
  const y1 = Math.min(rect.y, rect.y + rect.h);
  const y2 = Math.max(rect.y, rect.y + rect.h);
  return {
    left: Math.round(clampPercent((x1 / displayW) * 100)),
    top: Math.round(clampPercent((y1 / displayH) * 100)),
    right: Math.round(clampPercent((x2 / displayW) * 100)),
    bottom: Math.round(clampPercent((y2 / displayH) * 100)),
  };
}

function gridIndex(centerPercent: number): 0 | 1 | 2 {
  if (centerPercent < 100 / 3) return 0;
  if (centerPercent < 200 / 3) return 1;
  return 2;
}

/** 框 → 人话方位（九宫格位置；很宽/很高的框改说「横跨/贯穿」）。 */
function describeRegionPosition(box: RegionPercentBox, copy: ChatImageAnnotationCopy): string {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (width >= 90 && height >= 90) return copy.positionWhole;
  const row = gridIndex((box.top + box.bottom) / 2);
  const col = gridIndex((box.left + box.right) / 2);
  if (width >= 80) return `${copy.positionGrid[row][1]} ${copy.positionWideBand}`.trim();
  if (height >= 80) return `${copy.positionGrid[1][col]} ${copy.positionTallBand}`.trim();
  return copy.positionGrid[row][col];
}

/** interpolate 底层是 String#replace：用户文字里的 $& $' $` 会被当替换模式改写，这里把 $ 转义成字面量。 */
function literal(text: string): string {
  return text.replace(/\$/g, '$$$$');
}

function buildRegionList(regions: ChatImageAnnotationRegion[], copy: ChatImageAnnotationCopy): string {
  return regions
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((region) => interpolate(copy.regionLine, {
      n: region.index,
      position: describeRegionPosition(region.box, copy),
      x1: region.box.left,
      x2: region.box.right,
      y1: region.box.top,
      y2: region.box.bottom,
      comment: literal(region.comment.trim()) || copy.noComment,
    }))
    .join('\n');
}

export function buildChatImageAnnotationMessage(input: {
  regions: ChatImageAnnotationRegion[];
  note: string;
  copy: ChatImageAnnotationCopy;
}): string {
  const lines = [
    interpolate(input.copy.messageHeader, { count: input.regions.length }),
    buildRegionList(input.regions, input.copy),
  ];
  const note = input.note.trim();
  if (note) lines.push(interpolate(input.copy.noteLine, { note: literal(note) }));
  return lines.join('\n');
}

export function buildChatImageAnnotationCapture(input: {
  regions: ChatImageAnnotationRegion[];
  note: string;
  copy: ChatImageAnnotationCopy;
  bakedPngDataUrl: string;
  requestId?: string;
  capturedAtMs?: number;
}): AppshotCapture {
  const text = buildChatImageAnnotationMessage(input);
  return {
    requestId: input.requestId
      || `chat-image-annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    appName: input.copy.captureName,
    windowTitle: null,
    screenshotPath: '',
    screenshotDataUrl: input.bakedPngDataUrl,
    axText: text,
    textSource: 'ax',
    textReady: true,
    windowFrame: { x: 0, y: 0, width: 0, height: 0 },
    capturedAtMs: input.capturedAtMs ?? Date.now(),
    asPlainImage: true,
  };
}
