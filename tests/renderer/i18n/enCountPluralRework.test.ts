// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { interpolatePlural } from '../../../src/renderer/i18n/interpolate';
import { getSurfaceExecutionTranslations } from '../../../src/renderer/i18n/surfaceExecution';

type Pair = { one: string; other: string };

function at(root: unknown, path: string): Pair {
  let node = root as Record<string, unknown>;
  for (const part of path.split('.')) node = node[part] as Record<string, unknown>;
  return node as unknown as Pair;
}

// [path in the translations tree, English at count 1, English at count 2]
const CASES: Array<[string, string, string]> = [
  ['activityPanel.preview.sourceItems', '1 item, confidence {confidence}', '2 items, confidence {confidence}'],
  ['activityPanel.capability.sourcesAvailable', '1 source available', '2 sources available'],
  ['activityPanel.capability.tokenBudget', 'About {tokens} text units available across 1 item.', 'About {tokens} text units available across 2 items.'],
  ['activityPanel.localEvidence.screenshotsLocal', '1 screenshot file kept as local evidence only', '2 screenshot files kept as local evidence only'],
  ['activityPanel.localEvidence.audioPaths', '1 audio file path not expanded directly', '2 audio file paths not expanded directly'],
  ['voiceAudit.callCount', '1 call', '2 calls'],
  ['voiceAudit.eventCount', '1 event', '2 events'],
  ['capabilityCandidates.whyGrouped', 'All 1 run used the same set of steps (orderings: {variants})', 'All 2 runs used the same set of steps (orderings: {variants})'],
  ['onboarding.discoveredModelsCount', '1 model found', '2 models found'],
  ['folderTrust.items.project-hooks', '1 script that executes by itself: Neo runs it when a task starts, when a tool is used, and so on', '2 scripts that run by themselves: Neo runs them when a task starts, when a tool is used, and so on'],
  ['folderTrust.items.project-mcp', '1 connection to an outside tool: it starts a background program on your computer', '2 connections to outside tools: they start background programs on your computer'],
  ['folderTrust.items.project-mcp-local', '1 connection to an outside tool (the copy kept only on this computer): it starts a background program on your computer', '2 connections to outside tools (the copy kept only on this computer): they start background programs on your computer'],
  ['rendererHumanPipe.toolDetails.expandRemaining', 'Show 1 more line', 'Show 2 more lines'],
  ['rendererHumanPipe.workflowPreview.agents', '1 subtask', '2 subtasks'],
  ['settings.providerDoctor.includeRecordings', 'Include call recordings (1 call, {size})', 'Include call recordings (2 calls, {size})'],
  ['settings.data.cacheRetention.failedPermission', '1 cache item could not be deleted: no delete permission. Check the data folder permissions in Finder and try again', '2 cache items could not be deleted: no delete permission. Check the data folder permissions in Finder and try again'],
  ['settings.data.cacheRetention.failedOther', '1 cache item could not be deleted and this cleanup did not finish. You can retry later', '2 cache items could not be deleted and this cleanup did not finish. You can retry later'],
  ['settings.data.telemetry.uploadFailedSummary', 'Upload failed 1 time · latest {time}', 'Upload failed 2 times · latest {time}'],
  ['settings.nativeDesktop.audioRetention.confirmMessage', 'This will delete 1 file and free {bytes} bytes. Transcripts are kept.', 'This will delete 2 files and free {bytes} bytes. Transcripts are kept.'],
  ['settings.nativeDesktop.audioRetention.cleared', 'Deleted 1 file and freed {bytes} bytes.', 'Deleted 2 files and freed {bytes} bytes.'],
  ['settings.nativeDesktop.audioRetention.failedPermission', '1 recording could not be deleted: no delete permission. Check the recordings folder permissions in Finder and try again', '2 recordings could not be deleted: no delete permission. Check the recordings folder permissions in Finder and try again'],
  ['settings.nativeDesktop.audioRetention.failedOther', '1 recording could not be deleted and this cleanup did not finish. You can retry later', '2 recordings could not be deleted and this cleanup did not finish. You can retry later'],
  ['settings.externalImport.instructionRules.rulesFound', '1 rule found', '2 rules found'],
  ['settings.externalImport.skillsSync.keptNeoLine', '1 skill already exists in Neo; kept the Neo version', '2 skills already exist in Neo; kept the Neo version'],
  ['settings.externalImport.instructionsSync.statusNew', '1 new instruction in your source', '2 new instructions in your source'],
  ['settings.externalImport.instructionsSync.keptNeoLine', '1 instruction kept your Neo version', '2 instructions kept your Neo version'],
  ['sessionInspector.assembly.toolsSummary', '1 tool', '2 tools'],
  ['expert.memoryCount', '1 memory', '2 memories'],
  ['expert.workRecord.tools', '1 tool call', '2 tool calls'],
  ['expert.workRecord.iterations', '1 iteration', '2 iterations'],
  ['rolePack.degraded', '1 skill unavailable', '2 skills unavailable'],
  ['turnDiff.confirmMessage', 'This rolls back all changes to 1 file from this turn; current contents will be overwritten by the checkpoint.', 'This rolls back all changes to 2 files from this turn; current contents will be overwritten by the checkpoint.'],
  ['chatInput.attachFolderFiles', '1 file', '2 files'],
  ['chatInput.attachPages', '1 page', '2 pages'],
  ['chatInput.connectorSource.expertGroupAria', '1 connector from {expert}', '2 connectors from {expert}'],
  ['chatInput.folderSummaryCount', '1 file', '2 files'],
  ['inputAddMenu.submenuMcpTools', '1 tool', '2 tools'],
  ['mentionPanel.searchEcho', 'Search: {query} · 1 result', 'Search: {query} · 2 results'],
  ['mentionPanel.sessionMeta', '{time} · 1 message · {project}', '{time} · 2 messages · {project}'],
  ['voice.settings.recordCallsStatus', '1 recording on this machine, {size} total.', '2 recordings on this machine, {size} total.'],
  ['voice.settings.recordCallsLastCleanup', 'Last cleanup: {time} removed 1 recording, freed {size} (triggered by: {rule}).', 'Last cleanup: {time} removed 2 recordings, freed {size} (triggered by: {rule}).'],
  ['cronCenter.parkedVoided.summary', '1 approval was voided and did not run', '2 approvals were voided and did not run'],
  ['cronCenter.dailyCostRunsSuffix', ' · 1 run', ' · 2 runs'],
  ['cronCenter.inboxDigestArtifacts', '1 artifact', '2 artifacts'],
  ['cronCenter.inboxMaxRunsReached', 'Run limit reached (1 run); task was disabled.', 'Run limit reached (2 runs); task was disabled.'],
  ['cronCenter.inboxWebhookExpired', 'Cloud queue exceeded 24 hours; 1 delivery was dropped', 'Cloud queue exceeded 24 hours; 2 deliveries were dropped'],
  ['cronCenter.parkedWriteGroupTitle', 'Write 1 file in the "{folder}" folder', 'Write 2 files in the "{folder}" folder'],
  ['notices.agentNotice.historicalImagesOmitted', '1 older image was omitted from this model request; the original remains in chat history', '2 older images were omitted from this model request; the originals remain in chat history'],
  ['labGpt1.dataPreparation.augmentRepeatDesc', 'Just like memorizing vocabulary takes repetition, showing AI the same dialogue 1 time leaves a deeper impression', 'Just like memorizing vocabulary takes repetition, showing AI the same dialogue 2 times leaves a deeper impression'],
  ['labGpt1.dataPreparation.processStep2', 'Repeat each dialogue 1 time', 'Repeat each dialogue 2 times'],
  ['labGpt1.inferenceTest.topKValue', 'Top 1 candidate', 'Top 2 candidates'],
];

