import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_OFFICIAL_PROVIDERS,
  ONBOARDING_STEPS,
  buildOnboardingModelSelection,
  getOnboardingApiCompatibilityOptions,
  getOnboardingProviderCards,
  getOnboardingRelayCard,
  selectOnboardingDefaultModel,
} from '../../../src/renderer/components/onboarding/modelOnboarding';
import { onboardingEn, onboardingZh } from '../../../src/renderer/i18n/onboarding';
import { listExternalEngineManifests } from '../../../src/shared/externalEngineManifest';

const zhText = onboardingZh.onboarding;

describe('model onboarding helpers', () => {
  it('shows official direct providers and excludes advanced provider types', () => {
    expect(ONBOARDING_OFFICIAL_PROVIDERS).toContain('deepseek');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).toContain('moonshot');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).toContain('openai');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).toContain('longcat');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).not.toContain('openrouter');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).not.toContain('local');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).not.toContain('custom');
  });

  it('keeps the recommended providers first for new users', () => {
    const recommended = getOnboardingProviderCards(zhText)
      .filter((card) => card.recommended)
      .map((card) => card.id);

    expect(recommended).toEqual(['deepseek', 'moonshot', 'zhipu', 'qwen']);
  });

  it('prefers a discovered registry default when available', () => {
    expect(selectOnboardingDefaultModel('openai', [
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
      },
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
      },
    ])).toBe('gpt-5.5');
  });

  it('offers a relay card that requires a user-supplied base URL', () => {
    // 官方卡片列表仍不含 custom（中转卡片单独走 getOnboardingRelayCard），避免和官方直连混在一起
    expect(getOnboardingProviderCards(zhText).map((card) => card.id)).not.toContain('custom');
    expect(getOnboardingRelayCard(zhText)).toMatchObject({
      id: 'custom',
      requiresBaseUrl: true,
    });
  });

  it('builds relay selection from discovered models with the user base URL', () => {
    const selection = buildOnboardingModelSelection({
      provider: 'custom',
      apiKey: 'sk-relay-test',
      baseUrl: 'https://windhub.cc/v1',
      discoveredModels: [
        { id: 'deepseek-v3-2-251201', label: 'DeepSeek V3.2' },
        { id: 'doubao-seed-1-8-251228', label: '豆包 Seed 1.8' },
      ],
    });

    // 默认模型取第一个发现的模型，不能落到中转站不存在的 custom-model 占位
    expect(selection.modelConfig).toMatchObject({
      provider: 'custom',
      model: 'deepseek-v3-2-251201',
      baseUrl: 'https://windhub.cc/v1',
    });
    expect(selection.providerSettings.models?.['deepseek-v3-2-251201']?.enabled).toBe(true);
    expect(selection.providerSettings.models?.['doubao-seed-1-8-251228']?.enabled).toBe(true);
  });

  it('falls back to built-in provider defaults when discovery returns nothing', () => {
    const selection = buildOnboardingModelSelection({
      provider: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      discoveredModels: [],
    });

    expect(selection.modelConfig).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(selection.providerSettings.models?.['deepseek-flash']?.enabled).toBe(true);
  });
});

describe('onboarding two-step funnel', () => {
  it('uses source then default model, with no daily-tool or completion page', () => {
    expect([...ONBOARDING_STEPS]).toEqual(['source', 'model']);
  });

  it('includes OpenAI and Anthropic compatible API routes', () => {
    expect(getOnboardingApiCompatibilityOptions(zhText)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'openai-compatible', protocol: 'openai' }),
      expect.objectContaining({ id: 'anthropic-compatible', protocol: 'claude' }),
    ]));
  });
});

describe('onboarding engine recommendation copy', () => {
  it('keeps a language-pack entry for every engine manifest recommendation', () => {
    type RecommendationCopy = Record<string, { label: string; reason: string } | undefined>;
    const zhCopy: RecommendationCopy = zhText.engineStatus.recommendations;
    const enCopy: RecommendationCopy = onboardingEn.onboarding.engineStatus.recommendations;
    const recommended = listExternalEngineManifests().filter((manifest) => manifest.recommendation);

    expect(recommended.map((manifest) => manifest.id)).toEqual(['qoder_work', 'comate_zulu', 'cursor_cli']);
    for (const manifest of recommended) {
      expect(zhCopy[manifest.id]).toEqual(manifest.recommendation);
      const en = enCopy[manifest.id];
      expect(en?.label).toBeTruthy();
      expect(en?.reason).toBeTruthy();
      expect(`${en?.label}${en?.reason}`).not.toMatch(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u);
    }
  });
});
