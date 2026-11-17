// ============================================================================
// MemoryConfirmModal - 低置信度记忆确认弹窗
// ============================================================================

import React from 'react';
import { Brain, Check, X, AlertTriangle } from 'lucide-react';
import { Button } from '../../primitives';
import type { PendingMemoryConfirm } from '../../../hooks/useMemoryLearning';
import { getCategoryLabel, getTypeLabel } from '../../../hooks/useMemoryLearning';
import { useI18n } from '../../../hooks/useI18n';
import { Z_LAYERS } from '../../../styles/zLayers';
import { getMemoryConfirmWords } from '../../../i18n/memoryConfirm';
import type { MemoryConfirmView } from '@shared/contract/memory';

const LINE_CLASS = 'whitespace-pre-wrap break-words';

function ConfirmView({ view, language }: { view: MemoryConfirmView; language: 'zh' | 'en' }) {
  const w = getMemoryConfirmWords(language);
  return (
    <div className="space-y-2" data-testid="memory-confirm-view">
      {view.items.map((item, index) => {
        switch (item.kind) {
          case 'remember': return <p key={index} className={LINE_CLASS}>{w.remember}{item.text}</p>;
          case 'description': return <p key={index} className={LINE_CLASS}>{w.description}{item.text}</p>;
          case 'name': return <p key={index} className={LINE_CLASS}>{w.name}{item.text}</p>;
          case 'replaces': return <p key={index} className={`${LINE_CLASS} text-badge-warning`}>{w.replaces}</p>;
          case 'delete': return <p key={index} className={LINE_CLASS}>{w.deleteMemory}{item.title}</p>;
          case 'command': return <p key={index} className={LINE_CLASS}>{w.command}{item.text}</p>;
          case 'path': return <p key={index} className={LINE_CLASS}>{w.path}{item.text}</p>;
          case 'change': return <p key={index} className={LINE_CLASS}>{w.changeFromTo(item.from, item.to)}</p>;
          case 'body':
          case 'line': return <p key={index} className={LINE_CLASS}>{item.text}</p>;
        }
      })}
    </div>
  );
}

interface MemoryConfirmModalProps {
  pending: PendingMemoryConfirm | null;
  onConfirm: (id: string) => void;
  onDecline: (id: string) => void;
}

export const MemoryConfirmModal: React.FC<MemoryConfirmModalProps> = ({
  pending,
  onConfirm,
  onDecline,
}) => {
  const { t, language } = useI18n();
  if (!pending) return null;
  const isDirective = pending.authority === 'directive';

  const confidencePercent = Math.round(pending.confidence * 100);

  return (
    <div className="fixed bottom-4 right-4 animate-in slide-in-from-bottom-4 duration-300" style={{ zIndex: Z_LAYERS.floatingPanel }}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-md dark:shadow-2xl w-80 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-zinc-800 border-b border-zinc-700">
          <Brain className="w-5 h-5 text-badge-accent" />
          <span className="font-medium text-zinc-200">
            {isDirective ? t.memory.confirmDirectiveTitle : t.memory.confirmMemoryTitle}
          </span>
          <span className="ml-auto flex items-center gap-1 text-xs text-badge-warning">
            <AlertTriangle className="w-3 h-3" />
            {confidencePercent}% 置信度
          </span>
        </div>

        {/* Content */}
        <div className="p-4">
          <div className="text-sm text-zinc-400 mb-3 max-h-64 overflow-y-auto break-words">
            {isDirective && pending.view
              ? <ConfirmView view={pending.view} language={language} />
              : <p className="whitespace-pre-wrap">{pending.content}</p>}
          </div>

          {/* Meta info：directive 是用户规则，没有分类/类型这类内部标签 */}
          {!isDirective && (
            <div className="flex items-center gap-2 text-xs text-zinc-500 mb-4">
              <span className="px-1.5 py-0.5 rounded bg-zinc-700">
                {getCategoryLabel(pending.category)}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-zinc-700">
                {getTypeLabel(pending.type)}
              </span>
            </div>
          )}

          <p className="text-xs text-zinc-500 mb-4">
            {isDirective ? t.memory.confirmDirectiveBody : t.memory.confirmMemoryBody}
          </p>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDecline(pending.id)}
              className="flex-1 flex items-center justify-center gap-1.5"
            >
              <X className="w-4 h-4" />
              {t.memory.confirmSkip}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onConfirm(pending.id)}
              className="flex-1 flex items-center justify-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              {isDirective ? t.memory.confirmDirectiveSave : t.memory.confirmSave}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
