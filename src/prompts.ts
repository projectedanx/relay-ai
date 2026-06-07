// src/prompts.ts
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { BackendConfig, ModelInfo, UserPreferences, ConflictInfo, LocalProvider, LocalProviderModel } from './types.js';
import { BACKENDS } from './constants.js';
import { groupModels } from './models.js';

function modelLabel(model: ModelInfo, showBackendBadge = false): string {
  if (model.modelFormat === 'unsupported') {
    return pc.dim(`${model.name} (not yet supported)`);
  }
  if (model.isFree) {
    const tag = showBackendBadge ? '(free · Zen)' : '(free)';
    return pc.green(`${model.name} ${tag}`);
  }
  return model.name;
}

function modelHint(model: ModelInfo): string {
  const parts: string[] = [];
  if (model.modelFormat === 'openai') parts.push('via proxy');
  else if (model.modelFormat === 'unsupported') parts.push('needs format support');
  if (!model.isFree) parts.push(`${model.brand} · ${model.id}`);
  else parts.push(model.id);
  return parts.join(' · ');
}

export async function askSubscriptionTier(): Promise<'free' | 'zen' | 'go' | 'both' | null> {
  const tier = await p.select<'free' | 'zen' | 'go' | 'both'>({
    message: 'What OpenCode subscription do you have?',
    options: [
      {
        value: 'free' as const,
        label: 'Free only',
        hint: 'Zen free models only — no subscription needed',
      },
      {
        value: 'zen' as const,
        label: 'Zen subscription',
        hint: 'All Zen models (paid + free)',
      },
      {
        value: 'go' as const,
        label: 'Go subscription',
        hint: 'All Go models',
      },
      {
        value: 'both' as const,
        label: 'Both (Zen + Go)',
        hint: 'All Go models + all Zen models — choose backend each launch',
      },
    ],
    initialValue: 'free' as const,
  });

  if (p.isCancel(tier)) {
    p.cancel('Cancelled.');
    return null;
  }

  return tier;
}

const BROWSE_ALL = '__browse_all__';
const MAX_RECENT = 3;
/** Providers with more models than this offer search or paginated browse. */
export const MODEL_SEARCH_THRESHOLD = 25;
/** Models shown per page when browsing large catalogs. */
export const MODEL_PAGE_SIZE = 15;

const PAGE_PREV = '__page_prev__';
const PAGE_NEXT = '__page_next__';
const SWITCH_SEARCH = '__switch_search__';
const SWITCH_BROWSE = '__switch_browse__';
const MODE_SEARCH = 'search';
const MODE_BROWSE = 'browse';

type ModelSearchable = { id: string; name: string; brand: string };
type ModelSelectOption = { value: string; label: string; hint: string };
type LargeCatalogMode = 'choose' | 'search' | 'browse';

function sortModelsByBrand<T extends ModelSearchable>(models: T[]): T[] {
  return [...models].sort((a, b) => {
    const brandCmp = a.brand.localeCompare(b.brand);
    return brandCmp !== 0 ? brandCmp : a.id.localeCompare(b.id);
  });
}

export function filterModelsBySearch<T extends ModelSearchable>(models: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return models.filter(
    m =>
      m.id.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      m.brand.toLowerCase().includes(q),
  );
}

/** Slice a model list for paginated browse UI. */
export function sliceModelPage<T>(
  items: T[],
  page: number,
  pageSize = MODEL_PAGE_SIZE,
): { items: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = clampedPage * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: clampedPage,
    totalPages,
  };
}

type PagedPickResult<T> = T | 'search' | 'browse' | 'menu';

function isSelectedModel<T extends { id: string }>(value: PagedPickResult<T>): value is T {
  return value !== 'search' && value !== 'browse' && value !== 'menu';
}

