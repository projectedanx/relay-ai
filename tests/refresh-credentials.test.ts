import { describe, it, expect } from 'vitest';
import { isPlaceholderProviderKey } from '../src/registry/refresh-credentials.js';

describe('isPlaceholderProviderKey', () => {
  it('detects OpenCode placeholder keys', () => {
    expect(isPlaceholderProviderKey('anything')).toBe(true);
    expect(isPlaceholderProviderKey('ollama')).toBe(true);
    expect(isPlaceholderProviderKey('local')).toBe(true);
  });

  it('accepts real-looking keys', () => {
    expect(isPlaceholderProviderKey('sk-ant-api03-abc123')).toBe(false);
    expect(isPlaceholderProviderKey('nvapi-abc123def456')).toBe(false);
  });

  it('treats empty as placeholder', () => {
    expect(isPlaceholderProviderKey('')).toBe(true);
    expect(isPlaceholderProviderKey(null)).toBe(true);
  });
});
