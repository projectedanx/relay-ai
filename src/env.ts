// src/env.ts
import { CONFLICTING_ENV_VARS } from './constants.js';
import { resolveContextWindow } from './context-window.js';
import type { ConflictInfo } from './types.js';

export function detectConflicts(): ConflictInfo[] {
  return CONFLICTING_ENV_VARS
    .filter(name => process.env[name] !== undefined)
    .map(name => ({ name, value: process.env[name]! }));
}

export function resolveApiKey(): string | null {
  const key = process.env['OPENCODE_API_KEY'];
  // Treat empty string as missing — happens when .zshrc auto-load line runs
  // but the Keychain entry has been deleted (security command returns nothing)
  return key?.trim() || null;
}

/** Restore first-party-like Claude Code behavior when routing through a proxy or gateway. */
export function applyClaudeCodeThirdPartyCompat(env: NodeJS.ProcessEnv): void {
  // Custom ANTHROPIC_BASE_URL disables MCP tool search by default, loading every
  // MCP tool (100+) on every turn. Requires defer_loading on tools — do not set
  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS when using the local translation proxy.
  env['ENABLE_TOOL_SEARCH'] = 'true';
  // Third-party routes may enable a shorter system prompt that drops conversational
  // guardrails while hooks/plugins still inject agentic instructions.
  env['CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT'] = '0';
}

export function buildChildEnv(
  baseUrl: string,
  model: string,
  apiKey: string,
  proxyPort?: number,
  contextWindow?: number,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CONFLICTING_ENV_VARS) {
    delete env[name];
  }
  env['ANTHROPIC_BASE_URL'] = proxyPort
    ? `http://127.0.0.1:${proxyPort}`
    : baseUrl;
  env['ANTHROPIC_API_KEY'] = apiKey;
  env['ANTHROPIC_MODEL'] = model;
  // Claude Code defaults to 200K for non-api.anthropic.com base URLs; override when we know better.
  env['CLAUDE_CODE_MAX_CONTEXT_TOKENS'] = String(resolveContextWindow(model, contextWindow));
  applyClaudeCodeThirdPartyCompat(env);
  return env;
}

export async function readFromCredentialStore(): Promise<string | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry('opencode-starter', 'opencode-starter').getPassword() ?? null;
  } catch {
    return null;
  }
}

export async function saveToCredentialStore(key: string): Promise<boolean> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    new Entry('opencode-starter', 'opencode-starter').setPassword(key);
    return true;
  } catch {
    return false;
  }
}

export async function isSecretServiceAvailable(): Promise<boolean> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    new Entry('opencode-starter-probe', 'probe').getPassword();
    return true;
  } catch {
    return false;
  }
}

