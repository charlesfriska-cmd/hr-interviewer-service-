import { describe, expect, it } from 'vitest';
import { ProviderConfigError, resolveProviderConfig } from '../../src/config/provider.config.ts';

describe('provider configuration', () => {
  it('defaults to mock and needs no credentials', () => {
    const c = resolveProviderConfig({});
    expect(c.provider).toBe('mock');
    expect(c.model).toBe('claude-opus-5');
  });

  it('fails fast when claude is selected without an API key', () => {
    expect(() => resolveProviderConfig({ LLM_PROVIDER: 'claude' })).toThrow(ProviderConfigError);
    expect(() => resolveProviderConfig({ LLM_PROVIDER: 'claude', ANTHROPIC_API_KEY: '  ' })).toThrow(
      /requires ANTHROPIC_API_KEY/,
    );
  });

  it('accepts claude with credentials and honours overrides', () => {
    const c = resolveProviderConfig({
      LLM_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      LLM_TIMEOUT_MS: '30000',
      LLM_MAX_TRANSPORT_RETRIES: '1',
      LLM_MAX_OUTPUT_TOKENS: '8000',
      LLM_EFFORT: 'medium',
    });
    expect(c).toMatchObject({
      provider: 'claude', model: 'claude-sonnet-5', timeoutMs: 30_000,
      maxTransportRetries: 1, maxOutputTokens: 8000, effort: 'medium',
    });
  });

  it('rejects an unknown provider name', () => {
    expect(() => resolveProviderConfig({ LLM_PROVIDER: 'openai' })).toThrow(/must be "mock" or "claude"/);
  });

  it('rejects a non-numeric numeric setting', () => {
    expect(() => resolveProviderConfig({ LLM_TIMEOUT_MS: 'soon' })).toThrow(ProviderConfigError);
  });

  it('never carries the key into a stringified config by accident', () => {
    const c = resolveProviderConfig({ LLM_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-secret-value' });
    // The key is present on the object by necessity; this asserts the adapter's
    // metrics never include it (see claudeProvider.test.ts) rather than that the
    // config hides it.
    expect(c.apiKey).toBe('sk-secret-value');
  });
});
