import { formatExternalModelSwitcherTooltip, formatNativeModelSwitcherTooltip } from './modelSwitcherTooltips';
import { humanizeInternalText } from '@shared/humanizeInternalText';
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from '../../stores/sessionStore';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, ModelProvider } from '@shared/contract';
import type {
  AgentEngineKind,
  AgentEngineModelCatalog,
  AgentEngineModelCatalogResult,
  AgentEngineSourceDescriptor,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '@shared/contract/agentEngine';
import { getProviderDisplayName, isAgenticVerifiedModel } from '@shared/constants';
import {
  buildRuntimeModelOptions,
  groupRuntimeModelOptionsByProvider,
  getRuntimeModelLabel,
  hasConfiguredRuntimeModels,
  type RuntimeModelOption,
} from '@shared/modelRuntime';
import {
  PRICING_BASELINE_DEFAULT,
  computeCoef,
  formatCoefLabel,
  resolveModelPrice,
} from '@shared/pricing/resolveModelPrice';
import { toast } from '../../hooks/useToast';
import { BadgeCheck, Sparkles, Code2, Settings, Star } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useAppStore } from '../../stores/appStore';
import { useModeStore } from '../../stores/modeStore';
import { trackRenderer } from '../../observability/posthogRenderer';
import { POSTHOG_EVENTS } from '@shared/observability/posthog-events';
import { Z_LAYERS } from '../../styles/zLayers';
let engineSourcesCache: AgentEngineSourceDescriptor[] = [];
import {
  buildProviderBillingSummary,
  buildProviderHealthSummary,
  buildModelRowHealthSummary,
  healthSnapshotForProviderSort,
  buildProviderMetaTitle,
  CAPABILITY_CONFIG,
  ENGINE_SHORT_LABEL,
  getEngineEffortOptions,
  getReasoningSegmentMode,
  buildThinkingSegmentOptions,
  getProviderEffortOptions,
  getSelectedEffortOption,
  type ProviderHealthSnapshot,
  ProviderLogo,
  QUICK_SWITCH_PROVIDERS,
  sortProviderGroupsByModelStrategy,
  buildModelSwitcherEngineSelection,
} from './modelSwitcherHelpers';
import {
  EngineScopedModelPanel,
  type EngineMenuView,
} from './EngineScopedModelPanel';
import { loadEnginePanelData } from './enginePanelLoader';
import { ReasoningSegment } from './ReasoningSegment';
import { SearchToggleSection } from './SearchToggleSection';
import { modelOverrideFailureToast } from './modelOverrideErrorCopy';
import { interpolate } from '../../i18n/interpolate';
interface ModelSwitcherProps {
  currentModel: string;
}
export const MODEL_OVERRIDE_CHANGE_EVENT = 'code-agent:model-override-change';
/** 会话内（如 AgentErrorCard「切换模型」按钮）请求打开模型选择器的事件。 */
export const OPEN_MODEL_SWITCHER_EVENT = 'code-agent:open-model-switcher';
const PRICE_BASELINE = resolveModelPrice(PRICING_BASELINE_DEFAULT.provider, PRICING_BASELINE_DEFAULT.modelId);
export function getModelPriceBadge(provider: string, model: string): { label: string; known: boolean } {
  const price = resolveModelPrice(provider, model);
  const label = formatCoefLabel(computeCoef(price, PRICE_BASELINE));
  return label ? { label, known: true } : { label: '—', known: false };
}
export interface ModelOverrideChangeDetail {
  sessionId: string;
  override: {
    provider: ModelProvider;
    model: string;
    adaptive?: boolean;
  } | null;
}
export interface ModelSwitcherMenuPosition {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}
const MODEL_SWITCHER_MENU_WIDTH = 352;
const MODEL_SWITCHER_MENU_ESTIMATED_HEIGHT = 520;
const MODEL_SWITCHER_VIEWPORT_MARGIN = 12;
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
export function computeModelSwitcherMenuPosition(args: {
  triggerRect: Pick<DOMRect, 'left' | 'top'>;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth?: number;
  menuHeight?: number;
  margin?: number;
}): ModelSwitcherMenuPosition {
  const margin = args.margin ?? MODEL_SWITCHER_VIEWPORT_MARGIN;
  const maxWidth = Math.max(1, args.viewportWidth - margin * 2);
  const width = Math.min(args.menuWidth ?? MODEL_SWITCHER_MENU_WIDTH, maxWidth);
  const maxHeight = Math.max(1, args.viewportHeight - margin * 2);
  const effectiveHeight = Math.min(args.menuHeight ?? MODEL_SWITCHER_MENU_ESTIMATED_HEIGHT, maxHeight);
  const maxLeft = Math.max(margin, args.viewportWidth - width - margin);
  const preferredBottom = args.viewportHeight - args.triggerRect.top + 4;
  const maxBottom = Math.max(margin, args.viewportHeight - effectiveHeight - margin);
  return {
    left: clampNumber(args.triggerRect.left, margin, maxLeft),
    bottom: clampNumber(preferredBottom, margin, maxBottom),
    width,
    maxHeight,
  };
}
export function shouldShowModelSettingsPrompt(
  engineKind: AgentEngineKind,
  modelSettings: AppSettings | null,
  nativeHasConfiguredModels: boolean,
): boolean {
  return engineKind === 'native'
    && modelSettings !== null
    && !nativeHasConfiguredModels;
}
export function shouldShowNativeReasoningSegment(args: {
  engineKind: AgentEngineKind;
  showModelSettingsPrompt: boolean;
  effortOptionCount: number;
}): boolean {
  return getReasoningSegmentMode(args) === 'active';
}
export function shouldDismissModelSwitcher(
  target: Node,
  trigger: Pick<Node, 'contains'> | null,
  menu: Pick<Node, 'contains'> | null,
): boolean {
  return !trigger?.contains(target) && !menu?.contains(target);
}
function emitModelOverrideChange(detail: ModelOverrideChangeDetail): void {
  window.dispatchEvent(new CustomEvent<ModelOverrideChangeDetail>(MODEL_OVERRIDE_CHANGE_EVENT, { detail }));
}
function trackModelSelected(properties: Record<string, unknown>): void {
  trackRenderer(POSTHOG_EVENTS.MODEL_SELECTED, properties);
}
export function ModelSwitcher({ currentModel }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [overrideModel, setOverrideModel] = useState<string | null>(null);
  const [overrideProvider, setOverrideProvider] = useState<ModelProvider | null>(null);
  const [overrideAdaptive, setOverrideAdaptive] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const [healthMap, setHealthMap] = useState<Record<string, ProviderHealthSnapshot>>({});
  const [modelSettings, setModelSettings] = useState<AppSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const { t, language } = useI18n();
  const modelText = t.settings.model.models;
  const panelText = modelText.switcherPanel;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const anchorPendingRef = useRef(false);
  const [menuPos, setMenuPos] = useState<ModelSwitcherMenuPosition | null>(null);
  const [engineMenuView, setEngineMenuView] = useState<EngineMenuView>('models');
  const [engineSources, setEngineSources] = useState<AgentEngineSourceDescriptor[]>(() => engineSourcesCache);
  const [engineSourcesLoading, setEngineSourcesLoading] = useState(engineSourcesCache.length === 0);
  const [engineCatalog, setEngineCatalog] = useState<AgentEngineModelCatalog | null>(null);
  const [engineCatalogLoading, setEngineCatalogLoading] = useState(true);
  const [engineCatalogFailed, setEngineCatalogFailed] = useState(false);
  const [enginePanelReloadKey, setEnginePanelReloadKey] = useState(0);
  const [busyEngineId, setBusyEngineId] = useState<string | null>(null);
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const session = useSessionStore((s) =>
    s.currentSessionId
      ? s.sessions.find((item) => item.id === s.currentSessionId) ?? null
      : null
  );
  const updateSessionEngine = useSessionStore((s) => s.updateSessionEngine);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const appWorkingDirectory = useAppStore((s) => s.workingDirectory);
  const defaultProvider = useAppStore((s) => s.modelConfig.provider);
  const effortLevel = useModeStore((s) => s.effortLevel);
  const effortLevelExplicit = useModeStore((s) => s.effortLevelExplicit);
  const setEffortLevel = useModeStore((s) => s.setEffortLevel);
  const setAutomaticEffortLevel = useModeStore((s) => s.setAutomaticEffortLevel);
  const thinkingEnabled = useModeStore((s) => s.thinkingEnabled);
  const setThinkingEnabled = useModeStore((s) => s.setThinkingEnabled);
  const engine = normalizeAgentEngineSession(session?.engine);
  const modelProviderInclusions = useMemo(
    () => Array.from(new Set([
      defaultProvider,
      overrideProvider,
    ].filter(Boolean))) as ModelProvider[],
    [defaultProvider, overrideProvider],
  );
  const modelOptions = useMemo(
    () => buildRuntimeModelOptions(modelSettings, QUICK_SWITCH_PROVIDERS, {
      includeDisabledProviders: modelProviderInclusions,
    }),
    [modelProviderInclusions, modelSettings],
  );
  const nativeHasConfiguredModels = useMemo(
    () => hasConfiguredRuntimeModels(modelSettings),
    [modelSettings],
  );
  const showModelSettingsPrompt = shouldShowModelSettingsPrompt(
    engine.kind,
    modelSettings,
    nativeHasConfiguredModels,
  );
  const visibleModelOptions = showModelSettingsPrompt ? [] : modelOptions;
  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return visibleModelOptions;
    const q = searchQuery.toLowerCase();
    return visibleModelOptions.filter((opt) => {
      const providerName = (opt.providerLabel || getProviderDisplayName(opt.provider) || opt.provider).toLowerCase();
      return (
        opt.label.toLowerCase().includes(q) ||
        opt.model.toLowerCase().includes(q) ||
        providerName.includes(q)
      );
    });
  }, [searchQuery, visibleModelOptions]);
  const groupedFilteredOptions = useMemo(() => {
    let nextIndex = 1;
    const groupProviderHealth = (group: ReturnType<typeof groupRuntimeModelOptionsByProvider>[number]) => {
      const provider = group.options[0]?.provider ?? group.provider;
      return healthMap[provider];
    };
    return sortProviderGroupsByModelStrategy(
      groupRuntimeModelOptionsByProvider(filteredOptions),
      healthMap,
    ).map((group) => ({
      ...group,
      billingSummary: buildProviderBillingSummary(group.providerBillingMode, panelText),
      healthSummary: buildProviderHealthSummary(healthSnapshotForProviderSort(groupProviderHealth(group)), panelText),
      options: group.options.map((option) => ({
        option,
        index: nextIndex++,
      })),
    }));
  }, [filteredOptions, healthMap, panelText]);
  useEffect(() => {
    if (open) {
      setSearchQuery('');
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [open]);
  useEffect(() => {
    const handleOpenRequest = () => setOpen(true);
    window.addEventListener(OPEN_MODEL_SWITCHER_EVENT, handleOpenRequest);
    return () => window.removeEventListener(OPEN_MODEL_SWITCHER_EVENT, handleOpenRequest);
  }, []);
  useEffect(() => {
    if (!open) {
      setSettingsLoaded(false);
      return;
    }
    const api = window.domainAPI;
    if (!api) {
      setSettingsLoaded(true);
      return;
    }
    api.invoke<AppSettings>(IPC_DOMAINS.SETTINGS, 'get', {})
      .then((res) => {
        if (res?.success && res.data) {
          setModelSettings(res.data);
        }
      })
      .catch(() => { /* 设置读取失败时保留内置模型列表兜底 */ })
      .finally(() => setSettingsLoaded(true));
  }, [open]);
  useEffect(() => {
    const domainAPI = window.domainAPI;
    if (!open || !domainAPI) return;
    setEngineCatalogFailed(false);
    return loadEnginePanelData({
      listSources: () => domainAPI.invoke<AgentEngineSourceDescriptor[]>(
        IPC_DOMAINS.AGENT_ENGINE,
        'listSources',
        {},
      ),
      listModels: () => domainAPI.invoke<AgentEngineModelCatalogResult>(
        IPC_DOMAINS.AGENT_ENGINE,
        'listModels',
        {},
      ),
      onSourcesLoadingChange: (loading) => {
        setEngineSourcesLoading(loading && engineSourcesCache.length === 0);
      },
      onCatalogLoadingChange: setEngineCatalogLoading,
      onSourcesLoaded: (sources) => {
        engineSourcesCache = sources;
        setEngineSources(sources);
      },
      onCatalogLoaded: (result) => {
        setEngineCatalog(result.catalog);
        setEngineCatalogFailed(false);
      },
      onCatalogFailed: () => setEngineCatalogFailed(true),
    });
  }, [enginePanelReloadKey, open]);
  useEffect(() => {
    setEngineMenuView('models');
    setSearchQuery('');
  }, [engine.kind]);
  useEffect(() => {
    if (open) {
      window.domainAPI?.invoke<Record<string, ProviderHealthSnapshot>>(
        IPC_DOMAINS.PROVIDER,
        'getHealthStatus',
        {}
      )
        .then((res) => { if (res?.success && res.data) setHealthMap(res.data); })
        .catch(() => { /* 静默失败，健康点不显示即可 */ });
    }
  }, [open]);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (shouldDismissModelSwitcher(target, triggerRef.current, menuRef.current)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }
  }, [open]);
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const updatePos = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos(computeModelSwitcherMenuPosition({
        triggerRect: rect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        menuHeight: menuRef.current?.offsetHeight,
      }));
    };
    updatePos();
    const frame = window.requestAnimationFrame(updatePos);
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    setOverrideModel(null);
    setOverrideProvider(null);
    setOverrideAdaptive(false);
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    window.domainAPI
      ?.invoke<{ provider: string; model: string; adaptive?: boolean } | null>(
        IPC_DOMAINS.SESSION,
        'getModelOverride',
        { sessionId }
      )
      .then((res) => {
        if (cancelled) return;
        if (res?.success) {
          setOverrideModel(res.data?.model ?? null);
          setOverrideProvider((res.data?.provider as ModelProvider | undefined) ?? null);
          setOverrideAdaptive(!!res.data?.adaptive);
        } else {
          toast.error(modelOverrideFailureToast('load', res?.error?.message, panelText));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          toast.error(modelOverrideFailureToast('load', err, panelText));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  const handleSelect = useCallback(
    async (option: RuntimeModelOption) => {
      if (!sessionId) return;
      try {
        const res = await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'switchModel', {
          sessionId,
          provider: option.provider,
          model: option.model,
          adaptive: false,
        });
        if (!res?.success) {
          toast.error(interpolate(panelText.switchFailed, { reason: res?.error?.message ?? panelText.unknownError }));
          return;
        }
        setOverrideModel(option.model);
        setOverrideProvider(option.provider);
        setOverrideAdaptive(false);
        emitModelOverrideChange({
          sessionId,
          override: { provider: option.provider, model: option.model, adaptive: false },
        });
        trackModelSelected({
          sessionId,
          engine: 'native',
          provider: option.provider,
          model: option.model,
          mode: 'override',
        });
        setOpen(false);
      } catch (err) {
        toast.error(interpolate(panelText.switchFailed, { reason: err instanceof Error ? err.message : panelText.unknownError }));
      }
    },
    [sessionId, panelText]
  );
  const handleOpenModelSettings = useCallback(() => {
    setOpen(false);
    openSettingsTab('model');
  }, [openSettingsTab]);
  const handleSelectAuto = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'switchModel', {
        sessionId,
        provider: defaultProvider,
        model: currentModel,
        adaptive: true,
      });
      if (!res?.success) {
        toast.error(interpolate(panelText.autoSwitchFailed, { reason: res?.error?.message ?? panelText.unknownError }));
        return;
      }
      setOverrideModel(currentModel);
      setOverrideProvider(defaultProvider);
      setOverrideAdaptive(true);
      emitModelOverrideChange({
        sessionId,
        override: { provider: defaultProvider, model: currentModel, adaptive: true },
      });
      trackModelSelected({
        sessionId,
        engine: 'native',
        provider: defaultProvider,
        model: currentModel,
        mode: 'adaptive',
      });
      setOpen(false);
    } catch (err) {
      toast.error(interpolate(panelText.autoSwitchFailed, { reason: err instanceof Error ? err.message : panelText.unknownError }));
    }
  }, [sessionId, defaultProvider, currentModel, panelText]);
  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await window.domainAPI?.invoke(
        IPC_DOMAINS.SESSION,
        'clearModelOverride',
        { sessionId }
      );
      if (!res?.success) {
        toast.error(modelOverrideFailureToast('clear', res?.error?.message, panelText));
        return;
      }
      setOverrideModel(null);
      setOverrideProvider(null);
      setOverrideAdaptive(false);
      emitModelOverrideChange({ sessionId, override: null });
      trackModelSelected({
        sessionId,
        engine: 'native',
        provider: defaultProvider,
        model: currentModel,
        mode: 'default',
      });
      setOpen(false);
    } catch (err) {
      toast.error(modelOverrideFailureToast('clear', err, panelText));
    }
  }, [sessionId, defaultProvider, currentModel, panelText]);
  const selectableOptionCount = showModelSettingsPrompt ? 0 : 1 + filteredOptions.length;
  useEffect(() => {
    if (!open) return;
    setActiveOptionIndex(0);
  }, [open, searchQuery]);
  useEffect(() => {
    if (!open || selectableOptionCount <= 0) return;
    setActiveOptionIndex((index) => Math.min(index, selectableOptionCount - 1));
  }, [open, selectableOptionCount]);
  useEffect(() => {
    if (!open || selectableOptionCount <= 0) return;
    const active = menuRef.current?.querySelector<HTMLElement>(`[data-model-option-index="${activeOptionIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionIndex, open, selectableOptionCount]);
  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (selectableOptionCount <= 0) return;
      event.preventDefault();
      setActiveOptionIndex((index) => {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        return (index + delta + selectableOptionCount) % selectableOptionCount;
      });
      return;
    }
    if (event.key === 'Enter') {
      if (selectableOptionCount <= 0) return;
      event.preventDefault();
      if (activeOptionIndex === 0) {
        void handleSelectAuto();
        return;
      }
      const option = filteredOptions[activeOptionIndex - 1];
      if (option) void handleSelect(option);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }, [
    activeOptionIndex,
    filteredOptions,
    handleSelect,
    handleSelectAuto,
    selectableOptionCount,
  ]);
  const displayModel = overrideModel || currentModel;
  const isOverridden = engine.kind === 'native' && !!overrideModel;
  const displayProvider = overrideProvider || defaultProvider;
  useEffect(() => {
    if (!open) return;
    if (!settingsLoaded) {
      anchorPendingRef.current = true;
      return;
    }
    if (!anchorPendingRef.current) return;
    anchorPendingRef.current = false;
    if (showModelSettingsPrompt) return;
    let selectedIndex = 0;
    for (const group of groupedFilteredOptions) {
      const hit = group.options.find(
        ({ option }) => option.model === displayModel && option.provider === displayProvider,
      );
      if (hit) {
        selectedIndex = hit.index;
        break;
      }
    }
    setActiveOptionIndex(selectedIndex);
    if (selectedIndex <= 0) return;
    const container = listScrollRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-model-option-index="${selectedIndex}"]`);
    if (container && row) {
      container.scrollTop = row.offsetTop - (container.clientHeight - row.clientHeight) / 2;
    }
  }, [open, settingsLoaded, showModelSettingsPrompt, groupedFilteredOptions, displayModel, displayProvider]);
  const nativeDisplayLabel = overrideAdaptive ? panelText.auto : getRuntimeModelLabel(displayModel, displayProvider, modelSettings);
  const selectedNativeOption = useMemo(
    () => modelOptions.find((option) => option.provider === displayProvider && option.model === displayModel),
    [displayModel, displayProvider, modelOptions],
  );
  const displayLabel = humanizeInternalText(engine.kind === 'native'
    ? showModelSettingsPrompt ? panelText.configureModel : nativeDisplayLabel
    : engine.model ?? modelText.switcherTooltip.defaultModel, language).text;
  const effortOptions = useMemo(
    () => engine.kind === 'native'
      ? getProviderEffortOptions(displayProvider, displayModel, selectedNativeOption?.features)
      : getEngineEffortOptions(engine.kind),
    [displayModel, displayProvider, engine.kind, selectedNativeOption?.features],
  );
  const selectedEffort = getSelectedEffortOption(effortLevel, effortOptions);
  const thinkingSegmentOptions = useMemo(() => buildThinkingSegmentOptions({
    labels: modelText, effortOptions, thinkingEnabled, effortLevelExplicit, effortLevel,
    setThinkingEnabled, setEffortLevel, setAutomaticEffortLevel,
  }), [effortLevel, effortLevelExplicit, effortOptions, modelText, setAutomaticEffortLevel, setEffortLevel, setThinkingEnabled, thinkingEnabled]);
  const supportsThinkingControls = !showModelSettingsPrompt && engine.kind === 'native'
    ? displayProvider === 'xiaomi'
      || Boolean(selectedNativeOption?.features.includes('reasoning'))
      || /reason|thinking|think|mimo|r1|o\d/i.test(displayModel)
    : false;
  const reasoningSegmentMode = getReasoningSegmentMode({
    engineKind: engine.kind,
    showModelSettingsPrompt,
    effortOptionCount: effortOptions.length,
  });
  const selectedNativeBillingSummary = engine.kind === 'native'
    ? buildProviderBillingSummary(selectedNativeOption?.providerBillingMode, panelText)
    : null;
  const selectedNativeHealthSummary = engine.kind === 'native'
    ? buildProviderHealthSummary(healthMap[displayProvider], panelText)
    : null;
  const triggerTitle = engine.kind !== 'native'
    ? formatExternalModelSwitcherTooltip({
      language,
      engineLabel: ENGINE_SHORT_LABEL[engine.kind],
      model: engine.model,
    })
    : showModelSettingsPrompt
      ? modelText.switcherTooltip.noModel
      : formatNativeModelSwitcherTooltip({
        language,
        engineLabel: ENGINE_SHORT_LABEL[engine.kind],
        currentModel,
        displayProvider,
        displayModel,
        adaptive: overrideAdaptive,
        overridden: isOverridden,
        billingSummary: selectedNativeBillingSummary,
        healthSummary: selectedNativeHealthSummary,
        effort: selectedEffort,
        thinkingEnabled: supportsThinkingControls ? thinkingEnabled : null,
      });
  const handleTriggerClick = useCallback(() => {
    setOpen((value) => !value);
  }, []);
  const handleEngineMenuViewChange = useCallback((view: EngineMenuView) => {
    setEngineMenuView(view);
    setSearchQuery('');
  }, []);
  const handleSelectEngine = useCallback(async (source: AgentEngineSourceDescriptor) => {
    if (!sessionId || !source.kind || !source.selectable) return;
    const descriptorResponse = await window.domainAPI?.invoke(
      IPC_DOMAINS.AGENT_ENGINE,
      'get',
      { kind: source.kind },
    );
    if (!descriptorResponse?.success || !descriptorResponse.data) {
      toast.error(descriptorResponse?.error?.message || panelText.engineProbeUnavailable);
      return;
    }
    setBusyEngineId(source.manifestId);
    try {
      const descriptor = descriptorResponse.data as Parameters<typeof buildModelSwitcherEngineSelection>[0];
      const workingDirectory = session?.workingDirectory ?? appWorkingDirectory ?? undefined;
      await updateSessionEngine(
        sessionId,
        buildModelSwitcherEngineSelection(
          descriptor,
          workingDirectory,
          source.kind === 'native'
            ? undefined
            : engineCatalog?.engines.find((item) => item.kind === source.kind)?.defaultModel,
        ),
      );
      setEngineMenuView('models');
      setSearchQuery('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : panelText.engineSwitchFailed);
    } finally {
      setBusyEngineId(null);
    }
  }, [
    appWorkingDirectory,
    engineCatalog?.engines,
    session?.workingDirectory,
    sessionId,
    updateSessionEngine,
  ]);
  const handleSelectExternalModel = useCallback(async (
    kind: ExternalAgentEngineKind,
    model: string,
  ) => {
    if (!sessionId) return;
    setBusyEngineId(kind);
    try {
      await updateSessionEngine(sessionId, {
        kind,
        model,
        permissionProfile: 'read_only',
        cwd: session?.workingDirectory ?? appWorkingDirectory ?? undefined,
      });
      setSearchQuery('');
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : panelText.externalModelSwitchFailed);
    } finally {
      setBusyEngineId(null);
    }
  }, [appWorkingDirectory, session?.workingDirectory, sessionId, updateSessionEngine]);
  useEffect(() => {
    if (!effortLevelExplicit) return;
    if (effortOptions.some((option) => option.value === effortLevel)) return;
    setEffortLevel(selectedEffort.value);
  }, [effortLevel, effortLevelExplicit, effortOptions, selectedEffort.value, setEffortLevel]);
  const menu = open && menuPos && (
    <div
      ref={menuRef}
      className="
        py-1 overflow-y-auto
        elevation-l2 popover-enter rounded-lg
      "
      style={{
        position: 'fixed',
        left: menuPos.left,
        bottom: menuPos.bottom,
        width: menuPos.width,
        maxHeight: menuPos.maxHeight,
        zIndex: Z_LAYERS.statusPopover,
      }}
    >
      {engineMenuView === 'engines' ? (
        <EngineScopedModelPanel
          view="engines"
          sources={engineSources}
          engineSourcesLoading={engineSourcesLoading}
          modelCatalogLoading={engineCatalogLoading}
          modelCatalogFailed={engineCatalogFailed}
          catalog={engineCatalog}
          currentEngine={engine.kind}
          currentModel={engine.model}
          query={searchQuery}
          busyEngineId={busyEngineId}
          onQueryChange={setSearchQuery}
          onViewChange={handleEngineMenuViewChange}
          onSelectEngine={(source) => void handleSelectEngine(source)}
          onSelectExternalModel={(kind, model) => void handleSelectExternalModel(kind, model)}
          onOpenSettings={openSettingsTab}
          onRetryCatalog={() => setEnginePanelReloadKey((key) => key + 1)}
        />
      ) : (
        <>
          <EngineScopedModelPanel
            view="models"
            sources={engineSources}
            engineSourcesLoading={engineSourcesLoading}
            modelCatalogLoading={engineCatalogLoading}
            modelCatalogFailed={engineCatalogFailed}
            catalog={engineCatalog}
            currentEngine={engine.kind}
            currentModel={engine.model}
            query={searchQuery}
            busyEngineId={busyEngineId}
            onQueryChange={setSearchQuery}
            onViewChange={handleEngineMenuViewChange}
            onSelectEngine={(source) => void handleSelectEngine(source)}
            onSelectExternalModel={(kind, model) => void handleSelectExternalModel(kind, model)}
            onOpenSettings={openSettingsTab}
            onRetryCatalog={() => setEnginePanelReloadKey((key) => key + 1)}
          />
          {engine.kind === 'native' && (
            <div className="border-b border-zinc-700/50">
              <div className="flex items-center gap-1 px-3 pt-1.5 pb-1 text-[10px] text-zinc-500">
              <Code2 className="w-3 h-3" />
              <span>{panelText.header}</span>
            </div>
            <div className="px-2 pb-1.5">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleMenuKeyDown}
                placeholder={panelText.searchPlaceholder}
                data-model-search-input
                className="
                  w-full px-2 py-1 text-xs
                  bg-zinc-900 border border-zinc-700 rounded
                  text-zinc-200 placeholder-gray-500
                  outline-none focus:border-zinc-600
                "
              />
            </div>
            <div ref={listScrollRef} className="max-h-64 overflow-y-auto pb-1">
              {showModelSettingsPrompt ? (
                  <div className="px-3 py-4 text-center">
                    <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded bg-zinc-700/60 text-zinc-300">
                      <Settings className="h-4 w-4" />
                    </div>
                    <div className="text-xs font-medium text-zinc-200">{panelText.noModelTitle}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                      {panelText.noModelBody}
                    </div>
                    <button
                      type="button"
                      onClick={handleOpenModelSettings}
                      className="mt-3 inline-flex h-7 items-center justify-center rounded bg-zinc-700 px-3 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-600"
                    >
                      {panelText.openModelSettings}
                    </button>
                  </div>
                ) : (
                  <>
                  <button
                    type="button"
                    onClick={handleSelectAuto}
                    data-model-option-index={0}
                    className={`
                      w-full text-left px-3 py-1.5 text-xs
                      border-b border-zinc-700/50
                      hover:bg-zinc-700 transition-colors
                      ${activeOptionIndex === 0 ? 'bg-zinc-700/80' : ''}
                      ${overrideAdaptive ? 'text-badge-accent' : 'text-zinc-200'}
                    `}
                  >
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-badge-accent" />
                      <span className="font-medium">{panelText.auto}</span>
                      <span className="text-gray-500 text-[10px] ml-auto">{panelText.autoHint}</span>
                    </div>
                  </button>
                  {filteredOptions.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-500 text-center">
                      {panelText.noMatch}
                    </div>
                  ) : (
                    groupedFilteredOptions.map((group) => {
                      const providerMetaTitle = buildProviderMetaTitle(group, panelText);
                      const builtinName = getProviderDisplayName(group.provider);
                      const storedName = group.providerLabel || builtinName || group.provider;
                      const providerName = storedName === builtinName ? (language === 'en' && /[\u3400-\u9fff]/.test(storedName) ? group.provider : builtinName) ?? storedName : storedName;
                      return (
                      <div key={group.provider}>
                        <div
                          className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-500"
                          title={providerMetaTitle}
                        >
                          <ProviderLogo
                            provider={group.provider}
                            label={providerName}
                            icon={group.providerIcon}
                          />
                          <span>{providerName}</span>
                          {group.providerFavorite && (
                            <Star className="h-3 w-3 fill-badge-warning text-badge-warning" />
                          )}
                          <span
                            className={`ml-auto h-1.5 w-1.5 rounded-full ${group.healthSummary.dotClass}`}
                            aria-label={interpolate(panelText.providerStatusAria, { label: group.healthSummary.label })}
                          />
                        </div>
                        {group.options.map(({ option: opt, index }) => {
                          const selected = displayModel === opt.model && displayProvider === opt.provider;
                          const rowHealthSummary = buildModelRowHealthSummary(healthMap[opt.provider], opt.model, panelText);
                          return (
                            <button
                              key={`${opt.provider}/${opt.model}`}
                              type="button"
                              onClick={() => handleSelect(opt)}
                              data-model-option-index={index}
                              className={`
                                w-full text-left px-3 py-1.5 text-xs
                                hover:bg-zinc-700 transition-colors
                                ${activeOptionIndex === index ? 'bg-zinc-700/80' : ''}
                                ${selected ? 'text-badge-accent' : 'text-zinc-300'}
                              `}
                            >
                              <div className="flex items-center gap-1 flex-wrap">
                                <span className="font-medium">{opt.label}</span>
                                {isAgenticVerifiedModel(opt.model) ? (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-badge-success"
                                    title={modelText.verifiedBadgeTitle}
                                  >
                                    <BadgeCheck className="h-3 w-3" />
                                  </span>
                                ) : (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded bg-amber-500/10 text-badge-warning/90"
                                    title={modelText.unverifiedHint}
                                  >
                                    {modelText.unverifiedShort}
                                  </span>
                                )}
                                {opt.features.map((cap) => {
                                  const cfg = CAPABILITY_CONFIG[cap];
                                  if (!cfg) return null;
                                  return (
                                    <span
                                      key={cap}
                                      className={`inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded ${cfg.color}`}
                                      title={panelText.capabilities[cap as keyof typeof panelText.capabilities] ?? cap}
                                    >
                                      {cfg.icon}
                                    </span>
                                  );
                                })}
                                {(() => {
                                  const badge = getModelPriceBadge(opt.provider, opt.model);
                                  return (
                                    <span
                                      className={`ml-auto text-[10px] tabular-nums ${badge.known ? 'text-zinc-400' : 'text-zinc-600'}`}
                                      title={badge.known
                                        ? modelText.priceCoefTitle.replace('{baseline}', PRICING_BASELINE_DEFAULT.modelId)
                                        : modelText.priceUnknownTitle}
                                    >
                                      {badge.label}
                                    </span>
                                  );
                                })()}
                              </div>
                              <span className="text-gray-500 text-[10px] inline-flex items-center gap-1">
                                {rowHealthSummary && (
                                  <span
                                    className={`inline-block w-1.5 h-1.5 rounded-full ${rowHealthSummary.dotClass}`}
                                    title={`${rowHealthSummary.label} · ${rowHealthSummary.detail}`}
                                  />
                                )}
                                {opt.model}
                              </span>
                            </button>
                          );
                        })}
                      </div>
	                      );
	                    })
	                  )}
	                  </>
              )}
            </div>
          </div>
          )}
          <ReasoningSegment
            mode={reasoningSegmentMode}
            sectionLabel={modelText.thinkingSectionLabel}
            note={modelText.thinkingExternalHint}
            options={thinkingSegmentOptions}
          />
          <SearchToggleSection
            visible={engine.kind === 'native' && !showModelSettingsPrompt}
            open={open}
            provider={displayProvider}
            model={displayModel}
          />
      {engine.kind === 'native' && isOverridden && !showModelSettingsPrompt && (
        <>
          <div className="border-t border-zinc-700 my-1" />
          <button
            type="button"
            onClick={handleClear}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:text-zinc-300 hover:bg-zinc-700"
          >
            {panelText.restoreMain}
          </button>
        </>
      )}
        </>
      )}
    </div>
  );
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTriggerClick}
        aria-label={panelText.triggerAria}
        aria-expanded={open}
        className={`
          group cursor-pointer truncate max-w-[200px] text-xs
          hover:text-zinc-100 transition-colors
          ${isOverridden ? 'text-badge-warning' : 'text-zinc-400'}
        `}
        title={humanizeInternalText(triggerTitle, language).text}
      >
        {engine.kind !== 'native' && (
          <>
            <span className="text-zinc-500 group-hover:text-zinc-100">{ENGINE_SHORT_LABEL[engine.kind]}</span>
            <span className="text-zinc-600 mx-1 group-hover:text-zinc-100">·</span>
          </>
        )}
        {displayLabel}
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
