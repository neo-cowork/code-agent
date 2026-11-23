// 聊天图片批注弹窗：在图上拖框、给每个框写评论，发出「画好框的图 + 带方位的文字」。
// 由 MediaAssetActionBar 以 React.lazy 加载——react-konva（经 AnnotationLayer）不进聊天主 chunk。
// 叠层用纯 DOM 画，烘焙走 composeAnnotOps + exportAnnotatedPng。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionMediaAsset } from '@shared/utils/sessionMediaAssets';
import { Button, Modal, Textarea } from '../../../primitives';
import { reduceAnnot, type AnnotShape } from '../../../design/AnnotationLayer';
import { composeAnnotOps, exportAnnotatedPng } from '../../../design/annotComposite';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppshotsStore } from '../../../../stores/appshotsStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { interpolate } from '../../../../i18n/interpolate';
import {
  buildChatImageAnnotationCapture,
  buildChatImageAnnotationMessage,
  toRegionPercentBox,
  type ChatImageAnnotationRegion,
} from '../../../../utils/chatImageAnnotation';
import { getRenderableMediaSrc } from './MediaAssetControls';

/** 拖出的框短于这个像素数视为误触，丢弃。 */
const MIN_REGION_PX = 8;
/** 烘焙图长边上限：太大的图缩小后再发，避免超大 dataURL。 */
const MAX_BAKED_EDGE_PX = 1600;

type RectShape = Extract<AnnotShape, { kind: 'rect' }>;

async function readImageAsDataUrl(src: string): Promise<string> {
  // 内联图（用户上传 / 粘贴）本身就是 data URL，不必再 fetch（页面 CSP 的 connect-src 不一定放行 data:）。
  if (src.startsWith('data:image/')) return src;
  const response = await fetch(src);
  if (!response.ok) throw new Error('image fetch failed');
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'));
    reader.readAsDataURL(blob);
  });
}

function isRect(shape: AnnotShape): shape is RectShape {
  return shape.kind === 'rect';
}

