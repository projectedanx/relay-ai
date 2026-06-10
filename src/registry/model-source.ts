// src/registry/model-source.ts — resolve how a registry provider refreshes its model list

import { getTemplateById, type ProviderModelSource } from '../provider-templates.js';
import type { RegistryProvider } from './types.js';

export function resolveModelSource(provider: RegistryProvider): ProviderModelSource {
  if (provider.id === 'zen' || provider.id === 'go' || provider.templateId === 'zen' || provider.templateId === 'go') {
    return 'zen-go-api';
  }
  const template = getTemplateById(provider.templateId);
  if (template) return template.modelSource;
  if (provider.templateId === 'custom-openai' || provider.templateId === 'custom-anthropic') {
    return 'api-list';
  }
  return 'api-list';
}
