import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CronJobDefinition } from '@shared/contract';
import { CRON_EVENT_TRIGGER } from '@shared/constants';
import { isRoleBoundCronJob } from '@shared/cronRoleBinding';
import { ArrowLeft, Clock, Settings, Terminal } from 'lucide-react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { FormField } from '../../composites/FormField';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { Textarea } from '../../primitives/Textarea';
import { useCronStore } from '../../../stores/cronStore';
import { useAppStore } from '../../../stores/appStore';
import { useMcpServerStates } from '../../../hooks/useMcpServerStates';
import {
  buildCronJobInput,
  buildDraftFromJob,
  createDefaultCronJobDraft,
  type CronJobDraft,
} from './types';
import {
  CRON_TEMPLATES,
  getMissingTemplateConnectors,
  getTemplateConnectorStatuses,
  getTemplateDisplayCopy,
  type CronTemplate,
} from './cronTemplates';
import { CronSimpleCreate } from './CronSimpleCreate';
import { eventViolationFromDraft, isEventScheduleKind } from './cronEditorEventGuard';
import { CronAgentActionFields } from './CronAgentActionFields';
import { CronDurationField } from './CronDurationField';

import { CRON_CLOUD_NOT_CONFIGURED } from '@shared/constants/cronErrors';
import { CronCloudCreateNotice } from './CronCloudCreateNotice';
import { SavedRoutineRestate } from './SavedRoutineRestate';
import { PendingRoutineRestate } from './PendingRoutineRestate';
import { usePendingRoutineGate, type PendingRoutineSave } from './usePendingRoutineGate';
import { useI18n } from '../../../hooks/useI18n';
import { showCronLoginWallWarning } from './cronLoginWallNotice';
import { CronRunsOnSelector } from './CronRunsOnSelector';
import { CronResultChannelField } from './CronResultChannel';
import { CronRunBudgetField } from './CronRunBudgetField';
import { CronEventScheduleFields } from './CronEventScheduleFields';
import { CronMailEventFields, mailEventValidationMessage } from './CronMailEventFields';
import { CronScheduleFields } from './CronScheduleFields';
import { CronTemplateRoleField } from './CronTemplateRoleField';
import { CLOUD_ROLE_BOUND_ERROR, CronCloudRoleRestriction, isCloudRoleBoundAgentDraft } from './CronCloudRoleRestriction';
import { CronWebhookScheduleFields } from './CronWebhookScheduleFields';
import { CronWebhookCreatedView } from './CronWebhookCreatedView';
import { useCronWebhookGate } from './useCronWebhookGate';
import { stashCronEditorDraft, takeCronEditorDraft } from './cronEditorDraftStash';
import { openCloudCronSettings as gotoCloudSettingsForCreate } from '../../../utils/cronCloudSettingsNavigation';
import { useScrollToEventValidation } from './useScrollToEventValidation';

interface CronJobEditorProps {
  isOpen: boolean;
  job: CronJobDefinition | null;
  copySource?: CronJobDefinition | null;
  onClose: () => void;
}

type FieldErrors = Partial<Record<keyof CronJobDraft, string>> & { form?: string; eventForm?: boolean; templateForm?: boolean; cloudUnconfigured?: boolean };

type EditorTab = 'basic' | 'action' | 'advanced';

/** Creation flow: simple (default) → pick template → fill fields → (or manual) */
type CreationStep = 'simple' | 'pick' | 'fill' | 'manual';

const TABS: { key: EditorTab; icon: React.ReactNode }[] = [
  { key: 'basic', icon: <Clock className="h-3.5 w-3.5" /> },
  { key: 'action', icon: <Terminal className="h-3.5 w-3.5" /> },
  { key: 'advanced', icon: <Settings className="h-3.5 w-3.5" /> },
];

