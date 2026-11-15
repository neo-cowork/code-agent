// ============================================================================
// MeetingsView — 资料库「会议」视图（N-MEETING-PAGE ①⑤）：会议列表 + 导入妙记 / 腾讯会议 + 打开会议页
// 嵌在 LibraryPanel 同一个整页容器里（与「品牌套件」同一入口模式），不新造容器。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { MeetingImportCandidate, MeetingSummaryRecord } from '@shared/contract/audioCapture';
import { importMeeting, listMeetingImportCandidates, listMeetingRecords } from '../../../services/nativeDesktop';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';
import { toast } from '../../../hooks/useToast';
import { Button } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { Modal } from '../../primitives/Modal';
import { MeetingPage, formatClock, sourceLabel } from './MeetingPage';

type Copy = ReturnType<typeof useI18n>['t']['library']['meetings'];

function minutesBadge(m: MeetingSummaryRecord, copy: Copy): string {
  if (m.state !== 'ended') return copy.inProgress;
  if (m.minutesState === 'done') return `${copy.minutes} · ${m.minutes?.actionItems.length ?? 0} ${copy.actionItems}`;
  if (m.minutesState === 'pending' || m.minutesState === 'running') return copy.minutesRunning;
  if (m.minutesState === 'failed') return copy.minutesFailedShort;
  if (m.minutesState === 'skipped') return copy.minutesSkippedShort;
  return copy.minutesNone;
}

const ImportDialog: React.FC<{ copy: Copy; onClose: () => void; onImported: (id: string) => void }> = ({ copy, onClose, onImported }) => {
  const [link, setLink] = useState('');
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<MeetingImportCandidate[]>([]);
  const [errors, setErrors] = useState<Partial<Record<'feishu' | 'tmeet', string>>>({});
  const [busyRef, setBusyRef] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMeetingImportCandidates()
      .then((r) => { if (!cancelled) { setCandidates(r.candidates); setErrors(r.errors); } })
      .catch((e) => { if (!cancelled) setErrors({ feishu: String(e), tmeet: String(e) }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const run = async (candidate: MeetingImportCandidate) => {
    setBusyRef(candidate.ref);
    try {
      const r = await importMeeting(candidate);
      if (!r.created) toast.info(copy.importedBefore);
      onImported(r.id);
    } catch (e) {
      toast.error(interpolate(copy.importFailed, { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyRef(null);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={copy.importTitle} size="md">
      <div className="space-y-4" data-testid="meeting-import-dialog">
        <div>
          <label className="mb-1 block text-xs text-zinc-400" htmlFor="meeting-import-link">{copy.importLinkLabel}</label>
          <div className="flex gap-2">
            <Input id="meeting-import-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder={copy.importLinkPlaceholder} className="h-8 flex-1 text-xs" />
            <Button type="button" size="sm" variant="primary" disabled={!link.trim() || busyRef !== null}
              onClick={() => { void run({ source: 'feishu', ref: link.trim(), title: '', startedAtMs: null }); }}>
              {busyRef === link.trim() ? copy.importing : copy.importLinkSubmit}
            </Button>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-xs text-zinc-400">{copy.importRecent}</div>
          {loading ? <p className="text-xs text-zinc-500"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />{copy.importLoading}</p> : (
            <>
              {(['feishu', 'tmeet'] as const).filter((s) => errors[s]).map((s) => (
                <p key={s} className="mb-1 text-[11px] text-badge-warning">
                  {interpolate(copy.importUnavailable, { source: s === 'feishu' ? copy.sourceFeishu : copy.sourceTmeet, reason: errors[s] ?? '' })}
                </p>
              ))}
              {candidates.length === 0 ? <p className="text-xs text-zinc-500">{copy.importNone}</p> : (
                <ul className="max-h-72 space-y-1 overflow-y-auto">
                  {candidates.map((c) => (
                    <li key={`${c.source}-${c.ref}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-zinc-800/60">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-zinc-200">{c.title}</div>
                        <div className="text-[11px] text-zinc-500">
                          {c.source === 'feishu' ? copy.sourceFeishu : copy.sourceTmeet}
                          {c.startedAtMs ? ` · ${new Date(c.startedAtMs).toLocaleDateString()} ${formatClock(c.startedAtMs)}` : ''}
                        </div>
                      </div>
                      <Button type="button" size="sm" variant="secondary" disabled={busyRef !== null} onClick={() => { void run(c); }}>
                        {busyRef === c.ref ? copy.importing : copy.importLinkSubmit}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};

export const MeetingsView: React.FC<{ initialMeetingId?: string | null }> = ({ initialMeetingId = null }) => {
  const { t } = useI18n();
  const copy = t.library.meetings;
  const [meetings, setMeetings] = useState<MeetingSummaryRecord[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialMeetingId);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setMeetings(await listMeetingRecords());
    } catch {
      setMeetings([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (openId) return <MeetingPage meetingId={openId} onBack={() => { setOpenId(null); void load(); }} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="meetings-view">
      <div className="flex shrink-0 items-center justify-end px-6 py-3">
        <Button type="button" size="sm" variant="secondary" data-testid="meeting-import" onClick={() => setImportOpen(true)}>
          <Download className="h-3.5 w-3.5" />
          {copy.import}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {meetings === null ? (
          <div className="flex justify-center py-16 text-zinc-500"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : meetings.length === 0 ? (
          <p className="py-16 text-center text-sm leading-relaxed text-zinc-500">{copy.empty}</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {meetings.map((m) => (
              <li key={m.id}>
                <button /* ds-allow:button: 会议列表行，全宽左对齐两行内容，primitive 居中变体不兼容 */
                  type="button"
                  data-testid="meeting-row"
                  onClick={() => setOpenId(m.id)}
                  className="flex w-full items-center gap-4 px-2 py-3 text-left hover:bg-zinc-800/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-zinc-200">{m.title}</div>
                    <div className="mt-0.5 text-[11px] text-zinc-500">
                      {new Date(m.startedAtMs).toLocaleDateString()} {formatClock(m.startedAtMs)}{m.endedAtMs ? ` – ${formatClock(m.endedAtMs)}` : ''} · {sourceLabel(m.source, copy)}
                    </div>
                  </div>
                  <span className="shrink-0 text-[11px] text-zinc-500">{minutesBadge(m, copy)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {importOpen && (
        <ImportDialog copy={copy} onClose={() => setImportOpen(false)} onImported={(id) => { setImportOpen(false); setOpenId(id); }} />
      )}
    </div>
  );
};
