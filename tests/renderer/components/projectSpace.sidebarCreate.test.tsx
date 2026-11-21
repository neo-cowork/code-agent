// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSpacePage } from '../../../src/renderer/components/features/projectSpace/ProjectSpacePage';
import { SidebarCapabilityZone } from '../../../src/renderer/components/features/sidebar/SidebarCapabilityZone';
import { SidebarSessionList } from '../../../src/renderer/components/features/sidebar/SidebarSessionList';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionListLoadStore } from '../../../src/renderer/stores/sessionListPagination';

const project = vi.hoisted(() => ({
  id: 'weekly-reports',
  name: 'Weekly reports',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  spacePromotedAt: 1,
  activeTopicCount: 0,
  lastActivityAt: null,
}));

vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjectsWithActivity: async () => [project],
  getProjectDetail: async () => ({ project, sources: [], goals: [], roles: [], sessionIds: [] }),
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { listJobs: async () => [], getStats: async () => ({}) },
}));
vi.mock('../../../src/renderer/components/features/projectSpace/ProjectActivityFeed', () => ({
  ProjectActivityFeed: () => null,
}));
vi.mock('../../../src/renderer/components/features/projectSpace/ProjectComposer', () => ({
  ProjectComposer: () => null,
}));
vi.mock('../../../src/renderer/components/features/projectSpace/ProjectConfigRail', () => ({
  ProjectConfigRail: () => null,
}));
vi.mock('../../../src/renderer/components/features/sidebar/SidebarProjectGroup', () => ({
  SidebarProjectGroup: () => null,
}));

function renderEntries({ mountPage = true, closeOnClick = false } = {}) {
  const noop = () => undefined;
  const Harness = () => {
    const showPage = useAppStore((state) => state.showProjectSpacePage);
    const closePage = useAppStore((state) => state.closeProjectSpacePage);
    return (
      <>
        <SidebarCapabilityZone />
        <div onClick={closeOnClick ? closePage : undefined}>
          <SidebarSessionList
            groups={[{
              key: `project:${project.id}`,
              name: project.name,
              paths: [],
              projectId: project.id,
              isUncategorized: false,
              sessions: [],
              latestActivityAt: 0,
            }]}
            projectMetaById={{ [project.id]: project }}
            setProjectMetaById={noop}
            isLoading={false}
            hasAnySessions={false}
            filteredSessionsEmpty={false}
            messageSearchLoading={false}
            messageSearchFailed={false}
            searchQuery=""
            sessionStatusFilter="all"
            activeStatusFilterLabel=""
            hasSearchFilters={false}
            expandedWorkspaces={{}}
            collapsingWorkspaces={{}}
            expandedProjectDetails={{}}
            projectDrawerKey={null}
            isCreatingSession={false}
            creatingWorkspaceKey={null}
            setProjectDrawerKey={noop}
            setExpandedProjectDetails={noop}
            handleToggleWorkspaceGroup={noop}
            handleOpenWorkspaceAssets={noop}
            handleNewWorkspaceChat={vi.fn()}
            handleOpenProjectArtifactSession={vi.fn()}
            handleStartProjectGoal={vi.fn()}
            handleSelectSession={vi.fn()}
            handleRenameSidebarProject={vi.fn()}
            handleSetSidebarProjectStatus={vi.fn()}
            handleSetSidebarProjectDescription={vi.fn()}
            createWorkspaceChat={vi.fn()}
            openWorkspacePreview={noop}
            sessionItemProps={{} as React.ComponentProps<typeof SidebarSessionList>['sessionItemProps']}
            handleNewChat={noop}
            handleNewIndependentSpace={noop}
          />
        </div>
        {mountPage && showPage && <ProjectSpacePage onClose={closePage} />}
      </>
    );
  };
  return render(<Harness />);
}

const clickPlus = () => fireEvent.click(screen.getByTestId('sidebar-tier-new-space'));
const clickCapabilityEntry = () => fireEvent.click(screen.getByTestId('sidebar-capability-projects'));
const createModal = 'project-space-create-modal';

beforeEach(() => {
  useAppStore.setState({ language: 'en' });
  useSessionListLoadStore.setState({ settled: true });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().closeProjectSpacePage();
});

describe('Project space creation from the sidebar', () => {
  it('opens the list and create dialog with one click and reopens the dialog from the list', async () => {
    renderEntries({ closeOnClick: true });
    clickPlus();
    expect(screen.getByTestId('project-space-page')).toBeTruthy();
    expect(await screen.findByTestId(createModal)).toBeTruthy();
    expect(useAppStore.getState().projectSpaceCreateRequested).toBe(false);

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId(createModal)).toBeNull();
    clickPlus();
    expect(await screen.findByTestId(createModal)).toBeTruthy();
  });

  it('returns from space detail to the list and opens the create dialog', async () => {
    renderEntries();
    clickCapabilityEntry();
    fireEvent.click(await screen.findByTestId(`project-space-list-item-${project.id}`));
    expect(await screen.findByTestId('project-space-tab-activity')).toBeTruthy();
    clickPlus();
    expect(await screen.findByTestId(createModal)).toBeTruthy();
    expect(screen.queryByTestId('project-space-tab-activity')).toBeNull();
    expect(screen.getByTestId('project-space-create-open')).toBeTruthy();
  });

  it('opens the list from the capability-center entry and opens the dialog only on the header button', async () => {
    renderEntries();
    clickCapabilityEntry();
    await screen.findByTestId(`project-space-list-item-${project.id}`);
    expect(screen.queryByTestId(createModal)).toBeNull();
    expect(useAppStore.getState().projectSpaceCreateRequested).toBe(false);

    fireEvent.click(screen.getByTestId('project-space-create-open'));
    expect(await screen.findByTestId(createModal)).toBeTruthy();
  });

  it.each([
    ['close before reopening', () => act(() => useAppStore.getState().closeProjectSpacePage())],
    ['plain entry with the page already open', clickCapabilityEntry],
  ])('clears an unconsumed sidebar request on %s', async (_scenario, dismissRequest) => {
    const pending = renderEntries({ mountPage: false });
    clickPlus();
    expect(useAppStore.getState().projectSpaceCreateRequested).toBe(true);
    dismissRequest();
    expect(useAppStore.getState().projectSpaceCreateRequested).toBe(false);
    pending.unmount();

    renderEntries();
    clickCapabilityEntry();
    await screen.findByTestId(`project-space-list-item-${project.id}`);
    expect(screen.queryByTestId(createModal)).toBeNull();
  });
});
