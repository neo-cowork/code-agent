// ============================================================================
// N-FIX-TELEMETRY-RECOVERY-NOTICE-RESIDUE-SKILLDRAFT-TITLE — 标题派生入口不吃恢复提示
// sessionTitleSource 是标题侧共用入口：剥前缀后各降级/规则摘要继承，
// 只剩提示的消息视为没有正文（不起标题、不落 Appshot 固定名、保留占位）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  deriveFallbackSessionTitle,
  deriveRuleSummaryTitle,
  isProvisionalAutoTitle,
  sessionTitleSource,
} from '../../../src/shared/sessionTitlePlaceholder';

const LEGACY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';
const NOTICE_PREFIXED = `${LEGACY_NOTICE}\n\n帮我把三页会议纪要整理成一份周报发给团队`;
const TRUNCATED_RESIDUE = `${LEGACY_NOTICE.slice(0, 60)}...`;
const LEAK = /历史恢复提示|telemetry|重建|脱敏/;

describe('sessionTitleSource strips the recovery notice', () => {
  it('notice-prefixed message yields only the real user text', () => {
    expect(sessionTitleSource(NOTICE_PREFIXED)).toBe('帮我把三页会议纪要整理成一份周报发给团队');
  });

  it('notice-only message yields empty text, never the notice and never the appshot fixed name', () => {
    expect(sessionTitleSource(`${LEGACY_NOTICE}\n\n`)).toBe('');
    expect(sessionTitleSource(LEGACY_NOTICE)).toBe('');
  });

  it('truncated notice residue is dropped entirely', () => {
    expect(sessionTitleSource(TRUNCATED_RESIDUE)).toBe('');
  });

  it('plain messages pass through unchanged', () => {
    expect(sessionTitleSource('普通的第一条消息')).toBe('普通的第一条消息');
  });
});

describe('deriveFallbackSessionTitle ignores the recovery notice', () => {
  it('builds the fallback title from the real text after the prefix', () => {
    expect(deriveFallbackSessionTitle(NOTICE_PREFIXED)).toBe('帮我把三页会议纪要整理成一份周报发给团队');
    expect(deriveFallbackSessionTitle(NOTICE_PREFIXED)).not.toMatch(LEAK);
  });

  it('produces no title for a notice-only message instead of a 50-char notice or Appshot name', () => {
    expect(deriveFallbackSessionTitle(`${LEGACY_NOTICE}\n\n`)).toBe('');
    expect(deriveFallbackSessionTitle(LEGACY_NOTICE)).toBe('');
    expect(deriveFallbackSessionTitle(TRUNCATED_RESIDUE)).toBe('');
  });
});

describe('deriveRuleSummaryTitle ignores the recovery notice', () => {
  it('summarises the real text after the prefix', () => {
    expect(deriveRuleSummaryTitle(NOTICE_PREFIXED)).toBe('把三页会议纪要整理成一份周报发给团队');
    expect(deriveRuleSummaryTitle(NOTICE_PREFIXED)).not.toMatch(LEAK);
  });

  it('produces no rule summary for a notice-only message', () => {
    expect(deriveRuleSummaryTitle(`${LEGACY_NOTICE}\n\n`)).toBe('');
    expect(deriveRuleSummaryTitle(TRUNCATED_RESIDUE)).toBe('');
  });
});

describe('isProvisionalAutoTitle still recognises titles pre-written from the raw notice text', () => {
  it('treats a notice-residue temporary title as provisional so the smart title can replace it', () => {
    // web 预写层用原始消息截 30 字 + `...`：剥前缀后与清洗来源做前缀比对必失配，
    // 这种标题仍须被认成自动产物，否则恢复提示会永远留在侧栏。
    const prewritten = `${LEGACY_NOTICE.substring(0, 27)}...`;
    expect(prewritten.endsWith('...')).toBe(true);
    expect(isProvisionalAutoTitle(prewritten, '帮我把三页会议纪要整理成一份周报发给团队')).toBe(true);
  });

  it('a real user-named title is still not provisional', () => {
    expect(isProvisionalAutoTitle('周报整理', '帮我把三页会议纪要整理成一份周报发给团队')).toBe(false);
  });
});
