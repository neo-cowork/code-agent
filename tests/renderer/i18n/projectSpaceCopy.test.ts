// 协作空间 zh 文案不得夹英文单词 "topic"（产品里这个对象叫「工作卡」）；en 块锁定为现状快照。
import { describe, expect, it } from 'vitest';
import { projectSpaceEn, projectSpaceZh } from '../../../src/renderer/i18n/projectSpace';

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

const EN_SNAPSHOT = {
    "projectSpace": {
      "sidebarEntry": "Spaces",
      "sidebarSubtitle": "Space list and collaboration panel",
      "listTitle": "Spaces",
      "listDescription": "Sessions, topics and artifacts grouped by space",
      "listEmpty": "No spaces yet. Click \"New space\" to pick a working directory or promote an existing project.",
      "listLoadFailed": "Failed to load spaces",
      "statusActive": "Active",
      "statusIdle": "Idle",
      "statusArchived": "Archived",
      "activeTopicBadge": "{count} active topics",
      "noActivity": "No activity yet",
      "backToList": "Spaces",
      "tabActivity": "Activity",
      "tabTasks": "Tasks",
      "tabAssets": "Assets",
      "activityEmpty": "No activity in this space yet. Start a session or @neo a task to see it here.",
      "activitySession": "Session updated",
      "activityTopic": "Topic changed",
      "activityArtifact": "Artifact created",
      "openSource": "Open",
      "assetsEmpty": "No artifacts in this space yet.",
      "assetFromSession": "Source session",
      "configRailTitle": "Space setup",
      "collapseRail": "Collapse setup rail",
      "expandRail": "Expand setup rail",
      "cardExperts": "Experts",
      "cardSkills": "Skills",
      "cardConnectors": "Connectors",
      "cardAutomation": "Automation",
      "cardMembers": "Members",
      "add": "Add",
      "remove": "Remove",
      "nativeConnectorDescriptions": {
        "calendar": "Connect macOS Calendar to view and schedule events",
        "mail": "Connect macOS Mail to read and search messages",
        "reminders": "Connect macOS Reminders to create and check to-dos",
        "photos": "Connect macOS Photos to find and use pictures"
      },
      "pickerEmpty": "Nothing available to add",
      "pickerSearchPlaceholder": "Search name or description…",
      "pickerNoMatch": "No matching options",
      "automationNextRun": "Next {time}",
      "selectedEmpty": "None selected",
      "skillsNoWorkspaceHint": "This space has no working directory, so skills cannot be attached yet.",
      "skillUpdateFailed": "Failed to update skill",
      "trustConfirmAction": "Trust this folder",
      "createSpace": "New space",
      "createTitle": "New space",
      "sourceDirectory": "Pick a working directory",
      "sourcePromote": "Promote an existing project",
      "directoryPlaceholder": "Enter an absolute path, or click \"Choose directory\"",
      "chooseDirectory": "Choose directory",
      "promoteLabel": "Project to promote",
      "promotePlaceholder": "Select a project",
      "promoteEmpty": "No projects available to promote",
      "createSubmit": "Create",
      "createFailed": "Failed to create space",
      "trustConfirmHint": "This folder carries things that would start working on their own (listed below). Clicking \"Create\" enables them here.",
      "descriptionPlaceholder": "Add a description…",
      "editSpace": "Edit",
      "deleteSpace": "Delete",
      "editTitle": "Edit space",
      "nameLabel": "Name",
      "namePlaceholder": "Space name",
      "descriptionLabel": "Description",
      "save": "Save",
      "deleteTitle": "Delete space",
      "deleteConfirm": "Deleting removes \"{name}\" from the list. Its sessions and topics are not deleted — they move to \"Unsorted\"; the space's source records are removed.",
      "deleteFailed": "This space could not be deleted; please try again later.",
      "deleteHistoryBlocked": "This space already has conversation history, so it can't be deleted yet.",
      "cloudBadge": "Cloud",
      "invite": "Invite",
      "promoteToCloud": "Upgrade to cloud space",
      "promoteTitle": "Upgrade to cloud space",
      "promoteConfirm": "Upgrading creates a matching cloud space so you can invite members to collaborate. Sign-in required.",
      "promoteSubmit": "Upgrade",
      "promoteSuccess": "Upgraded to cloud space",
      "inviteTitle": "Invite members",
      "inviteCreating": "Generating invite code…",
      "inviteFailed": "Failed to generate invite code",
      "inviteHint": "The code is valid for {hours} hours and can be used up to {uses} times.",
      "copy": "Copy",
      "copied": "Copied",
      "copyFailed": "Copy failed — select the code and copy it manually",
      "membersLoading": "Loading members…",
      "membersEmpty": "No members yet. Click \"Invite\" to generate a code.",
      "membersLoadFailed": "Failed to load members",
      "memberRoleOwner": "Owner",
      "memberRoleMember": "Member",
      "cloudCardsTitle": "Member cloud cards",
      "cloudCardsReadonlyBadge": "Read-only",
      "cloudCardsLoading": "Loading cloud cards…",
      "cloudCardsEmpty": "No cards shared by other members yet.",
      "cloudCardsLoadFailed": "Failed to load cloud cards",
      "cloudCardsRetry": "Retry",
      "cloudCardsResync": "Resync my cards",
      "cloudCardsResyncing": "Syncing…",
      "cloudCardsResyncSuccess": "Resynced local card metadata ({synced} synced, {failed} failed)",
      "cloudCardsResyncFailed": "Resync failed"
    }
  };

describe('projectSpace i18n', () => {
  it('zh 块任何字符串都不含英文单词 topic', () => {
    const offenders = collectStrings(projectSpaceZh).filter((s) => /topic/i.test(s));
    expect(offenders).toEqual([]);
  });

  it('zh 列表副标题用「工作卡」', () => {
    expect(projectSpaceZh.projectSpace.listDescription).toBe('按协作空间聚合会话、工作卡与产物');
  });

  it('en 块与现状快照一致', () => {
    expect(projectSpaceEn).toEqual(EN_SNAPSHOT);
  });
});
