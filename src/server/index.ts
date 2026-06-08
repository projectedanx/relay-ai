import pc from 'picocolors';
import { networkInterfaces } from 'node:os';
import * as p from '@clack/prompts';
import { resolveApiKey, readFromCredentialStore } from '../env.js';
import { sanitizeCredential } from './auth.js';
import {
  getSavedServerPassword,
  getServerExposedProviders,
  getSubscriptionTier,
  loadPreferences,
  setSavedServerPassword,
  setServerExposedProviders,
} from '../config.js';
import { BACKENDS } from '../constants.js';
import { fetchProviderCatalog, fetchZenGoModels, localProvidersToServerModels, zenGoModelsToServerModels } from '../provider-catalog.js';
import { fetchLocalProviders } from '../providers.js';
import type { ModelInfo } from '../types.js';
import type { ServerModelInfo } from './models.js';
import {
  askListenMode,
  askSaveServerPassword,
  askServerPassword,
  askUseSavedServerPassword,
} from './prompts.js';
import { createGatewayModelCatalog } from './models.js';
import { startServer } from './router.js';
import {
  filterServerModelsByFavorites,
  filterServerModelsByProviders,
  summarizeServerProviders,
} from './catalog-filter.js';
import { selectServerProviders, type ServerProviderOption } from './provider-select.js';

type SubscriptionTier = 'free' | 'zen' | 'go' | 'both';

export interface ServerCommandOptions {
  select?: boolean;
  favorites?: boolean;
  maskVendors?: boolean;
}

function getLocalIp(): string {
  const ifaces = networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '<this-computer-ip>';
}

function modelsForTier(tier: SubscriptionTier, backendId: 'zen' | 'go', models: ModelInfo[]): ModelInfo[] {
  if (tier === 'free') return backendId === 'zen' ? models.filter(model => model.isFree) : [];
  if (tier === 'go') return backendId === 'zen' ? models.filter(model => model.isFree) : models;
  return models;
}

