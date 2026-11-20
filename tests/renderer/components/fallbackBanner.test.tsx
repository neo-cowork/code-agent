// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FallbackBanner } from '../../../src/renderer/components/features/chat/MessageBubble/FallbackBanner';
import { encodeModelFallbackNotice } from '../../../src/renderer/components/features/chat/fallbackNotice';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: i18nState.language === 'en' ? en : zh,
      language: i18nState.language,
    }),
  };
});

const RAW_CONNECTION = 'Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9';
const NETWORK_ZH = '原模型暂时连接不上，已换用备用模型。';
const NETWORK_EN = 'The original model could not connect, so a backup model was selected.';

function connectionNotice(category: string | undefined, reason = RAW_CONNECTION) {
  return encodeModelFallbackNotice({
    reason,
    ...(category ? { category } : {}),
    strategy: 'adaptive-provider-fallback',
    from: 'primary/model-a',
    to: 'backup/model-b',
    tried: [
      {
        provider: 'primary',
        model: 'model-a',
        status: 'tried',
        reason: 'adaptive_candidate_failed',
        ...(category ? { category } : {}),
        detail: reason,
      },
    ],
  });
}

describe('FallbackBanner', () => {
  beforeEach(() => {
    i18nState.language = 'zh';
  });

  afterEach(() => {
    cleanup();
  });

	  it('renders tried, skipped, selected trace steps and disabled tool policy when expanded', () => {
	    const html = renderToStaticMarkup(
	      <FallbackBanner
	        defaultExpanded
	        content={encodeModelFallbackNotice({
	          reason: 'vision',
	          category: 'capability',
	          strategy: 'adaptive-capability-fallback',
	          from: 'mock/text-only',
	          to: 'zhipu/glm-4.5v',
	          fromIdentity: {
	            provider: 'mock',
	            sourceLabel: 'Mock Relay',
	            protocol: 'openai',
	            transportLabel: 'OpenAI-compatible',
	            endpoint: 'https://mock.example/v1',
	          },
	          toIdentity: {
	            provider: 'zhipu',
	            displayName: 'Zhipu Relay',
	            protocol: 'openai',
	            transportLabel: 'OpenAI-compatible',
	            endpoint: 'https://relay.example.com/zhipu/v1',
	          },
	          tried: [
	            {
	              provider: 'mock',
	              model: 'text-only',
	              providerIdentity: {
	                provider: 'mock',
	                sourceLabel: 'Mock Relay',
	                protocol: 'openai',
	                transportLabel: 'OpenAI-compatible',
	                endpoint: 'https://mock.example/v1',
	              },
	              status: 'tried',
	              reason: 'missing_capability',
	              category: 'vision',
	              detail: '需要 vision 能力',
	            },
	            {
	              provider: 'zhipu',
	              model: 'glm-4.5v',
	              providerIdentity: {
	                provider: 'zhipu',
	                displayName: 'Zhipu Relay',
	                protocol: 'openai',
	                transportLabel: 'OpenAI-compatible',
	                endpoint: 'https://relay.example.com/zhipu/v1',
	              },
	              status: 'selected',
	              reason: 'capability_fallback_selected',
	              category: 'vision',
	              detail: '具备 vision 能力',
	            },
	          ],
	          skipped: [
	            {
	              provider: 'openai',
	              model: 'gpt-5.4-mini',
	              status: 'skipped',
	              reason: 'missing_api_key',
	              category: 'vision',
	            },
	          ],
	          toolPolicy: {
	            status: 'disabled',
	            reason: 'fallback_model_without_tool_support',
	            originalToolCount: 6,
	            effectiveToolCount: 0,
	            disabledToolNames: ['Read', 'Edit', 'Write', 'Append', 'Bash', 'Task'],
	            detail: 'Fallback 模型 zhipu/glm-4.5v 不支持工具调用，本轮改为纯文本回复。',
	          },
	        })}
	      />,
	    );


    expect(html).toContain('已自动换用备用模型');
		    expect(html).toContain('自动换用支持当前任务的模型');
	    expect(html).toContain('mock/text-only');
	    expect(html).toContain('zhipu/glm-4.5v');
		    expect(html).toContain('原模型 · 来源 Mock Relay');
		    expect(html).toContain('现用模型 · 名称 Zhipu Relay');
		    expect(html).toContain('连接方式 OpenAI-compatible');
		    expect(html).toContain('服务地址 https://mock.example/v1');
		    expect(html).toContain('服务地址 https://relay.example.com/zhipu/v1');
    expect(html).toContain('title="mock/text-only · 来源 Mock Relay · 连接方式 OpenAI-compatible · 服务地址 https://mock.example/v1 · 原模型不支持这项任务，已换用能完成的模型。"');
    expect(html).not.toContain('vision');
    expect(html).not.toContain('missing_capability');
    expect(html).toContain('已尝试');
    expect(html).toContain('已跳过');
    expect(html).toContain('已选用');
    expect(html).toContain('openai/gpt-5.4-mini');
    expect(html).toContain('部分工具暂不可用');
    expect(html).toContain('6 → 0');
    expect(html).toContain('读取文件, Edit, Write, Append +2');
  });

  it('renders exhausted fallback traces when expanded', () => {
    const html = renderToStaticMarkup(
      <FallbackBanner
        defaultExpanded
        content={encodeModelFallbackNotice({
          reason: 'Moonshot API error: 503 service unavailable',
          category: 'provider_unavailable',
          strategy: 'adaptive-provider-fallback',
          from: 'zhipu/glm-4.7-flash',
          to: '未切换',
          tried: [
            {
              provider: 'zhipu',
              model: 'glm-4.7-flash',
              status: 'tried',
              reason: 'primary_failed',
              category: 'provider_unavailable',
            },
            {
              provider: 'moonshot',
              model: 'kimi-k2.5',
              status: 'exhausted',
              reason: 'fallback_chain_exhausted',
              category: 'provider_unavailable',
            },
          ],
        })}
      />,
    );

    expect(html).toContain('无可用项');
    expect(html).toContain('自动换用备用模型');
    expect(html).toContain('moonshot/kimi-k2.5');
    expect(html).toContain('未切换');
  });

  it('renders nothing for malformed fallback notice content', () => {
    expect(renderToStaticMarkup(<FallbackBanner content="not a fallback notice" />)).toBe('');
  });

  // 默认态只留用户需要知道的自动恢复结果；模型 id、原始原因、
  // strategy pill/identity/trace 分组/工具策略这些工程细节都收进展开态。
  it('collapses to a one-line summary by default; engineering detail stays reachable via expand', () => {
    const html = renderToStaticMarkup(
      <FallbackBanner
        content={encodeModelFallbackNotice({
          reason: 'vision',
          category: 'capability',
          strategy: 'adaptive-capability-fallback',
          from: 'mock/text-only',
          to: 'zhipu/glm-4.5v',
          fromIdentity: {
            provider: 'mock',
            sourceLabel: 'Mock Relay',
            protocol: 'openai',
          },
          tried: [
            {
              provider: 'mock',
              model: 'text-only',
              status: 'tried',
              reason: 'missing_capability',
              category: 'vision',
            },
          ],
          toolPolicy: {
            status: 'disabled',
            reason: 'fallback_model_without_tool_support',
            originalToolCount: 6,
            effectiveToolCount: 0,
            disabledToolNames: ['Read'],
          },
        })}
      />,
    );

    expect(html).toContain('已自动换用备用模型');
    expect(html).toContain('原模型不支持这项任务');
    expect(html).not.toContain('mock/text-only');
    expect(html).not.toContain('zhipu/glm-4.5v');
    expect(html).not.toContain('vision');
    expect(html).toContain('aria-expanded="false"');
    // 展开态才有的工程细节，默认不该出现
    expect(html).not.toContain('自动换用支持当前任务的模型');
    expect(html).not.toContain('Mock Relay');
    expect(html).not.toContain('已尝试');
    expect(html).not.toContain('部分工具暂不可用');
  });

  it.each([
    ['zh', 'network', NETWORK_ZH, '技术详情'],
    ['zh', undefined, NETWORK_ZH, '技术详情'],
    ['en', 'network', NETWORK_EN, 'Technical details'],
    ['en', undefined, NETWORK_EN, 'Technical details'],
  ] as const)(
    'expanded %s banner hides the raw connection error when category is %s',
    (language, category, sentence, toggleLabel) => {
      i18nState.language = language;
      const html = renderToStaticMarkup(
        <FallbackBanner defaultExpanded content={connectionNotice(category)} />,
      );

      expect(html).not.toContain('ECONNREFUSED');
      expect(html).not.toContain('Cannot connect to API');
      expect(html).toContain(sentence);
      expect(html).toContain(toggleLabel);
      expect(html).toContain('aria-expanded="false"');
    },
  );

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'] as const)(
    'no category + %s uses the network sentence and hides the errno',
    (errno) => {
      const reason = `Cannot connect to API: connect ${errno} 127.0.0.1:9`;
      const html = renderToStaticMarkup(
        <FallbackBanner defaultExpanded content={connectionNotice(undefined, reason)} />,
      );

      expect(html).toContain(NETWORK_ZH);
      expect(html).not.toContain(errno);
      expect(html).not.toContain('Cannot connect to API');
    },
  );

  it('keeps a known non-network category when the raw reason mentions a connection errno', () => {
    const html = renderToStaticMarkup(
      <FallbackBanner
        defaultExpanded
        content={connectionNotice('capability')}
      />,
    );

    expect(html).toContain('原模型不支持这项任务，已换用能完成的模型。');
    expect(html).not.toContain(NETWORK_ZH);
    expect(html).not.toContain('ECONNREFUSED');
  });

  it.each([
    ['zh', '技术详情'],
    ['en', 'Technical details'],
  ] as const)('shows the raw connection error only after %s technical details opens', (language, toggleLabel) => {
    i18nState.language = language;
    const { container } = render(
      <FallbackBanner defaultExpanded content={connectionNotice('network')} />,
    );

    expect(container.innerHTML).not.toContain('ECONNREFUSED');
    expect(container.innerHTML).not.toContain('Cannot connect to API');
    expect(container.innerHTML).toContain(language === 'zh' ? NETWORK_ZH : NETWORK_EN);

    fireEvent.click(screen.getByRole('button', { name: toggleLabel }));

    expect(container.innerHTML).toContain(RAW_CONNECTION);
    expect(container.innerHTML).toContain(`adaptive_candidate_failed · ${RAW_CONNECTION}`);
  });
});
