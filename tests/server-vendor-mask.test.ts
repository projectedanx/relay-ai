import { describe, expect, it } from 'vitest';
import { createGatewayModelCatalog, formatGatewayAnthropicModels } from '../src/server/models.js';
import type { ServerModelInfo } from '../src/server/models.js';
import { maskGatewayModelId, maskVendorText } from '../src/server/vendor-mask.js';

function model(partial: Partial<ServerModelInfo> & Pick<ServerModelInfo, 'id'>): ServerModelInfo {
  return {
    name: partial.name ?? partial.id,
    isFree: false,
    brand: 'DeepSeek',
    sourceBackend: 'zen',
    modelFormat: 'openai',
    providerId: 'zen',
    providerLabel: 'OpenCode Zen',
    ...partial,
  };
}

describe('vendor mask', () => {
  it('masks vendor substrings in text', () => {
    expect(maskVendorText('DeepSeek V4 Flash Free')).toBe('keespeed V4 Flash Free');
    expect(maskVendorText('Qwen3.7 Max')).toBe('newq3.7 Max');
  });

  it('masks gateway alias suffix only', () => {
    expect(maskGatewayModelId('anthropic-opencode-zen__deepseek-v4-flash-free'))
      .toBe('anthropic-opencode-zen__keespeed-v4-flash-free');
  });

  it('masks residual family shorthand blocked by Desktop after vendor masking', () => {
    expect(maskGatewayModelId('anthropic-opencode-go__minimax-m2.7'))
      .toBe('anthropic-opencode-go__xaminim-2m.7');
    expect(maskGatewayModelId('anthropic-opencode-go__minimax-m2.5'))
      .toBe('anthropic-opencode-go__xaminim-2m.5');
    expect(maskGatewayModelId('anthropic-opencode-go__kimi-k2.6'))
      .toBe('anthropic-opencode-go__imik-2k.6');
    expect(maskGatewayModelId('anthropic-opencode-go__kimi-k2.5'))
      .toBe('anthropic-opencode-go__imik-2k.5');
    expect(maskGatewayModelId('anthropic-opencode-go__hy3-preview'))
      .toBe('anthropic-opencode-go__3yh-preview');
  });

  it('resolves all five previously missing models in the gateway catalog', () => {
    const missing = [
      { id: 'minimax-m2.7', name: 'MiniMax M2.7', providerId: 'go', providerLabel: 'OpenCode Go', sourceBackend: 'go' as const },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5', providerId: 'go', providerLabel: 'OpenCode Go', sourceBackend: 'go' as const },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', providerId: 'go', providerLabel: 'OpenCode Go', sourceBackend: 'go' as const },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', providerId: 'go', providerLabel: 'OpenCode Go', sourceBackend: 'go' as const },
      { id: 'hy3-preview', name: 'hy3-preview', providerId: 'go', providerLabel: 'OpenCode Go', sourceBackend: 'go' as const },
    ].map(m => model({ ...m, brand: 'Other' }));

    const catalog = createGatewayModelCatalog(missing, { maskVendors: true });
    const listed = formatGatewayAnthropicModels(missing, { maskVendors: true });

    expect(listed.data).toHaveLength(5);
    for (const entry of listed.data) {
      expect(catalog.get(entry.id)?.id).toBeTruthy();
      expect(entry.display_name).toContain('OpenCode Go');
      expect(entry.display_name).not.toMatch(/keespeed|newq|xaminim|imik|3yh/i);
    }
  });

  it('exposes masked ids in discovery while resolving chat requests', () => {
    const models = [
      model({ id: 'big-pickle', name: 'Big Pickle', brand: 'Other' }),
      model({ id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' }),
    ];
    const catalog = createGatewayModelCatalog(models, { maskVendors: true });
    const listed = formatGatewayAnthropicModels(models, { maskVendors: true });

    expect(listed.data.map(entry => entry.id)).toEqual([
      'anthropic-opencode-zen__big-pickle',
      'anthropic-opencode-zen__keespeed-v4-flash-free',
    ]);
    expect(listed.data[1]!.display_name).toBe('DeepSeek V4 Flash Free (OpenCode Zen)');
    expect(catalog.get('anthropic-opencode-zen__keespeed-v4-flash-free')?.id).toBe('deepseek-v4-flash-free');
  });
});