function waitForShutdown(): Promise<void> {
  return new Promise(resolve => {
    const cleanup = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
    const onSignal = () => {
      cleanup();
      resolve();
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

async function getServerPasswordForMode(mode: 'local' | 'network'): Promise<string | null | undefined> {
  if (mode === 'local') return null;

  const savedPassword = getSavedServerPassword();
  let serverPassword: string | null = null;

  if (savedPassword) {
    const savedChoice = await askUseSavedServerPassword();
    if (!savedChoice) return undefined;
    serverPassword = savedChoice === 'use-saved' ? savedPassword : await askServerPassword();
  } else {
    serverPassword = await askServerPassword();
  }

  if (!serverPassword) return undefined;

  if (serverPassword !== savedPassword) {
    const savePassword = await askSaveServerPassword();
    if (savePassword === null) return undefined;
    if (savePassword) setSavedServerPassword(serverPassword);
  }

  return serverPassword;
}

async function loadServerModels(tier: SubscriptionTier): Promise<ServerModelInfo[]> {
  const needsZen = tier === 'free' || tier === 'zen' || tier === 'go' || tier === 'both';
  const needsGo = tier === 'go' || tier === 'both';
  const models: ServerModelInfo[] = [];

  const zenGoBackends: Array<'zen' | 'go'> = [];
  if (needsZen) zenGoBackends.push('zen');
  if (needsGo) zenGoBackends.push('go');

  if (zenGoBackends.length > 0) {
    const zenGo = await fetchZenGoModels(zenGoBackends, true);
    if (needsZen) models.push(...zenGoModelsToServerModels(modelsForTier(tier, 'zen', zenGo.zenModels)));
    if (needsGo) models.push(...zenGoModelsToServerModels(modelsForTier(tier, 'go', zenGo.goModels)));
  }

  try {
    const localProviders = await fetchLocalProviders();
    if (localProviders !== null) {
      models.push(...localProvidersToServerModels(localProviders));
    } else {
      p.log.info('No local providers found — using cloud models only');
    }
  } catch {
    p.log.info('No local providers found — using cloud models only');
  }

  return models;
}

function providerOptionsForTier(
  tier: SubscriptionTier,
  catalog: Awaited<ReturnType<typeof fetchProviderCatalog>>,
): ServerProviderOption[] {
  const options: ServerProviderOption[] = [];
  const needsZen = tier === 'free' || tier === 'zen' || tier === 'go' || tier === 'both';
  const needsGo = tier === 'go' || tier === 'both';

  if (needsZen && catalog.zenModels.length > 0) {
    options.push({
      id: 'zen',
      name: 'OpenCode Zen',
      modelCount: modelsForTier(tier, 'zen', catalog.zenModels).length,
    });
  }
  if (needsGo && catalog.goModels.length > 0) {
    options.push({
      id: 'go',
      name: 'OpenCode Go',
      modelCount: modelsForTier(tier, 'go', catalog.goModels).length,
    });
  }
  for (const provider of catalog.localProviders) {
    options.push({
      id: provider.id,
      name: provider.name,
      modelCount: provider.models.length,
    });
  }
  return options;
}

async function resolveExposedProviders(
  tier: SubscriptionTier,
  opts: ServerCommandOptions,
): Promise<string[] | null | undefined> {
  if (opts.select) {
    p.intro(pc.bold('  OpenCode Starter — Server Providers'));
    p.log.info('Add providers to expose. Listed providers are removed when selected — like favorites.');
    const spinner = p.spinner();
    spinner.start('Loading providers...');
    const catalog = await fetchProviderCatalog();
    spinner.stop('');

    const available = providerOptionsForTier(tier, catalog);
    const picked = await selectServerProviders(available, getServerExposedProviders() ?? undefined);
    if (!picked) return undefined;
    setServerExposedProviders(picked);
    p.log.success(`Saved ${picked.length} provider${picked.length !== 1 ? 's' : ''} for future server runs.`);
    return picked;
  }

  return getServerExposedProviders();
}

export async function runServerCommand(opts: ServerCommandOptions = {}): Promise<number> {
  let apiKey = resolveApiKey();
  if (!apiKey) {
    apiKey = await readFromCredentialStore((reason) => {
      p.log.warn(`Credential store unavailable — ${reason}`);
    });
    if (apiKey) {
      const isMac = process.platform === 'darwin';
      const isWindows = process.platform === 'win32';
      const storeName = isMac ? 'macOS Keychain' : isWindows ? 'Windows Credential Manager' : 'Secret Service';
      p.log.success(`Found key in ${storeName}`);
    }
  }

  apiKey = sanitizeCredential(apiKey) ?? '';
  if (!apiKey) {
    p.log.error('Missing OPENCODE_API_KEY. Run `opencode-starter claude` once to configure your key, or export OPENCODE_API_KEY.');
    return 1;
  }

  const tier = getSubscriptionTier();
  if (!tier) {
    p.log.error('Missing subscription tier. Run `opencode-starter claude --setup` first.');
    return 1;
  }

  const exposedProviders = await resolveExposedProviders(tier, opts);
  if (exposedProviders === undefined) return 0;

  const mode = await askListenMode();
  if (!mode) return 0;

  const serverPassword = await getServerPasswordForMode(mode);
  if (serverPassword === undefined) return 0;

  const host = mode === 'network' ? '0.0.0.0' : '127.0.0.1';
  const spinner = p.spinner();
  spinner.start('Fetching available models...');

  let models: ServerModelInfo[];
  try {
    models = await loadServerModels(tier);
    if (exposedProviders) {
      models = filterServerModelsByProviders(models, exposedProviders);
    }
    if (opts.favorites) {
      const favorites = loadPreferences().favoriteModels ?? [];
      if (favorites.length === 0) {
        spinner.stop(pc.red('No favorite models configured'));
        p.log.error('Run `opencode-starter models` to add favorites, or start without --favorites.');
        return 1;
      }
      models = filterServerModelsByFavorites(models, favorites);
      if (models.length === 0) {
        spinner.stop(pc.red('No favorite models matched the current provider filter'));
        p.log.error('Adjust favorites with `opencode-starter models` or run `opencode-starter server --select`.');
        return 1;
      }
    }
    if (models.length === 0) {
      spinner.stop(pc.red('No models to expose'));
      p.log.error('Run `opencode-starter server --select` to choose providers with available models.');
      return 1;
    }

    const localCount = models.filter(m => m.apiKey !== undefined).length;
    const summary = summarizeServerProviders(models);
    const filterNote = exposedProviders
      ? ` — ${exposedProviders.length} provider${exposedProviders.length !== 1 ? 's' : ''}`
      : '';
    const favoritesNote = opts.favorites ? ' — favorites only' : '';
    spinner.stop(`Loaded ${models.length} models (${localCount} from local providers)${filterNote}${favoritesNote}`);
    if (summary) p.log.info(summary);
  } catch (err) {
    spinner.stop(pc.red('Failed to load models'));
    console.error(pc.red(String(err instanceof Error ? err.message : err)));
    return 1;
  }

  const gateway = opts.maskVendors ? { maskVendors: true as const } : undefined;
  const server = await startServer({
    host,
    port: 17645,
    apiKey,
    serverPassword,
    catalog: createGatewayModelCatalog(models, gateway),
    backends: BACKENDS,
    gateway,
  });

  console.log('');
  console.log(pc.bold(pc.green('OpenCode Starter server running')));
  console.log(`  Anthropic:  http://127.0.0.1:${server.port}/anthropic`);
  console.log(`  OpenAI:     http://127.0.0.1:${server.port}/openai`);
  if (mode === 'network') {
    console.log(`  Network:    http://${getLocalIp()}:${server.port}`);
    console.log(`  API key:    ${serverPassword}`);
  } else {
    console.log('  API key:    any non-empty value');
  }
  if (exposedProviders) {
    console.log(pc.dim(`  Providers:  ${exposedProviders.join(', ')} (server --select to change)`));
  }
  if (opts.favorites) {
    console.log(pc.dim('  Catalog:    favorite models only (server --favorites)'));
  }
  if (opts.maskVendors) {
    console.log(pc.dim('  Discovery:  vendor-neutral gateway ids (display names stay readable)'));
  }
  console.log('');
  console.log(pc.dim('Press Ctrl+C to stop.'));

  await waitForShutdown();
  await server.close();
  return 0;
}
