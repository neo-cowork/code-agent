// ============================================================================
// AlignmentComparison - 对齐效果对比阶段
// 用直观方式展示 AI 的进步
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronLeft,
  Layers,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Sparkles,
  MessageSquare,
} from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

interface AlignmentComparisonProps {
  onBack: () => void;
}

export const AlignmentComparison: React.FC<AlignmentComparisonProps> = ({ onBack }) => {
  const { t } = useI18n();
  const s = t.labAlignment.comparison;
  const common = t.labAlignment.common;
  const [selectedExample, setSelectedExample] = useState(0);
  const comparisonExamples = s.examples;
  const example = comparisonExamples[selectedExample];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-pink-500/10 to-rose-500/10 rounded-lg border border-badge-accent/20 p-4">
        <div className="flex items-start gap-3">
          <Layers className="w-5 h-5 text-badge-accent mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{s.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {s.introText}
            </p>
          </div>
        </div>
      </div>

      {/* Example Selector */}
      <div className="flex gap-2">
        {comparisonExamples.map((ex, idx) => (
          <button
            key={idx}
            onClick={() => setSelectedExample(idx)}
            className={`px-4 py-2 rounded-lg text-sm transition-all ${
              selectedExample === idx
                ? 'bg-pink-500/20 text-badge-accent border border-badge-accent/30'
                : 'bg-zinc-800 text-zinc-500 border border-zinc-800 hover:border-zinc-600'
            }`}
          >
            {ex.category}
          </button>
        ))}
      </div>

      {/* Prompt */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="w-4 h-4 text-badge-info" />
          <span className="text-sm text-badge-info">{common.userSaidLabel}</span>
        </div>
        <p className="text-base text-zinc-200">{example.prompt}</p>
      </div>

      {/* Three Stage Comparison */}
      <div className="grid grid-cols-3 gap-4">
        {/* Base Model */}
        <div className="bg-zinc-800 rounded-lg border border-zinc-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="text-lg">📚</div>
              <span className="text-sm font-medium text-zinc-400">{s.stageCards.base.label}</span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-zinc-700 text-zinc-500">{s.stageCards.base.badge}</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg mb-3 min-h-[120px]">
            <p className="text-sm text-zinc-500 whitespace-pre-wrap">{example.responses.base}</p>
          </div>
          <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 border border-red-500/20">
            <XCircle className="w-4 h-4 text-badge-danger flex-shrink-0" />
            <span className="text-xs text-badge-danger">{example.comments.base}</span>
          </div>
        </div>

        {/* SFT Model */}
        <div className="bg-purple-500/5 rounded-lg border border-badge-accent/20 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="text-lg">📝</div>
              <span className="text-sm font-medium text-badge-accent">{s.stageCards.sft.label}</span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-badge-accent">{s.stageCards.sft.badge}</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg mb-3 min-h-[120px]">
            <p className="text-sm text-badge-accent/80 whitespace-pre-wrap">{example.responses.sft}</p>
          </div>
          <div className="flex items-center gap-2 p-2 rounded bg-amber-500/10 border border-badge-warning/20">
            <span className="w-4 text-center text-badge-warning">△</span>
            <span className="text-xs text-badge-warning">{example.comments.sft}</span>
          </div>
        </div>

        {/* RLHF Model */}
        <div className="bg-emerald-500/5 rounded-lg border border-badge-success/20 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="text-lg">✨</div>
              <span className="text-sm font-medium text-badge-success">{s.stageCards.rlhf.label}</span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-badge-success">{s.stageCards.rlhf.badge}</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg mb-3 min-h-[120px]">
            <p className="text-sm text-badge-success/80 whitespace-pre-wrap">{example.responses.rlhf}</p>
          </div>
          <div className="flex items-center gap-2 p-2 rounded bg-emerald-500/10 border border-badge-success/20">
            <CheckCircle2 className="w-4 h-4 text-badge-success flex-shrink-0" />
            <span className="text-xs text-badge-success">{example.comments.rlhf}</span>
          </div>
        </div>
      </div>

      {/* Evolution Flow */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
        <h4 className="text-sm font-medium text-zinc-400 mb-4 text-center">{s.evolutionTitle}</h4>
        <div className="flex items-center justify-center gap-2">
          <div className="text-center flex-1 max-w-[140px]">
            <div className="w-16 h-16 mx-auto rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center mb-2">
              <span className="text-2xl">📚</span>
            </div>
            <div className="text-sm text-zinc-400 font-medium">{s.evolutionSteps.read.label}</div>
            <div className="text-xs text-zinc-600">{s.evolutionSteps.read.desc}</div>
          </div>
          <ArrowRight className="w-6 h-6 text-zinc-600 flex-shrink-0" />
          <div className="text-center flex-1 max-w-[140px]">
            <div className="w-16 h-16 mx-auto rounded-full bg-purple-500/10 border border-badge-accent/30 flex items-center justify-center mb-2">
              <span className="text-2xl">📝</span>
            </div>
            <div className="text-sm text-badge-accent font-medium">{s.evolutionSteps.learnAnswer.label}</div>
            <div className="text-xs text-zinc-600">{s.evolutionSteps.learnAnswer.desc}</div>
          </div>
          <ArrowRight className="w-6 h-6 text-zinc-600 flex-shrink-0" />
          <div className="text-center flex-1 max-w-[140px]">
            <div className="w-16 h-16 mx-auto rounded-full bg-amber-500/10 border border-badge-warning/30 flex items-center justify-center mb-2">
              <span className="text-2xl">⭐</span>
            </div>
            <div className="text-sm text-badge-warning font-medium">{s.evolutionSteps.learnScore.label}</div>
            <div className="text-xs text-zinc-600">{s.evolutionSteps.learnScore.desc}</div>
          </div>
          <ArrowRight className="w-6 h-6 text-zinc-600 flex-shrink-0" />
          <div className="text-center flex-1 max-w-[140px]">
            <div className="w-16 h-16 mx-auto rounded-full bg-emerald-500/10 border border-badge-success/30 flex items-center justify-center mb-2">
              <span className="text-2xl">✨</span>
            </div>
            <div className="text-sm text-badge-success font-medium">{s.evolutionSteps.practice.label}</div>
            <div className="text-xs text-zinc-600">{s.evolutionSteps.practice.desc}</div>
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="bg-pink-500/5 rounded-lg border border-badge-accent/20 p-4">
        <h4 className="text-sm font-medium text-badge-accent mb-3">{s.summarySectionTitle}</h4>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="p-3 bg-zinc-800 rounded-lg text-center">
            <div className="text-2xl mb-1">🎓</div>
            <div className="text-xs text-zinc-400">{s.summaryCards.sft}</div>
          </div>
          <div className="p-3 bg-zinc-800 rounded-lg text-center">
            <div className="text-2xl mb-1">⚖️</div>
            <div className="text-xs text-zinc-400">{s.summaryCards.reward}</div>
          </div>
          <div className="p-3 bg-zinc-800 rounded-lg text-center">
            <div className="text-2xl mb-1">🚀</div>
            <div className="text-xs text-zinc-400">{s.summaryCards.ppo}</div>
          </div>
        </div>
        <div className="p-3 rounded-lg bg-pink-500/10 border border-badge-accent/20">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-badge-accent" />
            <p className="text-sm text-zinc-400">
              <strong className="text-badge-accent">{s.alignmentWord}</strong>{s.finalText1}
              <strong className="text-badge-success">{s.finalHighlight}</strong>{s.finalText2}
            </p>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-badge-info">📖</span>
          {common.glossaryTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {s.glossaryTerms.map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-zinc-800">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-badge-success">{term.en}</span>
                {term.meaning && term.meaning !== term.en && (
                  <>
                    <span className="text-xs text-zinc-500">|</span>
                    <span className="text-sm text-zinc-400">{term.meaning}</span>
                  </>
                )}
              </div>
              <p className="text-xs text-zinc-500">{term.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800 text-zinc-400 rounded-lg hover:bg-zinc-700 border border-zinc-700 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          {common.backButton}
        </button>
        <div className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-pink-500/20 to-emerald-500/20 text-badge-accent rounded-lg border border-badge-accent/30">
          <CheckCircle2 className="w-4 h-4" />
          <span className="font-medium">{s.completionMessage}</span>
        </div>
      </div>
    </div>
  );
};