async function pickModelFromPagedList<T extends { id: string }>(
  list: T[],
  toOption: (m: T) => ModelSelectOption,
  messagePrefix: string,
  initialModelId?: string,
  links?: { search?: boolean; browse?: boolean; newSearch?: boolean },
): Promise<PagedPickResult<T>> {
  let page = 0;

  if (initialModelId) {
    const idx = list.findIndex(m => m.id === initialModelId);
    if (idx >= 0) page = Math.floor(idx / MODEL_PAGE_SIZE);
  }

  while (true) {
    const { items: pageItems, page: currentPage, totalPages } = sliceModelPage(list, page);
    const options: ModelSelectOption[] = [];

    if (currentPage > 0) {
      options.push({
        value: PAGE_PREV,
        label: '← Previous page',
        hint: `Page ${currentPage} of ${totalPages}`,
      });
    }

    options.push(...pageItems.map(toOption));

    if (currentPage < totalPages - 1) {
      options.push({
        value: PAGE_NEXT,
        label: 'Next page →',
        hint: `Page ${currentPage + 2} of ${totalPages}`,
      });
    }

    if (links?.search) {
      options.push({ value: SWITCH_SEARCH, label: 'Search instead →', hint: '' });
    }
    if (links?.browse) {
      options.push({ value: SWITCH_BROWSE, label: 'Browse all instead →', hint: '' });
    }
    if (links?.newSearch) {
      options.push({ value: SWITCH_SEARCH, label: '← New search', hint: '' });
    }

    const initialValue =
      (initialModelId && pageItems.some(m => m.id === initialModelId) ? initialModelId : pageItems[0]?.id)
      ?? options[0]?.value;

    const picked = await p.select({
      message: `${messagePrefix} (page ${currentPage + 1} of ${totalPages})`,
      options,
      initialValue,
    });

    if (p.isCancel(picked)) return 'menu';

    const choice = String(picked);
    if (choice === PAGE_PREV) {
      page = currentPage - 1;
      continue;
    }
    if (choice === PAGE_NEXT) {
      page = currentPage + 1;
      continue;
    }
    if (choice === SWITCH_SEARCH) return 'search';
    if (choice === SWITCH_BROWSE) return 'browse';

    const selected = list.find(m => m.id === choice);
    if (selected) return selected;
    continue;
  }
}

async function selectLargeCatalog<T extends ModelSearchable & { id: string }>(
  models: T[],
  browseList: T[],
  toOption: (m: T) => ModelSelectOption,
  message: string,
  initialModelId?: string,
): Promise<T | null> {
  let mode: LargeCatalogMode = 'choose';

  while (true) {
    if (mode === 'choose') {
      const method = await p.select({
        message: `${message} (${models.length} available)`,
        options: [
          { value: MODE_SEARCH, label: 'Search models', hint: 'Filter by name, id, or brand' },
          {
            value: MODE_BROWSE,
            label: 'Browse all models',
            hint: `${MODEL_PAGE_SIZE} per page · ${Math.ceil(browseList.length / MODEL_PAGE_SIZE)} pages`,
          },
        ],
      });

      if (p.isCancel(method)) {
        p.cancel('Cancelled.');
        return null;
      }

      mode = method === MODE_BROWSE ? 'browse' : 'search';
      continue;
    }

    if (mode === 'browse') {
      const picked = await pickModelFromPagedList(
        browseList,
        toOption,
        message,
        initialModelId,
        { search: true },
      );

      if (picked === 'search') {
        mode = 'search';
        continue;
      }
      if (picked === 'menu') {
        mode = 'choose';
        continue;
      }
      if (isSelectedModel(picked)) return picked;

      continue;
    }

    const searchInput = await p.text({
      message: `Search models (${models.length} available):`,
      placeholder: 'e.g. claude, sonnet, llama',
    });

    if (p.isCancel(searchInput)) {
      mode = 'choose';
      continue;
    }

    const matched = filterModelsBySearch(browseList, String(searchInput));
    if (matched.length === 0) {
      p.log.warn('No models match — try a different search');
      continue;
    }

    const result = await pickModelFromPagedList(
      matched,
      toOption,
      matched.length === 1 ? 'Match found' : `Select model (${matched.length} matches)`,
      initialModelId,
      { browse: true, newSearch: true },
    );

    if (result === 'search') continue;
    if (result === 'browse') {
      mode = 'browse';
      continue;
    }
    if (result === 'menu') {
      mode = 'choose';
      continue;
    }
    if (isSelectedModel(result)) return result;
  }
}

