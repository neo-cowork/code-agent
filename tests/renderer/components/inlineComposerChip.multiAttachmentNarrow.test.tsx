// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lang = vi.hoisted(() => ({ current: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: lang.current === 'zh' ? zh : en, language: lang.current }) };
});

import {
  InlineComposerChip,
  type InlineChipView,
} from '../../../src/renderer/components/features/chat/ChatInput/InlineComposerChip';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const makeReadingNotes = (): InlineChipView[] =>
  Array.from({ length: 10 }, (_, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    return {
      key: `file:note-${num}`,
      kind: 'file',
      id: `note-${num}`,
      label: `reading-note-${num}.txt`,
      category: 'document',
    };
  });

afterEach(cleanup);

describe('InlineComposerChip multi-attachment narrow layout', () => {
  it.each(['zh', 'en'] as const)(
    'renders 10 reading notes with unique non-truncating tails, narrow max-width class, and working removal (%s)',
    (language) => {
      lang.current = language;
      const t = language === 'zh' ? zh : en;
      const chips = makeReadingNotes();
      const onRemove = vi.fn();

      const { container } = render(
        <div>
          {chips.map((chip) => (
            <InlineComposerChip key={chip.key} chip={chip} onRemove={onRemove} />
          ))}
        </div>,
      );

      const chipEls = Array.from(container.querySelectorAll('[data-inline-chip="file"]'));
      expect(chipEls).toHaveLength(10);

      // Every chip uses the narrow max-width class below sm and keeps 220px at sm+
      for (const [idx, el] of chipEls.entries()) {
        expect(el.className).toContain('max-w-[9.5rem]');
        expect(el.className).toContain('sm:max-w-[220px]');
        expect(el.getAttribute('aria-label')).toBe(chips[idx].label);
      }

      // Every chip renders a non-truncating tail, and all 10 visible tails are unique
      const tails = chipEls.map((el) => el.querySelector('[data-chip-label-tail]')?.textContent ?? '');
      expect(new Set(tails).size).toBe(10);
      expect(tails.every((tail) => tail.endsWith('.txt') && tail.length >= 6)).toBe(true);

      for (const el of chipEls) {
        const head = el.querySelector('[data-chip-label-head]');
        const tail = el.querySelector('[data-chip-label-tail]');
        expect(head?.className).toContain('truncate');
        expect(tail?.className).toContain('shrink-0');
      }

      // Full filename stays intact across head + tail
      for (const [idx, el] of chipEls.entries()) {
        expect(el.textContent).toBe(chips[idx].label);
      }

      // Remove 7th chip via its × button
      const seventh = chips[6];
      const removeSeventhBtn = screen.getByRole('button', {
        name: t.chatInput.attachRemoveAria.replace('{name}', seventh.label),
      });
      fireEvent.click(removeSeventhBtn);
      expect(onRemove).toHaveBeenCalledTimes(1);
      expect(onRemove).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'note-07' }));

      // Remove 4th chip via Delete key when focused
      const fourthGroup = screen.getByRole('group', { name: chips[3].label });
      fourthGroup.focus();
      fireEvent.keyDown(fourthGroup, { key: 'Delete' });
      expect(onRemove).toHaveBeenCalledTimes(2);
      expect(onRemove).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'note-04' }));
    },
  );

  it('preserves title attribute and handles short file names without splitting', () => {
    lang.current = 'zh';
    const { container } = render(
      <InlineComposerChip
        chip={{
          key: 'file:short',
          kind: 'file',
          id: 'short',
          label: 'a.txt',
          title: 'notes/a.txt',
          category: 'document',
        }}
        onRemove={vi.fn()}
      />,
    );
    const chipEl = container.querySelector('[data-inline-chip="file"]');
    expect(chipEl?.getAttribute('aria-label')).toBe('a.txt');
    expect(chipEl?.getAttribute('title')).toBe('notes/a.txt');
    expect(chipEl?.textContent).toBe('a.txt');
    expect(chipEl?.querySelector('[data-chip-label-tail]')).toBeNull();
  });

  it('guards PDF chip with description against narrow-width overflow and keeps non-file chip width unchanged', () => {
    lang.current = 'en';
    const { container } = render(
      <div>
        <InlineComposerChip
          chip={{
            key: 'file:pdf-1',
            kind: 'file',
            id: 'pdf-1',
            label: 'quarterly-report-01.pdf',
            category: 'pdf',
            description: 'PDF · 12 pages',
          }}
          onRemove={vi.fn()}
        />
        <InlineComposerChip
          chip={{
            key: 'skill:weekly-summary',
            kind: 'skill',
            id: 'weekly-summary',
            label: 'weekly-summary',
          }}
          onRemove={vi.fn()}
        />
      </div>,
    );

    const pdfChip = container.querySelector('[data-inline-chip="file"]');
    expect(pdfChip?.className).toContain('overflow-hidden');
    expect(pdfChip?.className).toContain('max-w-[9.5rem]');
    const descEl = screen.getByText('PDF · 12 pages');
    expect(descEl.className).toContain('min-w-0');
    expect(descEl.className).toContain('truncate');
    expect(descEl.className).toContain('sm:shrink-0');

    const skillChip = container.querySelector('[data-inline-chip="skill"]');
    expect(skillChip?.className).toContain('max-w-[220px]');
    expect(skillChip?.className).not.toContain('max-w-[9.5rem]');
  });
});