export const CronJobEditor: React.FC<CronJobEditorProps> = ({ isOpen, job, copySource, onClose }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const saveErrorMessage = (error: unknown, fallback: string): string => {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('Cloud jobs must have an interval')) return cc.cloudIntervalHint;
    if (message.includes('Local jobs must have an interval')) return cc.localIntervalHint;
    if (message.includes(CLOUD_ROLE_BOUND_ERROR)) return cc.cloudRoleBoundHint;
    if (message.includes('runsOn is immutable')) return cc.locationImmutable;
    return message || fallback;
  };
  const { createJob, updateJob } = useCronStore();
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const templateLanguage = useAppStore((state) => (state.language === 'en' ? 'en' : 'zh'));
  const mcpServerStates = useMcpServerStates();
  const connectedConnectorIds = useMemo(
    () => new Set(
      mcpServerStates
        .filter((server) => server.status === 'connected')
        .map((server) => server.config.name),
    ),
    [mcpServerStates],
  );
  const [draft, setDraft] = useState<CronJobDraft>(createDefaultCronJobDraft());
  const [errors, setErrors] = useState<FieldErrors>({});
  const { cloud, gated: webhookGated, gotoSettings: gotoCloudSettings } = useCronWebhookGate(draft);
  // event 护栏提示的显示闸门：只在提交过或动过事件相关字段之后才亮——
  // 光选「通道消息」不填任何东西不挨红框（r2）。
  const [eventValidationArmed, setEventValidationArmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<EditorTab>('basic');
  const [eventFocusTick, setEventFocusTick] = useState(0);
  useScrollToEventValidation(eventFocusTick);

  // Template-based creation state
  const [simpleDraft, setSimpleDraft] = useState<CronJobDraft>(createDefaultCronJobDraft);
  const [step, setStep] = useState<CreationStep>('simple');
  const [selectedTemplate, setSelectedTemplate] = useState<CronTemplate | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  // 保存成功且角色绑定的任务：不直接关闭，切换到只读复述视图（Done 才关闭）。
  const [savedJob, setSavedJob] = useState<CronJobDefinition | null>(null);
  // webhook 任务创建成功后：展示一次性链接的任务 id（链接本身只活在 CronWebhookCreatedView）。
  const [webhookJobId, setWebhookJobId] = useState<string | null>(null);
  // 无角色任务（手动表单 create/edit + 模板填参）保存前先出复述卡，确认后才真正
  // createJob/updateJob（N-CRON-MORNING-TRIAGE-REST1）；角色绑定照旧直存。
  const persistPending = async (pending: PendingRoutineSave): Promise<boolean> => {
    setSubmitting(true);
    setErrors({});
    try {
      // mode=update 只可能来自编辑中的 job；updateJob 返回 null = 列表里已不在，
      // 与旧路径同款直接收尾。
      const saved = pending.mode === 'update' && job
        ? await updateJob(job.id, pending.input)
        : await createJob(pending.input);
      if (saved) {
        showCronLoginWallWarning(saved, { warning: cc.loginWallWarning, openSite: cc.loginWallOpenSite });
        if (isRoleBoundCronJob(saved)) {
          setSavedJob(saved);
          return true;
        }
        // 新建的 webhook 任务：落库后交一次性链接视图（编辑回写不走这里）。
        if (pending.mode === 'create'
          && saved.schedule?.type === 'event' && saved.schedule.source === 'webhook') {
          setWebhookJobId(saved.id);
          return true;
        }
      }
      onClose();
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === CRON_CLOUD_NOT_CONFIGURED) {
        setErrors({ cloudUnconfigured: true });
        backToEdit();
        return false;
      }
      setErrors({ form: saveErrorMessage(error, cc.simpleCreateFailed) });
      return false;
    } finally {
      setSubmitting(false);
    }
  };
  const { pending: pendingSave, gateOrPersist, confirm: confirmPending, back: backToEdit, reset: resetPending } =
    usePendingRoutineGate(persistPending);
  // savedJob 只在弹窗「关→开」转换时清：保存成功后 store 的 createJob/updateJob
  // 会 await refresh()，jobs 数组被 IPC 新对象整体替换，CronCenterPanel 派生的
  // job/copySource prop 随之换身份并重跑下面的 reset effect——若每次重跑都清，
  // update/copy 路径刚设上的复述视图会被立即重置回编辑表单（r2）。ref 记上一次
  // isOpen，身份抖动不碰 savedJob。
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const reopened = !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!isOpen) return;
    if (reopened) { setSavedJob(null); setWebhookJobId(null); resetPending(); }
    if (job) {
      setDraft(buildDraftFromJob(job));
      setStep('manual');
    } else if (copySource) {
      setDraft({
        ...buildDraftFromJob(copySource),
        name: `${copySource.name} (${copySource.runsOn === 'local' ? cc.locationCloud : cc.locationLocal})`,
        runsOn: copySource.runsOn === 'local' ? 'cloud' : 'local',
        enabled: false,
        // 副本是新任务：不继承原任务的 metadata（artifactRefresh 等绑定指向原文件路径，
        // 复制过去会让副本在别的 runsOn 上顶着同一份刷新绑定）。
        metadata: undefined,
      });
      setStep('manual');
    } else {
      // 从「去设置」回来：取回暂存草稿，不让用户重填整张表单。
      const stashed = takeCronEditorDraft();
      setDraft(stashed ?? createDefaultCronJobDraft());
      setStep(stashed ? 'manual' : 'simple');
      setSelectedTemplate(null);
      setTemplateValues({});
    }
    setErrors({});
    setEventValidationArmed(false);
    setActiveTab('basic');
  }, [isOpen, job, copySource, cc.locationCloud, cc.locationLocal]);

  const title = job
    ? cc.editTitle
    : copySource
      ? cc.copyTitle
    : step === 'simple'
      ? cc.simpleTitle
      : step === 'pick'
        ? cc.editorChrome.selectTemplateTitle
        : step === 'fill'
          ? (selectedTemplate ? getTemplateDisplayCopy(selectedTemplate, cc.templates).name : '') || cc.editorChrome.fillTemplateTitle
          : cc.manualTitle;

  const scheduleOptions = useMemo(
    () => [
      { value: 'at', label: cc.manualEditor.oneTimeScheduleOption },
      { value: 'every', label: cc.manualEditor.intervalScheduleOption },
      { value: 'cron', label: cc.manualEditor.cronScheduleOption },
      { value: 'event', label: cc.eventScheduleOption },
      { value: 'event-mail', label: cc.eventMailScheduleOption },
      { value: 'event-webhook', label: cc.eventWebhookScheduleOption },
    ],
    [cc.eventScheduleOption, cc.eventMailScheduleOption, cc.eventWebhookScheduleOption, cc.manualEditor]
  );

  // event 调度的创建期护栏（host createJob 同款）：只允许本机 + Agent 动作。
  const actionOptions = useMemo(
    () => (isEventScheduleKind(draft.scheduleType)
      ? [{ value: 'agent', label: cc.editorChrome.agentActionOption }]
      : [
        { value: 'shell', label: cc.editorChrome.shellActionOption },
        { value: 'tool', label: cc.editorChrome.toolActionOption },
        { value: 'agent', label: cc.editorChrome.agentActionOption },
        { value: 'webhook', label: 'Webhook' },
        { value: 'ipc', label: cc.editorChrome.ipcActionOption },
      ]),
    [draft.scheduleType, cc.editorChrome]
  );

  // 从别的调度切到 event 系（或复制出 event 任务）时钉死护栏前置项：本机 + Agent。
  // 不静默留一个注定被 createJob 拒绝的组合在表单里。
  useEffect(() => {
    if (isEventScheduleKind(draft.scheduleType) && (draft.runsOn !== 'local' || draft.actionType !== 'agent')) {
      setDraft((current) => ({ ...current, runsOn: 'local', actionType: 'agent' }));
    }
  }, [draft.scheduleType, draft.runsOn, draft.actionType]);

  // event 护栏：判据与 buildCronJobInput/createJob 同一份 shared 校验器，但展示走
  // reason → 本地化文案（用户看到的不是 createJob 的英文原文）；且只在闸门打开
  // （提交过/动过事件字段）后才显示，选完调度类型不立刻报。
  const eventViolation = isEventScheduleKind(draft.scheduleType) ? eventViolationFromDraft(draft) : null;
  const eventValidationMessage = eventValidationArmed && eventViolation ? cc.eventValidation[eventViolation.reason] : null;
  useEffect(() => {
    if (errors.eventForm && !eventViolation) setErrors((prev) => ({ ...prev, form: undefined, eventForm: false }));
  }, [errors.eventForm, eventViolation]);
  useEffect(() => {
    if (!errors.templateForm || !selectedTemplate) return;
    const missing = selectedTemplate.fields.filter((f) => f.required && !templateValues[f.key]?.trim());
    setErrors((prev) => !prev.templateForm ? prev : missing.length > 0
      ? { ...prev, form: cc.editorChrome.requiredFieldsError.replace('{fields}', missing.map((f) => f.label).join(cc.editorChrome.fieldListSeparator)) }
      : { ...prev, form: undefined, templateForm: false });
  }, [errors.templateForm, selectedTemplate, templateValues, cc.editorChrome]);
  const cloudRoleBound = isCloudRoleBoundAgentDraft(draft);
  const setField = <K extends keyof CronJobDraft>(key: K, value: CronJobDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const setEventField = <K extends keyof CronJobDraft>(key: K, value: CronJobDraft[K]) => {
    setField(key, value);
    setEventValidationArmed(true);
    setErrors((prev) => (prev.eventForm ? { ...prev, form: undefined, eventForm: false } : prev));
  };

  const handlePickTemplate = (tpl: CronTemplate) => {
    setSelectedTemplate(tpl);
    const initial: Record<string, string> = {};
    for (const f of tpl.fields) initial[f.key] = '';
    setTemplateValues(initial);
    // event 模板（群监听）：填参步骤直接渲染事件字段，先把护栏前置项和预算预填好
    //（预算缺省 0.5 可改，owner 裁定；账号/群等用户选）。
    if (tpl.event) {
      setDraft((current) => ({
        ...current,
        scheduleType: 'event',
        actionType: 'agent',
        runsOn: 'local',
        maxRunBudget: current.maxRunBudget.trim() === ''
          ? String(CRON_EVENT_TRIGGER.DEFAULT_RUN_BUDGET_USD)
          : current.maxRunBudget,
      }));
    }
    setStep('fill');
  };

  const handleTemplateSubmit = async () => {
    if (!selectedTemplate) return;

    // Validate required fields
    const missing = selectedTemplate.fields.filter((f) => f.required && !templateValues[f.key]?.trim());
    if (missing.length > 0) {
      setErrors({ form: cc.editorChrome.requiredFieldsError.replace('{fields}', missing.map((f) => f.label).join(cc.editorChrome.fieldListSeparator)), templateForm: true });
      return;
    }

    // event 模板（群监听）：账号/群/预算是填参步骤的 live 草稿字段，提交前先过共享
    // 校验器（reason → 本地化文案），再把它们注入 generate —— 模板字段本身不出现这些键。
    if (selectedTemplate.event) {
      const violation = eventViolationFromDraft(draft);
      if (violation) {
        setErrors({ form: cc.eventValidation[violation.reason], eventForm: true });
        return;
      }
    }

    setSubmitting(true);
    setErrors({});
    try {
      const generatedDraft = selectedTemplate.event
        ? selectedTemplate.generate({
          ...templateValues,
          accountId: draft.eventAccountId,
          chatId: draft.eventChatId,
          budget: draft.maxRunBudget,
        }, templateLanguage)
        : selectedTemplate.generate(templateValues, templateLanguage);
      // event 任务钉本机（填参步骤不渲染运行位置选择）；其余模板沿用用户的选择。
      generatedDraft.runsOn = selectedTemplate.event ? 'local' : draft.runsOn;
      if (!selectedTemplate.event) generatedDraft.maxRunBudget = draft.runsOn === 'local' ? draft.maxRunBudget : '';
      const input = buildCronJobInput(generatedDraft, cc.editorChrome.validation);
      // 无角色任务先挂起出复述卡；角色绑定（如晨间分诊选了角色）照旧直存。
      await gateOrPersist(input, 'create');
    } catch (error) {
      setErrors(error instanceof Error && 'code' in error && error.code === CRON_CLOUD_NOT_CONFIGURED
        ? { cloudUnconfigured: true }
        : { form: saveErrorMessage(error, cc.simpleCreateFailed) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setErrors({});

    try {
      // event 护栏先行：本地化文案直接进表单错误框（buildCronJobInput 的英文兜底
      // 不会再被用户看到），同时打开内联提示的闸门。mail 源的 invalid-schedule
      //（还没选账号）用邮件专用文案。
      if (isEventScheduleKind(draft.scheduleType)) {
        const violation = eventViolationFromDraft(draft);
        if (violation) {
          setEventValidationArmed(true);
          if (violation.reason === 'invalid-schedule' || violation.reason === 'requires-budget') {
            setActiveTab('basic');
            setEventFocusTick((tick) => tick + 1);
          }
          setErrors({
            form: draft.scheduleType === 'event-mail'
              ? mailEventValidationMessage(violation, cc)
              : cc.eventValidation[violation.reason],
            eventForm: true,
          });
          return;
        }
      }
      const input = buildCronJobInput(draft, cc.editorChrome.validation);
      await gateOrPersist(input, job ? 'update' : 'create');
    } catch (error) {
      setErrors(error instanceof Error && 'code' in error && error.code === CRON_CLOUD_NOT_CONFIGURED
        ? { cloudUnconfigured: true }
        : { form: saveErrorMessage(error, cc.simpleCreateFailed) });
    } finally {
      setSubmitting(false);
    }
  };

  const cloudNotice = errors.cloudUnconfigured && <CronCloudCreateNotice
    onSwitchLocal={() => { setDraft((current) => ({ ...current, runsOn: 'local' })); setErrors({}); }}
    onSettings={() => {
      const filled = step === 'fill' && selectedTemplate ? selectedTemplate.generate(templateValues) : draft;
      stashCronEditorDraft({ ...filled, runsOn: draft.runsOn });
      gotoCloudSettingsForCreate();
    }}
  />;

  // ── Saved restate view（角色绑定任务保存成功后）─────────────────────
  if (savedJob) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={title}>
        <SavedRoutineRestate job={savedJob} onDone={onClose} />
      </Modal>
    );
  }

  // ── Webhook 一次性链接视图（创建成功后）────────────────────────────
  if (webhookJobId) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={cc.webhook.cardTitle}>
        <CronWebhookCreatedView jobId={webhookJobId} onDone={onClose} />
      </Modal>
    );
  }

  // ── 保存前确认卡（无角色任务，确认后才 createJob/updateJob）────────
  if (pendingSave) {
    return (
      <Modal isOpen={isOpen} onClose={submitting ? undefined : onClose} title={title}>
        <PendingRoutineRestate
          input={pendingSave.input}
          mode={pendingSave.mode}
          confirming={submitting}
          error={errors.form ?? null}
          onConfirm={() => void confirmPending()}
          onBack={backToEdit}
        />
      </Modal>
    );
  }

  // ── Simple create step (default) ───────────────────────────────────
  if (!job && step === 'simple') {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg">
        <CronSimpleCreate onDone={onClose} onDraftChange={setSimpleDraft} />
        <div className="mt-4 flex items-center justify-center gap-4 border-t border-zinc-800 pt-3 text-xs">
          <button /* ds-allow:button: 纯文本次级链接（text-xs 无底色），primitive 变体会渲染按钮外观 */
            onClick={() => setStep('pick')}
            className="text-zinc-500 transition-colors hover:text-zinc-300"
          >
            {cc.fromTemplate}
          </button>
          <span className="h-3 w-px bg-zinc-800" />
          <button /* ds-allow:button: 同上，纯文本次级链接 */
            onClick={() => { setDraft(simpleDraft); setStep('manual'); }}
            className="text-zinc-500 transition-colors hover:text-zinc-300"
          >
            {cc.manualConfig}
          </button>
        </div>
      </Modal>
    );
  }

  // ── Template picker step ───────────────────────────────────────────
  if (!job && step === 'pick') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={title}
        size="lg"
      >
        <div className="grid grid-cols-2 gap-3">
          {CRON_TEMPLATES.map((tpl) => {
            const connectorStatuses = getTemplateConnectorStatuses(tpl, connectedConnectorIds);
            const copy = getTemplateDisplayCopy(tpl, cc.templates);
            return (
              <button
                key={tpl.id}
                onClick={() => handlePickTemplate(tpl)}
                className="group rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-900/60"
              >
                <div className="mb-2 text-2xl">{tpl.emoji}</div>
                <div className="text-sm font-medium text-zinc-200 group-hover:text-zinc-100">
                  {copy.name}
                </div>
                <div className="mt-1 text-xs text-zinc-500 group-hover:text-zinc-400">
                  {copy.description}
                </div>
                {connectorStatuses.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {connectorStatuses.map((status) => (
                      <span key={status.id} className="inline-flex items-center gap-1 text-[11px]">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${status.connected ? 'bg-mark-success' : 'bg-zinc-600'}`}
                          aria-hidden="true"
                        />
                        <span className={status.connected ? 'text-badge-success' : 'text-zinc-500'}>
                          {cc.connectorNames[status.id] ?? status.label}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-center gap-4 text-xs">
          <button /* ds-allow:button: 同上，纯文本次级链接 */
            onClick={() => setStep('simple')}
            className="text-zinc-500 transition-colors hover:text-zinc-300"
          >
            {cc.backToSimple}
          </button>
          <span className="h-3 w-px bg-zinc-800" />
          <button /* ds-allow:button: 同上，纯文本次级链接 */
            onClick={() => setStep('manual')}
            className="text-zinc-500 transition-colors hover:text-zinc-300"
          >
            {cc.editorChrome.skipTemplate}
          </button>
        </div>
      </Modal>
    );
  }

  // ── Template fill step ─────────────────────────────────────────────
  if (!job && step === 'fill' && selectedTemplate) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={submitting ? undefined : onClose}
        title={title}
        size="lg"
        footer={(
          <>
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              {cc.editorChrome.cancel}
            </Button>
            <Button onClick={handleTemplateSubmit} loading={submitting}>
              {cc.editorChrome.createTask}
            </Button>
          </>
        )}
      >
        <div className="-mx-6 -mt-4 border-b border-zinc-800 px-6 py-3">
          <button
            onClick={() => setStep('pick')}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {cc.editorChrome.backToTemplates}
          </button>
        </div>

        {cloudNotice}
        {errors.form && (
          <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-badge-danger">
            {errors.form}
          </div>
        )}

        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
            <span className="text-2xl">{selectedTemplate.emoji}</span>
            <div>
              <div className="text-sm font-medium text-zinc-200">
                {getTemplateDisplayCopy(selectedTemplate, cc.templates).name}
              </div>
              <div className="text-xs text-zinc-500">
                {getTemplateDisplayCopy(selectedTemplate, cc.templates).description}
              </div>
            </div>
          </div>

          {(() => {
            const missingConnectors = getMissingTemplateConnectors(
              getTemplateConnectorStatuses(selectedTemplate, connectedConnectorIds),
            );
            if (missingConnectors.length === 0) return null;
            return (
              <div
                className="flex flex-wrap items-center gap-1.5 rounded-lg border border-badge-warning/20 bg-amber-500/10 px-3 py-2 text-xs text-badge-warning"
                data-testid="cron-template-connector-gate-hint"
              >
                <span>
                  {cc.connectorNeededHint.replace(
                    '{name}',
                    missingConnectors.map((status) => cc.connectorNames[status.id] ?? status.label).join('、'),
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => openSettingsTab('mcp')}
                  className="underline decoration-dotted hover:text-badge-warning"
                >
                  {cc.connectorConnectAction}
                </button>
              </div>
            );
          })()}

          {selectedTemplate.fields.map((field) => (
            field.type === 'role' ? (
              <CronTemplateRoleField
                key={field.key}
                value={templateValues[field.key] || ''}
                onChange={(roleId) => setTemplateValues((prev) => ({ ...prev, [field.key]: roleId }))}
              />
            ) : (
              <FormField key={field.key} label={field.label} required={field.required}>
                {field.type === 'textarea' ? (
                  <Textarea
                    value={templateValues[field.key] || ''}
                    onChange={(e) =>
                      setTemplateValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                    minRows={3}
                    className="font-mono"
                  />
                ) : (
                  <Input
                    value={templateValues[field.key] || ''}
                    onChange={(e) =>
                      setTemplateValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                  />
                )}
              </FormField>
            )
          ))}

          {selectedTemplate.event ? (
            <CronEventScheduleFields
              accountId={draft.eventAccountId}
              chatId={draft.eventChatId}
              onAccountChange={(eventAccountId) => setEventField('eventAccountId', eventAccountId)}
              onChatChange={(eventChatId) => setEventField('eventChatId', eventChatId)}
              maxRunBudget={draft.maxRunBudget}
              onBudgetChange={(maxRunBudget) => setEventField('maxRunBudget', maxRunBudget)}
              validationMessage={(() => {
                const violation = eventViolationFromDraft(draft);
                return violation ? cc.eventValidation[violation.reason] : null;
              })()}
            />
          ) : (
            <>
              <CronRunsOnSelector
                value={draft.runsOn}
                onChange={(runsOn) => setField('runsOn', runsOn)}
              />
              {draft.runsOn === 'local' && (
                <CronRunBudgetField
                  value={draft.maxRunBudget}
                  onChange={(maxRunBudget) => setField('maxRunBudget', maxRunBudget)}
                />
              )}
            </>
          )}
        </div>
      </Modal>
    );
  }

  // ── Manual editor (existing tab-based UI) ──────────────────────────
  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? undefined : onClose}
      title={title}
      size="lg"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>{cc.editorChrome.cancel}</Button>
          <Button onClick={handleSubmit} loading={submitting} disabled={cloudRoleBound || webhookGated}>{job ? cc.editorChrome.saveChanges : cc.editorChrome.createTask}</Button>
        </>
      )}
    >
      {/* Back to template picker (only for new jobs in manual mode) */}
      {!job && !copySource && (
        <div className="-mx-6 -mt-4 border-b border-zinc-800 px-6 py-3">
          <button
            onClick={() => setStep('pick')}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {cc.editorChrome.backToTemplates}
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className={`-mx-6 mb-4 flex border-b border-zinc-800 px-6 ${!job ? '' : '-mt-4'}`}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? 'border-zinc-400 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab.icon}
            {cc.editorChrome.tabs[tab.key]}
          </button>
        ))}
      </div>

      {cloudNotice}
      {errors.form && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-badge-danger">
          {errors.form}
        </div>
      )}

      {/* Tab: 基本设置 */}
      {activeTab === 'basic' && (
        <div className="space-y-4">
          <div className="space-y-3">
            <FormField label={cc.editorChrome.taskNameLabel} required error={errors.name}>
              <Input
                value={draft.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder={cc.editorChrome.taskNamePlaceholder}
              />
            </FormField>
            <FormField label={cc.editorChrome.descriptionLabel}>
              <Textarea
                value={draft.description}
                onChange={(e) => setField('description', e.target.value)}
                minRows={2}
                placeholder={cc.editorChrome.descriptionPlaceholder}
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={cc.editorChrome.tagsLabel}>
                <Input
                  value={draft.tagsText}
                  onChange={(e) => setField('tagsText', e.target.value)}
                  placeholder="daily, backup"
                />
              </FormField>
              <FormField label={cc.editorChrome.statusLabel}>
                <label className="flex h-9 items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setField('enabled', e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-800"
                  />
                  {job ? cc.enabledStatus : cc.enableAfterCreate}
                </label>
              </FormField>
            </div>
          </div>

          <CronResultChannelField
            value={draft.resultChannel}
            onChange={(resultChannel) => setField('resultChannel', resultChannel)}
          />

          <CronRunsOnSelector
            value={draft.runsOn}
            onChange={(runsOn) => setField('runsOn', runsOn)}
            readOnly={Boolean(job) || isEventScheduleKind(draft.scheduleType)}
          />
          <CronCloudRoleRestriction draft={draft} message={cc.cloudRoleBoundHint} />

          <div className="border-t border-zinc-800 pt-4">
            <h4 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
              <Clock className="h-3.5 w-3.5" />
              {cc.editorChrome.scheduleSectionTitle}
            </h4>
            <div className="space-y-3">
              <FormField label={cc.editorChrome.scheduleTypeLabel}>
                <Select
                  data-testid="cron-schedule-type-select"
                  value={draft.scheduleType}
                  options={scheduleOptions}
                  onChange={(e) => setField('scheduleType', e.target.value as CronJobDraft['scheduleType'])}
                />
              </FormField>

              <CronScheduleFields draft={draft} setField={setField} errors={errors} />

              {draft.scheduleType === 'event' && (
                <CronEventScheduleFields
                  accountId={draft.eventAccountId}
                  chatId={draft.eventChatId}
                  onAccountChange={(eventAccountId) => setEventField('eventAccountId', eventAccountId)}
                  onChatChange={(eventChatId) => setEventField('eventChatId', eventChatId)}
                  maxRunBudget={draft.maxRunBudget}
                  onBudgetChange={(maxRunBudget) => setEventField('maxRunBudget', maxRunBudget)}
                  validationMessage={eventValidationMessage}
                />
              )}

              {draft.scheduleType === 'event-webhook' && (
                <CronWebhookScheduleFields
                  loading={cloud.loading}
                  configured={cloud.configured}
                  onGotoSettings={gotoCloudSettings}
                  maxRunBudget={draft.maxRunBudget}
                  onBudgetChange={(maxRunBudget) => setEventField('maxRunBudget', maxRunBudget)}
                  validationMessage={eventValidationMessage}
                />
              )}

              {draft.scheduleType === 'event-mail' && (
                <CronMailEventFields
                  accountId={draft.eventMailAccountId}
                  mailbox={draft.eventMailMailbox}
                  onAccountChange={(eventMailAccountId) => setEventField('eventMailAccountId', eventMailAccountId)}
                  onMailboxChange={(eventMailMailbox) => setEventField('eventMailMailbox', eventMailMailbox)}
                  maxRunBudget={draft.maxRunBudget}
                  onBudgetChange={(maxRunBudget) => setEventField('maxRunBudget', maxRunBudget)}
                  // 与通道分支同一道显示闸门：光选「新邮件」不填不挨红框（r2 口径）。
                  violation={eventValidationArmed ? eventViolation : null}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab: 执行动作 */}
      {activeTab === 'action' && (
        <div className="space-y-3">
          <FormField label={cc.editorChrome.actionTypeLabel}>
            <Select
              value={draft.actionType}
              options={actionOptions}
              onChange={(e) => setField('actionType', e.target.value as CronJobDraft['actionType'])}
            />
          </FormField>

          {draft.actionType === 'shell' && (
            <>
              <FormField label={cc.editorChrome.commandLabel} required error={errors.shellCommand}>
                <Textarea
                  value={draft.shellCommand}
                  onChange={(e) => setField('shellCommand', e.target.value)}
                  minRows={4}
                  className="font-mono"
                  placeholder="echo 'hello world'"
                />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label={cc.editorChrome.workingDirectoryLabel}>
                  <Input
                    value={draft.shellCwd}
                    onChange={(e) => setField('shellCwd', e.target.value)}
                    placeholder={cc.editorChrome.workingDirectoryPlaceholder}
                  />
                </FormField>
                <FormField label={cc.editorChrome.terminalModeLabel}>
                  <label className="flex h-9 items-center gap-2 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={draft.shellUsePty}
                      onChange={(e) => setField('shellUsePty', e.target.checked)}
                      className="rounded border-zinc-700 bg-zinc-800"
                    />
                    {cc.editorChrome.usePtyLabel}
                  </label>
                </FormField>
              </div>
            </>
          )}

          {draft.actionType === 'tool' && (
            <>
              <FormField label={cc.editorChrome.toolNameLabel} required error={errors.toolName}>
                <Input value={draft.toolName} onChange={(e) => setField('toolName', e.target.value)} />
              </FormField>
              <FormField label={cc.editorChrome.toolParametersLabel}>
                <Textarea
                  value={draft.toolParametersText}
                  onChange={(e) => setField('toolParametersText', e.target.value)}
                  minRows={6}
                  className="font-mono"
                />
              </FormField>
            </>
          )}

          {draft.actionType === 'agent' && (
            <CronAgentActionFields draft={draft} setField={setField} errors={errors} />
          )}

          {draft.actionType === 'webhook' && (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <FormField label="URL" required error={errors.webhookUrl}>
                  <Input
                    value={draft.webhookUrl}
                    onChange={(e) => setField('webhookUrl', e.target.value)}
                    placeholder="https://example.com/webhook"
                  />
                </FormField>
                <FormField label="Method">
                  <Select
                    value={draft.webhookMethod}
                    onChange={(e) => setField('webhookMethod', e.target.value as CronJobDraft['webhookMethod'])}
                    options={[
                      { value: 'GET', label: 'GET' },
                      { value: 'POST', label: 'POST' },
                      { value: 'PUT', label: 'PUT' },
                      { value: 'DELETE', label: 'DELETE' },
                    ]}
                  />
                </FormField>
              </div>
              <FormField label="Headers (JSON)">
                <Textarea
                  value={draft.webhookHeadersText}
                  onChange={(e) => setField('webhookHeadersText', e.target.value)}
                  minRows={3}
                  className="font-mono"
                />
              </FormField>
              <FormField label="Body (JSON)">
                <Textarea
                  value={draft.webhookBodyText}
                  onChange={(e) => setField('webhookBodyText', e.target.value)}
                  minRows={3}
                  className="font-mono"
                />
              </FormField>
            </>
          )}

          {draft.actionType === 'ipc' && (
            <>
              <FormField label="Channel" required error={errors.ipcChannel}>
                <Input value={draft.ipcChannel} onChange={(e) => setField('ipcChannel', e.target.value)} />
              </FormField>
              <FormField label="Payload (JSON)">
                <Textarea
                  value={draft.ipcPayloadText}
                  onChange={(e) => setField('ipcPayloadText', e.target.value)}
                  minRows={6}
                  className="font-mono"
                />
              </FormField>
            </>
          )}
        </div>
      )}

      {/* Tab: 高级选项 */}
      {activeTab === 'advanced' && (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">{cc.editorChrome.advancedIntro}</p>
          <div className="grid gap-3">
            <FormField label={cc.editorChrome.maxRetriesLabel}>
              <Input
                type="number"
                value={draft.maxRetries}
                onChange={(e) => setField('maxRetries', e.target.value)}
                placeholder="0"
              />
            </FormField>
            <CronDurationField
              label={cc.manualEditor.retryDelayLabel} value={draft.retryDelay} onChange={(value) => setField('retryDelay', value)}
              placeholder={cc.manualEditor.retryDelayPlaceholder} hint={cc.manualEditor.retryDelayHint} invalidMessage={cc.manualEditor.durationInvalid}
              testId="cron-retry-delay" unitLabels={cc.manualEditor.durationUnits} maxUnit="minutes"
            />
            <CronDurationField
              label={cc.manualEditor.timeoutLabel} value={draft.timeout} onChange={(value) => setField('timeout', value)}
              placeholder={cc.manualEditor.timeoutPlaceholder} invalidMessage={cc.manualEditor.durationInvalid}
              testId="cron-timeout" unitLabels={cc.manualEditor.durationUnits} maxUnit="hours"
            />
          </div>
          {draft.runsOn !== 'cloud' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={cc.editorChrome.runBudgetLabel} hint={cc.editorChrome.runBudgetHint}>
                <Input
                  type="number"
                  value={draft.maxRunBudget}
                  onChange={(e) => {
                    // event 任务的预算也在这里改（与事件字段同一 draft 字段），同步开闸。
                    if (isEventScheduleKind(draft.scheduleType)) setEventField('maxRunBudget', e.target.value);
                    else setField('maxRunBudget', e.target.value);
                  }}
                  placeholder={cc.editorChrome.unlimitedPlaceholder}
                  data-testid="cron-budget-limit-input"
                />
              </FormField>
              <FormField
                label={cc.editorChrome.maxRunsLabel}
                hint={job?.maxRuns != null && job.runCount != null
                  ? cc.editorChrome.maxRunsHintWithProgress.replace('{runCount}', String(job.runCount)).replace('{maxRuns}', String(job.maxRuns))
                  : cc.editorChrome.maxRunsHint}
              >
                <Input
                  type="number"
                  value={draft.maxRuns}
                  onChange={(e) => setField('maxRuns', e.target.value)}
                  placeholder={cc.editorChrome.unlimitedPlaceholder}
                  data-testid="cron-maxruns-limit-input"
                />
              </FormField>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default CronJobEditor;
