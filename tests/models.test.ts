// tests/models.test.ts
import { describe, it, expect } from 'vitest';
import {
  deriveBrand,
  mergeModels,
  groupModels,
} from '../src/models.js';
import type { ModelInfo } from '../src/types.js';

describe('deriveBrand', () => {
  it.each([
    ['claude-opus', 'Claude'],
    ['claude-sonnet', 'Claude'],
    ['gpt', 'GPT'],
    ['gpt-codex', 'GPT'],
    ['gpt-mini', 'GPT'],
    ['gemini-pro', 'Gemini'],
    ['gemini-flash', 'Gemini'],
    ['deepseek-flash', 'DeepSeek'],
    ['qwen', 'Qwen'],
    ['qwen-free', 'Qwen'],
    ['minimax', 'MiniMax'],
    ['minimax-m3-free', 'MiniMax'],
    ['kimi', 'Kimi'],
    ['kimi-free', 'Kimi'],
    ['glm', 'GLM'],
    ['glm-free', 'GLM'],
    ['mimo-flash-free', 'MiMo'],
    ['grok', 'Grok'],
    ['nemotron-free', 'Nemotron'],
    ['big-pickle', 'Other'],
    ['ring-1t-free', 'Other'],
  ])('deriveBrand("%s") === "%s"', (family, expected) => {
    expect(deriveBrand(family)).toBe(expected);
  });
});

describe('mergeModels', () => {
  it('returns minimal ModelInfo when cache is null', () => {
    const result = mergeModels(['claude-opus-4-8'], null);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'claude-opus-4-8',
      name: 'claude-opus-4-8',
      isFree: false,
      brand: 'Other',
      isAnthropicNative: false,
    });
  });

  it('enriches models with cache data when available', () => {
    const cache = new Map([
      ['claude-sonnet-4-6', {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        isFree: false,
        brand: 'Claude',
        isAnthropicNative: true,
        cost: { input: 3, output: 15 },
      }],
    ]);
    const result = mergeModels(['claude-sonnet-4-6'], cache);
    expect(result[0]).toMatchObject({
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      isFree: false,
      isAnthropicNative: true,
      brand: 'Claude',
    });
  });

  it('marks non-Anthropic models as not native', () => {
    const cache = new Map([
      ['deepseek-v4-flash-free', {
        id: 'deepseek-v4-flash-free',
        name: 'DeepSeek V4 Flash Free',
        isFree: true,
        brand: 'DeepSeek',
        isAnthropicNative: false,
        cost: { input: 0, output: 0 },
      }],
    ]);
    const result = mergeModels(['deepseek-v4-flash-free'], cache);
    expect(result[0]).toMatchObject({
      isFree: true,
      isAnthropicNative: false,
    });
  });

  it('skips cache entries for models not in API list', () => {
    const cache = new Map([
      ['model-in-cache', { id: 'model-in-cache', name: 'X', isFree: false, brand: 'Other', isAnthropicNative: false }],
    ]);
    const result = mergeModels(['model-from-api'], cache);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('model-from-api');
  });
});

describe('groupModels', () => {
  const makeModel = (id: string, isFree: boolean, brand: string, isAnthropicNative = false): ModelInfo => ({
    id,
    name: id,
    isFree,
    brand,
    isAnthropicNative,
  });

  it('separates free models from paid models', () => {
    const models = [
      makeModel('claude-sonnet', false, 'Claude', true),
      makeModel('deepseek-free', true, 'DeepSeek', false),
    ];
    const { free, byBrand } = groupModels(models);
    expect(free).toHaveLength(1);
    expect(free[0]!.id).toBe('deepseek-free');
    expect([...byBrand.keys()]).toContain('Claude');
    expect(byBrand.get('Claude')!).toHaveLength(1);
  });

  it('sorts free models alphabetically by id', () => {
    const models = [
      makeModel('z-free', true, 'Other'),
      makeModel('a-free', true, 'Other'),
      makeModel('m-free', true, 'Other'),
    ];
    const { free } = groupModels(models);
    expect(free.map(m => m.id)).toEqual(['a-free', 'm-free', 'z-free']);
  });

  it('sorts paid models alphabetically by id within each brand', () => {
    const models = [
      makeModel('claude-z', false, 'Claude', true),
      makeModel('claude-a', false, 'Claude', true),
    ];
    const { byBrand } = groupModels(models);
    const claudeModels = byBrand.get('Claude')!;
    expect(claudeModels.map(m => m.id)).toEqual(['claude-a', 'claude-z']);
  });

  it('returns empty free array and empty map when all models are paid', () => {
    const models = [makeModel('claude-opus', false, 'Claude', true)];
    const { free, byBrand } = groupModels(models);
    expect(free).toHaveLength(0);
    expect(byBrand.size).toBe(1);
  });
});
