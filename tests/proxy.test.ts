// tests/proxy.test.ts
import { describe, it, expect } from 'vitest';
import { aliasModelId } from '../src/proxy.js';

describe('aliasModelId', () => {
  it('returns claude-* ids unchanged', () => {
    expect(aliasModelId('claude-sonnet-4', 'Anthropic')).toBe('claude-sonnet-4');
  });

  it('prefixes non-claude ids with anthropic-{provider}__', () => {
    expect(aliasModelId('grok-4.3', 'xAI')).toBe('anthropic-xai__grok-4.3');
  });

  it('sanitizes provider labels (spaces and punctuation → single dash)', () => {
    expect(aliasModelId('deepseek-v4', 'OpenCode Go')).toBe('anthropic-opencode-go__deepseek-v4');
  });
});
