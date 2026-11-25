import { describe, expect, it } from 'vitest';
import {
  classifyModelErrorMessage,
  incompleteResponseDiagnostic,
  summarizeModelErrorForUser,
} from '../../src/shared/modelErrorDiagnostics';

const RAW_TEMPERATURE_AND_FALLBACK_ERROR = [
  "litellm.BadRequestError: AzureException BadRequestError - Unsupported value: 'temperature' does not support 0.7 with this model.",
  'Only the default (1) value is supported.',
  'No fallback model group found for original model_group=gpt-5.5.',
  "Fallbacks=[{'gpt-5.4': ['gpt-5.5']}, {'deepseek-v4-pro': ['qwen3.7-max']}]",
].join(' ');

describe('model error diagnostics', () => {
  it('turns unsupported temperature errors into a short actionable message', () => {
    const diagnostic = classifyModelErrorMessage(RAW_TEMPERATURE_AND_FALLBACK_ERROR);

    expect(diagnostic).toMatchObject({
      code: 'unsupported_temperature',
      retryable: true,
      hasFallbackConfigurationIssue: true,
    });
    expect(diagnostic?.message).toContain('默认温度 1');
    expect(diagnostic?.suggestion).toContain('fallback');
  });

  it('does not leak raw LiteLLM fallback internals in the user summary', () => {
    const summary = summarizeModelErrorForUser(RAW_TEMPERATURE_AND_FALLBACK_ERROR);

    expect(summary).toContain('模型参数不兼容');
    expect(summary).not.toContain('litellm.BadRequestError');
    expect(summary).not.toContain("Fallbacks=[{'gpt-5.4'");
  });

  it('classifies fallback-only routing errors', () => {
    expect(classifyModelErrorMessage('No fallback model group found for original model_group=gpt-5.5')).toMatchObject({
      code: 'fallback_not_configured',
      retryable: false,
    });
  });
});

