// src/server/models.ts
import { resolveContextWindow } from '../context-window.js';

export type ServerModelFormat = 'anthropic' | 'openai' | 'unsupported';
export type ServerBackendId = 'zen' | 'go';

export interface ServerModelInfo {
  id: string;
  name: string;
  isFree: boolean;
  brand: string;
  sourceBackend: ServerBackendId;
  modelFormat: ServerModelFormat;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  baseUrl?: string;        // anthropic-format: direct Anthropic-protocol URL (without /v1)
  completionsUrl?: string; // openai-format: full chat completions endpoint URL
  apiKey?: string;         // model-specific API key; overrides server-level apiKey if set; never returned in API responses
  contextWindow?: number;
}

export interface ModelCatalog {
  get: (id: string) => ServerModelInfo | undefined;
  list: () => ServerModelInfo[];
}

const CREATED_AT_ISO = '2025-01-01T00:00:00Z';
const CREATED_AT_UNIX = 1735689600;

export function formatAnthropicModelEntry(
  id: string,
  displayName: string,
  contextWindow?: number,
) {
  const maxInput = resolveContextWindow(id, contextWindow);
  return {
    id,
    type: 'model' as const,
    display_name: displayName,
    created_at: CREATED_AT_ISO,
    context_window: maxInput,
    max_input_tokens: maxInput,
  };
}

export function createModelCatalog(models: ServerModelInfo[]): ModelCatalog {
  const byId = new Map(models.map(model => [model.id, model]));

  return {
    get: (id: string) => byId.get(id),
    list: () => [...models],
  };
}

export function formatAnthropicModels(models: ServerModelInfo[]) {
  return {
    data: models.map(model => formatAnthropicModelEntry(model.id, model.name, model.contextWindow)),
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models.at(-1)?.id ?? null,
  };
}

export function formatOpenAIModels(models: ServerModelInfo[]) {
  return {
    object: 'list',
    data: models.map(model => ({
      id: model.id,
      object: 'model',
      created: CREATED_AT_UNIX,
      owned_by: model.sourceBackend,
    })),
  };
}