async function selectModelWithSearch<T extends ModelSearchable & { id: string }>(
  models: T[],
  toOption: (m: T) => ModelSelectOption,
  message: string,
  initialModelId?: string,
  browseList?: T[],
): Promise<T | null> {
  if (models.length === 0) return null;

  const orderedBrowse = browseList ?? sortModelsByBrand(models);

  if (models.length <= MODEL_SEARCH_THRESHOLD) {
    const options = models.map(toOption);
    const initialValue =
      initialModelId && options.some(o => o.value === initialModelId)
        ? initialModelId
        : options[0]?.value;

    const picked = await p.select({
      message,
      options,
      initialValue,
    });

    if (p.isCancel(picked)) {
      p.cancel('Cancelled.');
      return null;
    }

    const selected = models.find(m => m.id === String(picked));
    if (!selected) return null;
    return selected;
  }

  return selectLargeCatalog(models, orderedBrowse, toOption, message, initialModelId);
}

function noteEnvConflicts(conflicts: ConflictInfo[]): void {
  if (conflicts.length === 0) return;
  const lines = conflicts.map(c => `  ${pc.dim(c.name)}=${pc.dim(c.value)}`).join('\n');
  p.note(lines, pc.yellow('Env vars that will be temporarily overridden:'));
}

function modelToOption(model: LocalProviderModel, hint?: string) {
  return {
    value: model.id,
    label: model.name !== model.id ? model.name : model.id,
    hint: hint ?? (model.name !== model.id ? model.id : model.brand),
  };
}

export async function browseAllModels(
  provider: LocalProvider,
  prefs: UserPreferences,
): Promise<LocalProviderModel | null> {
  return selectModelWithSearch(
    provider.models,
    m => modelToOption(m),
    'Which model?',
    prefs.lastModel,
  );
}

