// ============================================================================
// PreferenceStage - 偏好优化方法
// DPO/KTO/ORPO/SimPO 原理与对比
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Heart,
  ThumbsUp,
  ThumbsDown,
  Zap,
  ArrowRight,
} from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n/zh';

interface PreferenceStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// 偏好方法对比
function buildPreferenceMethods(t: Translations) {
  const m = t.labLlamafactory.preference.methods;
  return [
    { id: 'dpo', name: 'DPO', ...m.dpo, dataFormat: 'prompt + chosen + rejected', difficulty: 2, color: 'purple' },
    { id: 'kto', name: 'KTO', ...m.kto, dataFormat: 'prompt + response + label', difficulty: 2, color: 'blue' },
    { id: 'orpo', name: 'ORPO', ...m.orpo, dataFormat: 'prompt + chosen + rejected', difficulty: 2, color: 'emerald' },
    { id: 'simpo', name: 'SimPO', ...m.simpo, dataFormat: 'prompt + chosen + rejected', difficulty: 1, color: 'amber' },
  ];
}

function buildComparisonExamples(t: Translations) {
  const p = t.labLlamafactory.preference;
  return [{ ...p.comparisonExample, diff: p.comparisonDiff }];
}

export const PreferenceStage: React.FC<PreferenceStageProps> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const p = t.labLlamafactory.preference;
  const preferenceMethods = buildPreferenceMethods(t);
  const comparisonExamples = buildComparisonExamples(t);
  const [selectedMethod, setSelectedMethod] = useState<string>('dpo');
  const [userChoice, setUserChoice] = useState<'chosen' | 'rejected' | null>(null);
  const [showComparison, setShowComparison] = useState(false);

  const getColorClasses = (color: string, _isActive: boolean) => {
    const colors: Record<string, { bg: string; border: string; text: string; ring: string }> = {
      purple: { bg: 'bg-purple-500/20', border: 'border-badge-accent/30', text: 'text-badge-accent', ring: 'ring-purple-500/30' },
      blue: { bg: 'bg-blue-500/20', border: 'border-badge-info/30', text: 'text-badge-info', ring: 'ring-blue-500/30' },
      emerald: { bg: 'bg-emerald-500/20', border: 'border-badge-success/30', text: 'text-badge-success', ring: 'ring-emerald-500/30' },
      amber: { bg: 'bg-amber-500/20', border: 'border-badge-warning/30', text: 'text-badge-warning', ring: 'ring-amber-500/30' },
    };
    return colors[color] || colors.purple;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-lg border border-badge-warning/20 p-4">
        <div className="flex items-start gap-3">
          <Heart className="w-5 h-5 text-badge-warning mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{p.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {p.introDescPart1}
              <span className="text-badge-warning">{p.introDescHighlight}</span>{p.introDescPart2}
            </p>
          </div>
        </div>
      </div>

      {/* Preference Demo */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <ThumbsUp className="w-4 h-4 text-badge-warning" />
          {p.demoSectionTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          {/* Prompt */}
          <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-badge-info/20">
            <div className="text-xs text-badge-info mb-1">{p.userQuestionLabel}</div>
            <p className="text-sm text-zinc-200">{p.chosenRejectedExample.prompt}</p>
          </div>

          {/* Choices */}
          <div className="grid grid-cols-2 gap-4">
            {/* Chosen */}
            <button
              onClick={() => setUserChoice('chosen')}
              className={`
                p-4 rounded-lg border text-left transition-all
                ${userChoice === 'chosen'
                  ? 'bg-zinc-800/80 border-zinc-500 ring-1 ring-white/15'
                  : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                }
              `}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">A</span>
                {userChoice === 'chosen' && <ThumbsUp className="w-4 h-4 text-badge-success" />}
              </div>
              <p className="text-sm text-zinc-400">{p.chosenRejectedExample.chosen}</p>
            </button>

            {/* Rejected */}
            <button
              onClick={() => setUserChoice('rejected')}
              className={`
                p-4 rounded-lg border text-left transition-all
                ${userChoice === 'rejected'
                  ? 'bg-red-500/20 border-red-500/30 ring-2 ring-red-500/30'
                  : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                }
              `}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">B</span>
                {userChoice === 'rejected' && <ThumbsDown className="w-4 h-4 text-badge-danger" />}
              </div>
              <p className="text-sm text-zinc-400">{p.chosenRejectedExample.rejected}</p>
            </button>
          </div>

          {/* Feedback */}
          {userChoice && (
            <div className={`
              mt-4 p-3 rounded-lg
              ${userChoice === 'chosen' ? 'bg-zinc-800/70 border border-zinc-600' : 'bg-amber-500/10 border border-badge-warning/20'}
            `}>
              <p className="text-sm">
                {userChoice === 'chosen' ? (
                  <span className="text-badge-success">
                    {p.feedbackChosen}
                  </span>
                ) : (
                  <span className="text-badge-warning">
                    {p.feedbackRejected}
                  </span>
                )}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Method Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Zap className="w-4 h-4 text-badge-warning" />
          {p.methodsSectionTitle}
        </h3>
        <div className="grid grid-cols-4 gap-3">
          {preferenceMethods.map((method) => {
            const isSelected = selectedMethod === method.id;
            const colors = getColorClasses(method.color, isSelected);

            return (
              <button
                key={method.id}
                onClick={() => setSelectedMethod(method.id)}
                className={`
                  p-3 rounded-lg border text-left transition-all
                  ${isSelected
                    ? `${colors.bg} ${colors.border} ring-2 ${colors.ring}`
                    : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                  }
                `}
              >
                <div className={`text-lg font-bold ${isSelected ? colors.text : 'text-zinc-400'}`}>
                  {method.name}
                </div>
                <div className="text-xs text-zinc-500 mb-2">{method.zh}</div>
                <div className="flex items-center gap-0.5 mb-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <span
                      key={i}
                      className={`text-[10px] ${i < method.difficulty ? 'text-badge-warning' : 'text-zinc-600'}`}
                    >
                      ★
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>

        {/* Method Detail */}
        {selectedMethod && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
            {(() => {
              const method = preferenceMethods.find(m => m.id === selectedMethod)!;
              const colors = getColorClasses(method.color, true);
              return (
                <>
                  <div className="flex items-center gap-3 mb-3">
                    <span className={`text-xl font-bold ${colors.text}`}>{method.name}</span>
                    <span className="text-sm text-zinc-500">{method.fullName}</span>
                  </div>
                  <p className="text-sm text-zinc-400 mb-4">{method.description}</p>

                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-3 rounded-lg bg-zinc-800">
                      <div className="text-xs text-zinc-500 mb-2">{p.dataFormatLabel}</div>
                      <code className="text-xs text-badge-warning">{method.dataFormat}</code>
                    </div>
                    <div className="p-3 rounded-lg bg-zinc-800">
                      <div className="text-xs text-badge-success mb-2">{p.prosLabel}</div>
                      <ul className="space-y-1">
                        {method.pros.map((pro, idx) => (
                          <li key={idx} className="text-xs text-zinc-400">+ {pro}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="p-3 rounded-lg bg-zinc-800">
                      <div className="text-xs text-badge-danger mb-2">{p.consLabel}</div>
                      <ul className="space-y-1">
                        {method.cons.map((con, idx) => (
                          <li key={idx} className="text-xs text-zinc-400">- {con}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* SFT vs SFT+DPO */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-400">{p.comparisonSectionTitle}</h3>
          <button
            onClick={() => setShowComparison(!showComparison)}
            className={`
              px-3 py-1.5 rounded-lg text-xs transition-all
              ${showComparison
                ? 'bg-orange-500/20 text-badge-warning border border-badge-warning/30'
                : 'bg-zinc-800 text-zinc-500 border border-zinc-800'
              }
            `}
          >
            {showComparison ? p.hideComparisonButton : p.showComparisonButton}
          </button>
        </div>

        {showComparison && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
            {comparisonExamples.map((example, idx) => (
              <div key={idx}>
                <div className="mb-3 p-2 rounded bg-blue-500/10 border border-badge-info/20">
                  <span className="text-xs text-badge-info">{p.comparisonQuestionLabel}</span>
                  <span className="text-sm text-zinc-400 ml-2">{example.prompt}</span>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-3">
                  <div className="p-3 rounded-lg bg-zinc-800 border border-zinc-800">
                    <div className="text-xs text-zinc-500 mb-2">{p.sftOnlyLabel}</div>
                    <p className="text-sm text-zinc-400 whitespace-pre-line">{example.sftOnly}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-purple-500/10 border border-badge-accent/30">
                    <div className="text-xs text-badge-accent mb-2">{p.sftPlusDpoLabel}</div>
                    <p className="text-sm text-zinc-400 whitespace-pre-line">{example.sftPlusDpo}</p>
                  </div>
                </div>

                <div className="p-2 rounded bg-amber-500/10 border border-badge-warning/20">
                  <span className="text-xs text-badge-warning">💡 {example.diff}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Workflow */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{p.workflowSectionTitle}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1 text-center p-3 rounded-lg bg-blue-500/10 border border-badge-info/20">
              <div className="text-2xl mb-1">📝</div>
              <div className="text-sm font-medium text-badge-info">{p.workflowSft.title}</div>
              <div className="text-xs text-zinc-500">{p.workflowSft.desc}</div>
            </div>
            <ArrowRight className="w-6 h-6 text-zinc-600 mx-4" />
            <div className="flex-1 text-center p-3 rounded-lg bg-purple-500/10 border border-badge-accent/20">
              <div className="text-2xl mb-1">❤️</div>
              <div className="text-sm font-medium text-badge-accent">{p.workflowDpo.title}</div>
              <div className="text-xs text-zinc-500">{p.workflowDpo.desc}</div>
            </div>
            <ArrowRight className="w-6 h-6 text-zinc-600 mx-4" />
            <div className="flex-1 text-center p-3 rounded-lg bg-emerald-500/10 border border-badge-success/20">
              <div className="text-2xl mb-1">✅</div>
              <div className="text-sm font-medium text-badge-success">{p.workflowEval.title}</div>
              <div className="text-xs text-zinc-500">{p.workflowEval.desc}</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-zinc-500 text-center">
            {p.workflowHint}
          </div>
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-orange-500/5 rounded-lg border border-badge-warning/20 p-4">
        <h4 className="text-sm font-medium text-badge-warning mb-2">{p.takeawaysTitle}</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          {p.takeaways.map((item) => (
            <li key={item.label} className="flex items-start gap-2">
              <span className="text-badge-warning">•</span>
              <span><strong className="text-zinc-400">{item.label}</strong>：{item.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 专有名词 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-badge-info">📖</span>
          {p.glossaryTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {p.glossary.map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-zinc-800">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-badge-success">{term.en}</span>
                {term.zh && term.zh !== term.en && (
                  <>
                    <span className="text-xs text-zinc-500">|</span>
                    <span className="text-sm text-zinc-400">{term.zh}</span>
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
          {p.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-orange-500/20 text-badge-warning rounded-lg hover:bg-orange-500/30 border border-badge-warning/30 transition-all font-medium"
        >
          {p.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