describe('auth_failed / quota_exhausted（2026-08-30 欠费卡死批）', () => {
  it('401/403 状态码直接判鉴权失败，不可重试，给桌面配置建议', () => {
    for (const statusCode of [401, 403]) {
      const diagnostic = classifyModelErrorMessage('upstream rejected the request', statusCode);
      expect(diagnostic).toMatchObject({ code: 'auth_failed', retryable: false });
      expect(diagnostic?.suggestion).not.toContain('/login');
      expect(diagnostic?.suggestion).not.toContain('/model');
      expect(diagnostic?.suggestion).not.toContain('<provider>');
      expect(diagnostic?.suggestion).toContain('设置 → 通用模型');
    }
  });

  it.each([
    {
      code: 'auth_failed',
      raw: 'invalid_api_key',
      statusCode: 401,
      zhMessage: '模型鉴权失败',
      enMessage: 'Model authentication failed',
      zhAction: '设置 → 通用模型',
      enAction: 'Settings → General model',
    },
    {
      code: 'quota_exhausted',
      raw: 'insufficient_quota',
      statusCode: 402,
      zhMessage: '余额或配额不足',
      enMessage: 'insufficient balance or quota',
      zhAction: '输入框右下角的模型按钮',
      enAction: 'model button at the bottom right of the input',
    },
  ])('$code 的中英文 summary 都只给桌面可执行动作', ({ code, raw, statusCode, zhMessage, enMessage, zhAction, enAction }) => {
    for (const locale of ['zh', 'en'] as const) {
      const diagnostic = classifyModelErrorMessage(raw, statusCode, locale);
      expect(diagnostic).toMatchObject({ code, retryable: false });
      if (!diagnostic) throw new Error(`Missing diagnostic for ${code}`);

      const summary = summarizeModelErrorForUser(raw, statusCode, locale);
      for (const text of [diagnostic.message, diagnostic.suggestion, summary]) {
        expect(text).not.toContain('/login');
        expect(text).not.toContain('/model');
        expect(text).not.toContain('<provider>');
        if (locale === 'en') expect(text).not.toMatch(/[\u3400-\u9fff]/u);
      }
      expect(diagnostic.message).toContain(locale === 'en' ? enMessage : zhMessage);
      expect(diagnostic.suggestion).toContain(locale === 'en' ? enAction : zhAction);
      expect(summary).toContain(locale === 'en' ? '\nSuggestion: ' : '\n建议：');
    }
  });

  it('纯 CLI surface 保留登录和换模型命令', () => {
    for (const locale of ['zh', 'en'] as const) {
      const authSummary = summarizeModelErrorForUser('invalid_api_key', 401, locale, 'cli');
      expect(authSummary).toContain('/login');
      expect(authSummary).toContain('/model');

      const quotaSummary = summarizeModelErrorForUser('insufficient_quota', 402, locale, 'cli');
      expect(quotaSummary).toContain('/model');

      for (const summary of [authSummary, quotaSummary]) {
        expect(summary).not.toContain('设置 → 通用模型');
        expect(summary).not.toContain('输入框右下角的模型按钮');
        if (locale === 'en') expect(summary).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it('鉴权文案（含中文）无状态码也判 auth_failed', () => {
    expect(classifyModelErrorMessage('invalid_api_key')).toMatchObject({ code: 'auth_failed' });
    expect(classifyModelErrorMessage('鉴权失败，请检查密钥')).toMatchObject({ code: 'auth_failed' });
  });

  it('402 与欠费/余额文案判 quota_exhausted，不可重试', () => {
    expect(classifyModelErrorMessage('rejected', 402)).toMatchObject({ code: 'quota_exhausted', retryable: false });
    expect(classifyModelErrorMessage('insufficient_quota')).toMatchObject({ code: 'quota_exhausted' });
    expect(classifyModelErrorMessage('账户已欠费，请充值')).toMatchObject({ code: 'quota_exhausted' });
    expect(classifyModelErrorMessage('余额不足')).toMatchObject({ code: 'quota_exhausted' });
  });

  it('summarizeModelErrorForUser 输出人话 + 建议，不透出原始内部文案', () => {
    const summary = summarizeModelErrorForUser('Error: 欠费 (status 402)', 402);
    expect(summary).toContain('余额或配额不足');
    expect(summary).toContain('建议：');
    expect(summary).not.toContain('Native Durable Run');
  });

  it('其余诊断码传 en 出全英文，传 zh 逐字等于既有中文', () => {
    const cases = [
      {
        name: 'unsupported_temperature（纯温度不兼容）',
        raw: "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.",
        statusCode: undefined,
        code: 'unsupported_temperature',
        zhSummary: '模型参数不兼容：当前模型只支持默认温度 1。\n建议：重试会使用默认温度 1；如果仍失败，请切换到支持自定义温度的模型。',
      },
      {
        name: 'unsupported_temperature（叠加 fallback 未配置）',
        raw: RAW_TEMPERATURE_AND_FALLBACK_ERROR,
        statusCode: undefined,
        code: 'unsupported_temperature',
        zhSummary: '模型参数不兼容：当前模型只支持默认温度 1；同时中转没有为当前模型配置可用降级。\n建议：重试会使用默认温度 1；如果仍失败，请切换模型，或在中转侧补上当前模型的 fallback 映射。',
      },
      {
        name: 'upstream_unavailable',
        raw: 'Bad Gateway',
        statusCode: 502,
        code: 'upstream_unavailable',
        zhSummary: '模型服务暂时不可用：上游网关没能把请求转过去（通常是服务方在抖动或限流）。\n建议：稍等几秒重试；持续失败就在输入框右下角换一个模型。',
      },
      {
        name: 'fallback_not_configured',
        raw: 'No fallback model group found for original model_group=gpt-5.5',
        statusCode: undefined,
        code: 'fallback_not_configured',
        zhSummary: '模型降级未配置：中转没有为当前模型配置可用 fallback。\n建议：请切换到已配置的模型，或在中转侧补上当前模型的 fallback 映射后重试。',
      },
      {
        name: 'incomplete_response',
        raw: '模型服务返回的内容不完整，已自动重试一次仍然失败。',
        statusCode: undefined,
        code: 'incomplete_response',
        zhSummary: '模型服务返回的内容不完整，已自动重试一次仍然失败。\n建议：请稍后再试一次；持续失败就在输入框右下角换一个模型。',
      },
    ] as const;

    for (const { name, raw, statusCode, code, zhSummary } of cases) {
      const enDiagnostic = classifyModelErrorMessage(raw, statusCode, 'en');
      expect(enDiagnostic?.code, name).toBe(code);
      const enSummary = summarizeModelErrorForUser(raw, statusCode, 'en');
      for (const text of [enDiagnostic!.message, enDiagnostic!.suggestion, enSummary]) {
        expect(text, name).not.toMatch(/[㐀-鿿]/u);
      }
      expect(enSummary, name).toContain('\nSuggestion: ');

      const zhDiagnostic = classifyModelErrorMessage(raw, statusCode, 'zh');
      expect(zhDiagnostic?.code, name).toBe(code);
      expect(summarizeModelErrorForUser(raw, statusCode, 'zh'), name).toBe(zhSummary);
      // zh 是默认 locale，不显式传也要逐字一致
      expect(summarizeModelErrorForUser(raw, statusCode), name).toBe(zhSummary);
    }
  });

  it('裸 429 限流不算欠费（quota 语义只认文案/402）', () => {
    expect(classifyModelErrorMessage('rate limit exceeded', 429)).toBeNull();
  });

  it('2xx 坏响应体终态文案归 incomplete_response，且不含内部词', () => {
    const text = '模型服务返回的内容不完整，已自动重试一次仍然失败。\n建议：请稍后再试一次；持续失败就在输入框右下角换一个模型。';
    expect(classifyModelErrorMessage(text)?.code).toBe('incomplete_response');
    expect(summarizeModelErrorForUser(text)).toBe(text);
  });

  it('已落库的中文 incomplete_response 与新英文句都按调用方 locale 重新出文案', () => {
    const storedZh = '模型服务返回的内容不完整，已自动重试一次仍然失败。\n建议：请稍后再试一次；持续失败就在输入框右下角换一个模型。';
    const storedEn = summarizeModelErrorForUser(storedZh, undefined, 'en');

    for (const stored of [storedZh, storedEn]) {
      const zh = classifyModelErrorMessage(stored, undefined, 'zh');
      expect(zh).toMatchObject(incompleteResponseDiagnostic('zh'));
      const en = classifyModelErrorMessage(stored, undefined, 'en');
      expect(en).toMatchObject(incompleteResponseDiagnostic('en'));
      expect(en!.message).not.toMatch(/[㐀-鿿]/u);
      expect(summarizeModelErrorForUser(stored, undefined, 'en')).toBe(storedEn);
    }
  });
});
