import { BROWSER_SNAPSHOT } from '../../../shared/constants';
import type { BrowserDomSnapshot } from '../../services/infra/browser/types';

export interface FormattedDomSnapshot {
  output: string;
  /** Small summary persisted in result metadata (never the element list). */
  summary: {
    snapshotId: string;
    tabId: string;
    capturedAtMs: number;
    url: string;
    title: string;
    headingCount: number;
    interactiveCount: number;
    offset: number;
    shownCount: number;
  };
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Compact model-facing snapshot: header, headings, then one `refId | tag[/role] | label` line per
 * element, stopped at BROWSER_SNAPSHOT.MAX_CHARS. Full targetRef records stay host-side; the
 * refId alone resolves through BrowserService.resolveTargetRef.
 */
export function formatDomSnapshotForModel(snapshot: BrowserDomSnapshot, offsetInput?: unknown): FormattedDomSnapshot {
  const total = snapshot.interactiveElements.length;
  const requested = typeof offsetInput === 'number' && Number.isFinite(offsetInput) ? Math.floor(offsetInput) : 0;
  const offset = Math.min(Math.max(requested, 0), total);
  const budget = BROWSER_SNAPSHOT.MAX_CHARS;

  const lines: string[] = [
    `DOM snapshot ${snapshot.snapshotId}`,
    `url: ${clip(snapshot.url, BROWSER_SNAPSHOT.URL_MAX_CHARS)}`,
    `title: ${clip(snapshot.title, BROWSER_SNAPSHOT.ELEMENT_LABEL_MAX_CHARS * 2)}`,
  ];
  const unavailableFrames = (snapshot.frameDocuments ?? []).filter((f) => f.status === 'unavailable').length;
  if (unavailableFrames > 0) lines.push(`unavailable cross-origin frames: ${unavailableFrames}`);
  if (offset === 0 && snapshot.headings.length > 0) {
    lines.push('headings:');
    for (const h of snapshot.headings) {
      lines.push(`h${h.level} ${clip(h.text, BROWSER_SNAPSHOT.HEADING_TEXT_MAX_CHARS)}`);
    }
  }
  lines.push(`elements (refId | tag[/role] | label), ${offset + 1}-of-${total} start; pass refId as targetRef:`);

  let used = lines.join('\n').length;
  // Reserve room for the overflow line so the final text never exceeds the budget.
  const reserve = 90;
  let shown = 0;
  for (let i = offset; i < total; i += 1) {
    const el = snapshot.interactiveElements[i];
    const kind = el.role && el.role !== el.tag ? `${el.tag}/${el.role}` : el.tag;
    const label = clip(el.text || el.ariaLabel || el.placeholder || '', BROWSER_SNAPSHOT.ELEMENT_LABEL_MAX_CHARS);
    const line = `${el.targetRef.refId} | ${kind} | ${label}`;
    if (used + 1 + line.length > budget - reserve && shown > 0) break;
    lines.push(line);
    used += 1 + line.length;
    shown += 1;
  }
  const remaining = total - offset - shown;
  if (remaining > 0) {
    lines.push(`+${remaining} more elements, call get_dom_snapshot with offset=${offset + shown}`);
  }

  return {
    output: lines.join('\n'),
    summary: {
      snapshotId: snapshot.snapshotId,
      tabId: snapshot.tabId,
      capturedAtMs: snapshot.capturedAtMs,
      url: clip(snapshot.url, BROWSER_SNAPSHOT.URL_MAX_CHARS),
      title: clip(snapshot.title, BROWSER_SNAPSHOT.ELEMENT_LABEL_MAX_CHARS * 2),
      headingCount: snapshot.headings.length,
      interactiveCount: total,
      offset,
      shownCount: shown,
    },
  };
}