export async function pickLocalModel(
  provider: LocalProvider,
  conflicts: ConflictInfo[],
  prefs: UserPreferences,
): Promise<LocalProviderModel | null> {
  // Show recently used models for this provider if we have any.
  const recentIds = (prefs.recentModelsByProvider?.[provider.id] ?? []).slice(0, MAX_RECENT);
  const recentModels = recentIds
    .map(id => provider.models.find(m => m.id === id))
    .filter((m): m is LocalProviderModel => m !== undefined);

  let selectedModel: LocalProviderModel;

  if (recentModels.length > 0) {
    const options = [
      ...recentModels.map(m => modelToOption(m, 'recent')),
      { value: BROWSE_ALL, label: 'Browse all models →', hint: `${provider.models.length} available` },
    ];

    const picked = await p.select({
      message: 'Which model?',
      options,
      initialValue: recentModels[0].id,
    });

    if (p.isCancel(picked)) {
      p.cancel('Cancelled.');
      return null;
    }

    if (String(picked) === BROWSE_ALL) {
      const browsed = await browseAllModels(provider, prefs);
      if (!browsed) return null;
      selectedModel = browsed;
    } else {
      selectedModel = recentModels.find(m => m.id === String(picked))!;
    }
  } else {
    const browsed = await browseAllModels(provider, prefs);
    if (!browsed) return null;
    selectedModel = browsed;
  }

  noteEnvConflicts(conflicts);

  const confirmed = await p.confirm({
    message: `Launch Claude Code · ${pc.bold(selectedModel.id)} via ${pc.bold(provider.name)}?`,
    initialValue: true,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Cancelled.');
    return null;
  }

  p.outro(pc.green('Launching...'));
  return selectedModel;
}

export async function runWizard(
  prefs: UserPreferences,
  modelsByBackend: { zen: ModelInfo[]; go: ModelInfo[] },
  conflicts: ConflictInfo[],
  tier: 'free' | 'zen' | 'go' | 'both',
): Promise<{ backend: BackendConfig; model: ModelInfo } | null> {
  // Backend selection — only shown for 'both' tier (user has two distinct backends to choose from).
  // free/zen → always Zen. go → mixed list (Zen free + Go paid), backend resolved per model.
  let selectorBackendId: 'zen' | 'go' | null = null;
  if (tier === 'both') {
    const backendId = await p.select<'zen' | 'go'>({
      message: 'Which backend?',
      options: [
        { value: 'zen' as const, label: 'OpenCode Zen', hint: '66+ models, free tier available' },
        { value: 'go' as const, label: 'OpenCode Go', hint: '17 models, subscription ($10/mo)' },
      ],
      initialValue: prefs.lastBackend ?? 'zen',
    });

    if (p.isCancel(backendId)) {
      p.cancel('Cancelled.');
      return null;
    }
    selectorBackendId = backendId;
  }

  // Determine which models to show based on tier
  // For 'go': Zen free models first (labeled "free · Zen"), then all Go paid models.
  // Backend for each model is its sourceBackend — resolved after the user picks.
  const showBackendBadge = tier === 'go';
  let models: ModelInfo[];
  if (tier === 'free') {
    models = modelsByBackend.zen.filter(m => m.isFree);
  } else if (tier === 'zen') {
    models = modelsByBackend.zen;
  } else if (tier === 'go') {
    const zenFree = modelsByBackend.zen.filter(m => m.isFree);
    models = [...zenFree, ...modelsByBackend.go];
  } else {
    // both: all models for the selected backend
    models = selectorBackendId === 'go' ? modelsByBackend.go : modelsByBackend.zen;
  }

  // Partition selectable vs unsupported (GPT/Gemini need formats we don't translate yet)
  const selectableModels: ModelInfo[] = [];
  const unsupportedModels: ModelInfo[] = [];
  for (const m of models) {
    (m.modelFormat === 'unsupported' ? unsupportedModels : selectableModels).push(m);
  }

  // Preserve free-first + brand grouping for short lists; search mode uses flat matches.
  const { free, byBrand } = groupModels(selectableModels);
  const brandOrder = ['Claude', 'GPT', 'Gemini', 'DeepSeek', 'Qwen', 'MiniMax', 'Kimi', 'GLM', 'MiMo', 'Grok', 'Nemotron', 'Other'];
  const sortedBrands = [...byBrand.keys()].sort(
    (a, b) => (brandOrder.indexOf(a) !== -1 ? brandOrder.indexOf(a) : 99) - (brandOrder.indexOf(b) !== -1 ? brandOrder.indexOf(b) : 99),
  );
  const orderedSelectable: ModelInfo[] = [
    ...free,
    ...sortedBrands.flatMap(brand => byBrand.get(brand) ?? []),
  ];

  if (orderedSelectable.length === 0) {
    p.cancel('No models available for this backend and subscription tier.');
    return null;
  }

  const selectedModel = await selectModelWithSearch(
    orderedSelectable,
    m => ({ value: m.id, label: modelLabel(m, showBackendBadge), hint: modelHint(m) }),
    'Which model?',
    prefs.lastModel,
    orderedSelectable,
  );

  if (!selectedModel) return null;

  // Show note about unsupported models if any were partitioned out
  if (unsupportedModels.length > 0) {
    const brandCounts = unsupportedModels.reduce<Record<string, number>>((acc, m) => {
      acc[m.brand] = (acc[m.brand] ?? 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(brandCounts).map(([b, c]) => `${b} (${c})`).join(', ');
    p.log.info(pc.dim(`Not yet supported: ${summary} — need API format translation`));
  }

  // Backend is always determined by which model was picked (critical for 'go' tier
  // where Zen free models and Go paid models coexist in the same list).
  const backend = BACKENDS[selectedModel.sourceBackend];

  noteEnvConflicts(conflicts);

  const confirmed = await p.confirm({
    message: `Launch Claude Code · ${pc.bold(selectedModel.id)} via ${pc.bold(backend.name)}?`,
    initialValue: true,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Cancelled.');
    return null;
  }

  p.outro(pc.green('Launching...'));

  return { backend, model: selectedModel };
}
