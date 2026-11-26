// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEAM_RECIPES } from '../../../src/shared/constants/teamRecipeCatalog';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import { localizeCatalogObject } from '../../../src/renderer/utils/catalogText';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn(), on: () => () => {} },
}));

import { TeamRecipeDetailPage } from '../../../src/renderer/components/features/expert/TeamRecipeDetailPage';

const HAN = /\p{Script=Han}/u;
// The Experts list always holds the built-in roles; the detail page resolves member names through it.
const entries = [...new Set(TEAM_RECIPES[0].members.map((member) => member.roleId).concat(TEAM_RECIPES[0].lead?.roleId ?? []))]
  .map((roleId) => ({ roleId, displayName: roleId } as RolePanelEntry));

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('TeamRecipeDetailPage read-only templates follow the UI language', () => {
  it('zh shows the stored brief and member task templates unchanged', () => {
    useAppStore.setState({ language: 'zh' });
    const recipe = TEAM_RECIPES[0];
    render(<TeamRecipeDetailPage recipe={recipe} entries={entries} editable={false} onBack={() => {}} onCopied={() => {}} onSaved={() => {}} />);
    const text = screen.getByTestId(`team-recipe-detail-${recipe.id}`).textContent ?? '';
    expect(text).toContain(recipe.lead?.briefTemplate);
    recipe.members.forEach((member) => expect(text).toContain(member.taskTemplate));
  });

  it('en shows the shared English copy and no Chinese', () => {
    useAppStore.setState({ language: 'en' });
    // The Experts list hands the detail page the already-localized recipe (ExpertPanel); templates are not localized there.
    const recipe = localizeCatalogObject(TEAM_RECIPES[0], 'en');
    render(<TeamRecipeDetailPage recipe={recipe} entries={entries} editable={false} onBack={() => {}} onCopied={() => {}} onSaved={() => {}} />);
    const text = screen.getByTestId(`team-recipe-detail-${recipe.id}`).textContent ?? '';
    expect(text).toContain('Around "{topic}", coordinate Suzhen');
    expect(text).toContain('Research the competitors and market for "{topic}"');
    expect(text).not.toMatch(HAN);
  });
});
