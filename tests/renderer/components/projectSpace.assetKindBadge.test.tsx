// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProjectArtifact, ProjectArtifactKind } from '../../../src/shared/contract/project';

vi.mock('../../../src/renderer/services/projectClient', () => ({
  getProjectArtifacts: vi.fn(),
}));

import { ProjectArtifactsList } from '../../../src/renderer/components/features/projectSpace/ProjectArtifactsList';
import { languages, type Language, type Translations } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { getProjectArtifacts } from '../../../src/renderer/services/projectClient';

type ArtifactKindLabels = Translations['sidebarProject']['artifactKind'];

/** 新增 ProjectArtifactKind 而不登记这里，typecheck 会红。 */
const ARTIFACT_KIND_COVERAGE = {
  chart: true,
  spreadsheet: true,
  document: true,
  generative_ui: true,
  neo_ui: true,
  mermaid: true,
  question_form: true,
  file: true,
  generic_html: true,
  web_snapshot: true,
  link: true,
  text: true,
  binary: true,
  image: true,
  audio: true,
  video: true,
  web: true,
  search: true,
  'process-output': true,
  'process-log': true,
} as const satisfies Record<ProjectArtifactKind, true>;

const ARTIFACT_KINDS = Object.keys(ARTIFACT_KIND_COVERAGE) as ProjectArtifactKind[];

const DOCUMENT_BADGE: Record<Language, string> = {
  zh: '文档',
  en: 'Document',
};

function dictionaryLabel(kind: ProjectArtifactKind, labels: ArtifactKindLabels): string | undefined {
  if (kind === 'process-output') return labels.processOutput;
  if (kind === 'process-log') return labels.processLog;
  return (labels as Record<string, string | undefined>)[kind];
}

function artifact(id: string, kind: ProjectArtifactKind): ProjectArtifact {
  return {
    id,
    sessionId: 'sess-weekly',
    kind,
    title: 'Weekly report',
    sessionTitle: 'Planning',
    createdAt: 1_700_000_000_000,
  };
}

function badgeText(row: HTMLElement): string {
  const badge = row.querySelector('span.inline-flex');
  if (!badge) throw new Error('kind badge missing');
  return badge.textContent ?? '';
}

async function renderArtifacts(language: Language, artifacts: ProjectArtifact[]): Promise<void> {
  useAppStore.setState({ language });
  vi.mocked(getProjectArtifacts).mockResolvedValue(artifacts);
  render(
    <ProjectArtifactsList
      projectId="proj_badge"
      onOpenSession={() => undefined}
    />,
  );
  await screen.findByTestId('project-space-assets-list');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectArtifactsList kind badge', () => {
  it.each(['zh', 'en'] as const)('localizes every artifact kind badge (%s)', async (language) => {
    const labels = languages[language].sidebarProject.artifactKind;
    await renderArtifacts(language, ARTIFACT_KINDS.map((kind) => artifact(`kind-${kind}`, kind)));

    for (const kind of ARTIFACT_KINDS) {
      const row = screen.getByTestId(`project-space-asset-kind-${kind}`);
      const text = badgeText(row);
      expect(text.length, kind).toBeGreaterThan(0);
      expect(text, kind).not.toBe(kind);
      if (kind !== 'file') expect(text, kind).not.toBe(labels.file);
      expect(text, kind).toBe(dictionaryLabel(kind, labels));
      if (kind === 'document') expect(text).toBe(DOCUMENT_BADGE[language]);
    }
  });

  it.each(['zh', 'en'] as const)('renders the file label for an unregistered kind (%s)', async (language) => {
    const labels = languages[language].sidebarProject.artifactKind;
    await renderArtifacts(language, [artifact('unknown-1', 'not-a-kind' as ProjectArtifactKind)]);
    const text = badgeText(screen.getByTestId('project-space-asset-unknown-1'));
    expect(text).toBe(labels.file);
    expect(text).toBe(language === 'zh' ? '文件' : 'File');
    expect(text).not.toBe('not-a-kind');
  });
});