export function ChatImageAnnotateModal({
  asset,
  onClose,
}: {
  asset: SessionMediaAsset;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const copy = t.chatImageAnnotate;
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shapes, setShapes] = useState<AnnotShape[]>([]);
  const [comments, setComments] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [drawing, setDrawing] = useState(false);
  const [sending, setSending] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // 依赖字符串而不是 asset 对象：气泡每次重渲染都会重建 asset，按对象依赖会让读取不停被取消。
  const src = getRenderableMediaSrc(asset);
  useEffect(() => {
    let cancelled = false;
    if (!src) {
      setError(copy.loadFailed);
      return;
    }
    readImageAsDataUrl(src)
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError(copy.loadFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [src, copy.loadFailed]);

  const pointerPoint = useCallback((event: React.PointerEvent) => {
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: Math.min(bounds.width, Math.max(0, event.clientX - bounds.left)),
      y: Math.min(bounds.height, Math.max(0, event.clientY - bounds.top)),
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dataUrl || sending) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = pointerPoint(event);
    setShapes((current) => reduceAnnot(current, { type: 'down', tool: 'rect', ...point }));
    setDrawing(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    const point = pointerPoint(event);
    setShapes((current) => reduceAnnot(current, { type: 'move', ...point }));
  };

  const handlePointerUp = () => {
    if (!drawing) return;
    setDrawing(false);
    const last = shapes[shapes.length - 1];
    if (!last || !isRect(last) || Math.abs(last.w) < MIN_REGION_PX || Math.abs(last.h) < MIN_REGION_PX) {
      setShapes((current) => current.slice(0, -1));
      return;
    }
    // 规整成左上角 + 正宽高，后面的方位换算与烘焙都不必再处理反向拖拽。
    const normalized: RectShape = {
      ...last,
      x: Math.min(last.x, last.x + last.w),
      y: Math.min(last.y, last.y + last.h),
      w: Math.abs(last.w),
      h: Math.abs(last.h),
    };
    setShapes((current) => [...current.slice(0, -1), normalized]);
    setComments((current) => [...current, '']);
  };

  const removeRegion = (index: number) => {
    setShapes((current) => current.filter((_, i) => i !== index));
    setComments((current) => current.filter((_, i) => i !== index));
  };

  const rects = shapes.filter(isRect);

  const handleSend = async () => {
    const displayW = overlayRef.current?.clientWidth ?? 0;
    const displayH = overlayRef.current?.clientHeight ?? 0;
    const img = imgRef.current;
    const finished = rects.slice(0, comments.length);
    if (!dataUrl || !img || displayW <= 0 || displayH <= 0 || finished.length === 0) {
      setError(copy.needRegion);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
      const ratio = longEdge > MAX_BAKED_EDGE_PX ? MAX_BAKED_EDGE_PX / longEdge : 1;
      const outW = Math.max(1, Math.round(img.naturalWidth * ratio));
      const outH = Math.max(1, Math.round(img.naturalHeight * ratio));
      const stamped: AnnotShape[] = finished.flatMap((rect, i) => [
        rect,
        { kind: 'text' as const, x: rect.x + 4, y: rect.y + 3, text: String(i + 1), color: rect.color },
      ]);
      const baked = await exportAnnotatedPng(
        dataUrl,
        composeAnnotOps({ naturalW: outW, naturalH: outH, displayW, displayH, shapes: stamped }),
        outW,
        outH,
      );
      const regions: ChatImageAnnotationRegion[] = finished.map((rect, i) => ({
        index: i + 1,
        box: toRegionPercentBox(rect, displayW, displayH),
        comment: comments[i] ?? '',
      }));
      const input = { regions, note, copy, bakedPngDataUrl: baked };
      const capture = buildChatImageAnnotationCapture(input);
      useAppshotsStore.getState().setPending(capture, sessionId);
      window.dispatchEvent(new CustomEvent('browser-annotation:submit', {
        detail: { text: buildChatImageAnnotationMessage(input) },
      }));
      onClose();
    } catch {
      setError(copy.sendFailed);
      setSending(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={copy.modalTitle}
      size="full"
      portal
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={sending}>{copy.cancel}</Button>
          <Button
            onClick={() => void handleSend()}
            loading={sending}
            disabled={!dataUrl || rects.length === 0}
            data-testid="chat-image-annotate-send"
          >
            {copy.send}
          </Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row" data-testid="chat-image-annotate-modal">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="text-xs text-zinc-400">{copy.hint}</p>
          {dataUrl ? (
            <div className="relative inline-block max-w-full self-start">
              <img
                ref={imgRef}
                src={dataUrl}
                alt=""
                draggable={false}
                className="block max-h-[55vh] max-w-full select-none"
              />
              <div
                ref={overlayRef}
                className="absolute inset-0 cursor-crosshair touch-none"
                data-testid="chat-image-annotate-overlay"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              >
                {rects.map((rect, i) => (
                  <div
                    key={i}
                    className="pointer-events-none absolute border-2 border-red-500"
                    style={{
                      left: Math.min(rect.x, rect.x + rect.w),
                      top: Math.min(rect.y, rect.y + rect.h),
                      width: Math.abs(rect.w),
                      height: Math.abs(rect.h),
                    }}
                    data-testid="chat-image-annotate-box"
                  >
                    <span className="absolute left-0 top-0 bg-red-500 px-1 text-xs font-bold leading-4 text-white">
                      {i + 1}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : !error ? (
            <div className="text-sm text-zinc-400">{copy.loading}</div>
          ) : null}
          {error && <div className="text-sm text-badge-danger" role="alert">{error}</div>}
        </div>
        <div className="flex w-full shrink-0 flex-col gap-2 md:w-64">
          {comments.map((comment, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs text-zinc-300">
                <span>{interpolate(copy.regionLabel, { n: i + 1 })}</span>
                <Button variant="ghost" size="sm" onClick={() => removeRegion(i)}>
                  {copy.removeRegion}
                </Button>
              </div>
              <Textarea
                rows={2}
                value={comment}
                placeholder={copy.commentPlaceholder}
                onChange={(event) => {
                  const value = event.target.value;
                  setComments((current) => current.map((c, j) => (j === i ? value : c)));
                }}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-300">{copy.noteLabel}</span>
            <Textarea
              rows={2}
              value={note}
              placeholder={copy.notePlaceholder}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
