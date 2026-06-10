import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseProvidersArgs, providersHelpText } from '../src/providers-command.js';
import {
  addZenRegistryStub,
  removeProviderFromRegistry,
  toggleProviderEnabled,
} from '../src/registry/crud.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import { zenRegistryStub } from '../src/registry/builtins.js';
import * as env from '../src/env.js';

describe('parseProvidersArgs', () => {
  it('defaults to hub', () => {
    expect(parseProvidersArgs([])).toEqual({ subcommand: 'hub', showHelp: false });
  });

  it('parses add, import, list, remove', () => {
    expect(parseProvidersArgs(['add'])).toEqual({ subcommand: 'add', showHelp: false });
    expect(parseProvidersArgs(['import'])).toEqual({ subcommand: 'import', showHelp: false });
    expect(parseProvidersArgs(['list'])).toEqual({ subcommand: 'list', showHelp: false });
    expect(parseProvidersArgs(['remove', 'groq'])).toEqual({
      subcommand: 'remove',
      showHelp: false,
      removeId: 'groq',
    });
  });

  it('reports remove without id', () => {
    expect(parseProvidersArgs(['remove']).error).toContain('Usage');
  });

  it('annotates phase in help text', () => {
    const help = providersHelpText();
    expect(help).toContain('providers add');
    expect(help).toContain('providers remove');
    expect(help).toContain('Phase 1.1');
  });
});

describe('registry crud', () => {
  let home: string;
  const prevHome = process.env.RELAY_AI_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relay-ai-crud-'));
    process.env.RELAY_AI_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.RELAY_AI_HOME;
    else process.env.RELAY_AI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('adds zen stub once', () => {
    expect(addZenRegistryStub()).toEqual({ added: true });
    expect(addZenRegistryStub()).toEqual({ added: false, reason: 'OpenCode Zen is already configured.' });
    expect(loadRegistry().providers).toHaveLength(1);
  });

  it('toggles provider enabled state', () => {
    const registry = emptyRegistry();
    registry.providers.push(zenRegistryStub());
    saveRegistry(registry);

    expect(toggleProviderEnabled('zen')).toEqual({ toggled: true, enabled: false });
    expect(loadRegistry().providers[0]?.enabled).toBe(false);
  });

  it('removes provider and deletes non-global credentials', async () => {
    const registry = emptyRegistry();
    registry.providers.push({
      ...zenRegistryStub(),
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      authRef: 'keyring:provider:groq',
    });
    saveRegistry(registry);

    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    const result = await removeProviderFromRegistry('groq');
    expect(result.removed).toBe(true);
    expect(result.credentialDeleted).toBe(true);
    expect(loadRegistry().providers).toHaveLength(0);
    expect(deleteSpy).toHaveBeenCalledWith('keyring:provider:groq');
  });

  it('keeps global opencode credential when another provider still references it', async () => {
    const registry = emptyRegistry();
    registry.providers.push(zenRegistryStub(), {
      id: 'go',
      templateId: 'go',
      name: 'OpenCode Go',
      enabled: true,
      authRef: 'keyring:global:opencode',
      api: {},
      addedAt: new Date().toISOString(),
    });
    saveRegistry(registry);

    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    const result = await removeProviderFromRegistry('zen');
    expect(result.removed).toBe(true);
    expect(result.credentialDeleted).toBe(false);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(loadRegistry().providers).toHaveLength(1);
  });
});