describe('English count copy: 1 reads singular, 2 reads plural (rework r2)', () => {
  it.each(CASES)('%s', (path, atOne, atTwo) => {
    expect(interpolatePlural(at(en, path), 1)).toBe(atOne);
    expect(interpolatePlural(at(en, path), 2)).toBe(atTwo);
    expect(interpolatePlural(at(en, path), 0)).not.toBe(atOne);
  });

  it.each(CASES)('zh %s is unchanged at 1 and 2 (one === other)', (path) => {
    const pair = at(zh, path);
    expect(pair.one).toBe(pair.other);
    expect(interpolatePlural(pair, 1)).toContain('1');
    expect(interpolatePlural(pair, 2)).toContain('2');
  });

  it('surface permission card scope counts agree at 1 and 2', () => {
    const copy = getSurfaceExecutionTranslations('en').permission;
    expect(interpolatePlural(copy.actionScope, 1)).toBe('1 allowed action class');
    expect(interpolatePlural(copy.actionScope, 2)).toBe('2 allowed action classes');
    expect(interpolatePlural(copy.dataScope, 1)).toBe('1 data scope');
    expect(interpolatePlural(copy.dataScope, 2)).toBe('2 data scopes');
    const zhCopy = getSurfaceExecutionTranslations('zh').permission;
    expect(interpolatePlural(zhCopy.actionScope, 1)).toBe('1 类允许动作');
    expect(interpolatePlural(zhCopy.actionScope, 2)).toBe('2 类允许动作');
    expect(interpolatePlural(zhCopy.dataScope, 1)).toBe('1 个数据范围');
    expect(interpolatePlural(zhCopy.dataScope, 2)).toBe('2 个数据范围');
  });
});
