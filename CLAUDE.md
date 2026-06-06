# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build       # compile TypeScript → dist/cli.js (via tsup, ESM, shebang injected)
npm test            # run all tests with vitest
npm run typecheck   # type-check without emitting (tsc --noEmit)
npm run dev         # watch mode build

# Run a single test file
npx vitest run tests/env.test.ts
npx vitest run tests/models.test.ts

# Test the CLI locally (already npm-linked)
opencode-starter --help
opencode-starter --dry-run       # simulate full first-run without writing anything
opencode-starter --setup         # re-ask subscription tier
opencode-starter --trace         # write Claude Code debug log to /tmp and print errors on exit

# Rebuild after code changes before testing manually
npm run build && opencode-starter --version
```

## Architecture

**Entry point:** `src/cli.ts` orchestrates the full flow. Every other module is a focused unit with no side effects at import time.

**Data flow (`opencode-starter claude`):**
```
cli.ts
  → findClaudeBinary()         [launch.ts — locate claude binary]
  → fetchLocalProviders()      [providers.ts — ephemeral opencode serve, GET /config/providers, normalize]
  → p.select "Which provider?" [shown when local providers are available]

  ── OpenCode cloud path (default) ──
  → resolveOrCollectApiKey()   [reads env, OS credential store (all platforms), or prompts user]
  → askSubscriptionTier()      [prompts.ts — one-time question, saved to conf store]
  → getModels()                [models.ts — API fetch + cache enrichment + format classification]
  → runWizard()                [prompts.ts — backend/model selector, filters unsupported]

  ── Local provider path ──
  → pickLocalModel()           [prompts.ts — filter/select model from local provider]

  ── Shared launch ──
  → startProxy()               [proxy.ts — only for OpenAI-format models; takes full completionsUrl]
  → buildChildEnv(baseUrl, …)  [env.ts — removes 17 conflicting vars, sets 3 OpenCode vars]
  → launchClaude()             [launch.ts — spawn with stdio:inherit]
  → proxyHandle.close()        [stops proxy after Claude exits]
```

**Critical URL constraint:** `BACKENDS.baseUrl` in `constants.ts` must NOT include `/v1`. The Anthropic SDK appends `/v1/messages` automatically. Setting it to `https://opencode.ai/zen/v1` would cause requests to hit `/zen/v1/v1/messages` → 404.

**Model discovery two-source merge:**
- Primary: `GET {backendUrl}/v1/models` (no auth needed, returns available IDs)
- Enrichment: `~/.cache/opencode/models.json` (written by OpenCode CLI) — provides `name`, `family`, `cost`, `provider.npm`
- `isAnthropicNative`: true when `modelFormat === 'anthropic'`
- `modelFormat`: classified from `provider.npm` in cache, or by ID-prefix heuristic:
  - `@ai-sdk/anthropic` or `claude-*` → `'anthropic'` (direct passthrough)
  - `@ai-sdk/openai` or `gpt-*` → `'unsupported'` (needs Responses API)
  - `@ai-sdk/google` or `gemini-*` → `'unsupported'` (needs model-specific endpoints)
  - Everything else → `'openai'` (routed through local translation proxy)
- `sourceBackend`: set from the backend that was queried — critical for `go` tier which shows Zen free models + Go paid models in one list, so the correct `ANTHROPIC_BASE_URL` can be set per selected model

**Translation proxy** (`src/proxy.ts`): For models using OpenAI `/chat/completions` format, a local HTTP proxy starts on `127.0.0.1:<random-port>`. It accepts Anthropic-format requests at `/v1/messages`, translates to OpenAI format, and forwards to the full `completionsUrl` passed by the caller (e.g. `${backend.baseUrl}/v1/chat/completions` for Zen/Go, or a provider-specific URL for local providers). Translates responses back. Handles streaming SSE, tool calls, thinking/reasoning blocks, images, and prompt caching. Zero external dependencies — uses Node.js built-in `http` + `fetch`. The proxy starts before Claude Code and stops after it exits. Adapted from [cucoleadan/opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy) (MIT).

**Subscription tiers** control which models are shown and whether a backend selector appears:
- `free` / `zen`: always Zen backend, no backend selector
- `go`: Go backend, but also fetches Zen for free models — combined list, backend inferred from `sourceBackend` of selected model
- `both`: shows backend selector

**Env isolation:** `buildChildEnv()` copies `process.env`, deletes all 17 vars in `CONFLICTING_ENV_VARS`, then sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. Also always sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (OpenCode proxy doesn't support all Anthropic beta headers). The parent process env is never mutated.

**Preferences** (via `conf` package at `~/.config/opencode-starter/config.json`): `lastBackend`, `lastModel`, `lastProvider`, `subscriptionTier`, and a 1-hour model list cache. All writes are skipped when `dryRun === true`.

**API key storage** uses `@napi-rs/keyring` (installed as `optionalDependencies`) for cross-platform credential store access. The module is loaded via dynamic `import()` so a missing native binary degrades gracefully. `tsup.config.ts` marks it as `external` so esbuild doesn't try to bundle the native `.node` addon.

On startup, `resolveOrCollectApiKey()` silently calls `readFromCredentialStore()` — if a key is found the prompt is skipped entirely.

Save options per platform:
- **macOS** (4 options): Keychain only | Keychain + `~/.zshrc` auto-load | shell profile (plaintext) | session only
  - The `~/.zshrc` auto-load line uses the `security` CLI directly (so the shell can source it): `export OPENCODE_API_KEY="$(security find-generic-password -s opencode-starter -a opencode-starter -w 2>/dev/null)"`
- **Windows** (3 options): Windows Credential Manager | `setx` user env var (plaintext) | session only
  - `setx` is called with `stdio: ['pipe','pipe','pipe']` to suppress its "SUCCESS" stdout
- **Linux desktop** (3 options): Secret Service (GNOME Keyring / KWallet) | shell profile (plaintext) | session only
  - Secret Service availability is probed via a test `getPassword()` call — returns false if the daemon isn't running
- **Linux headless** (2 options): shell profile | session only — shown with a `p.log.info` note explaining why secure storage is unavailable

In all cases `process.env['OPENCODE_API_KEY']` is set immediately so the key is active for the current session regardless of save choice.

**Local provider discovery** (`src/providers.ts`): `fetchLocalProviders()` spawns `opencode serve --port 0`, waits for the listening URL in stdout/stderr (10s timeout, spinner shown in CLI), fetches `GET /config/providers`, then kills the process. `normalizeProviders()` (called internally) skips OAuth providers (empty key), skips `opencode`/`opencode-go` (cloud backends handled separately), and classifies each model's format and upstream URL from its `api.npm` package. Known first-party packages (`@ai-sdk/anthropic|openai|google|groq|mistral|xai`) have hardcoded URLs; `@ai-sdk/openai-compatible` providers use the `api.url` from the config. Models with unknown packages are dropped. Google/Gemini is routed via `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` (Google's OpenAI-compatible endpoint). Cost display in Claude Code is inaccurate for non-Anthropic models (Claude Code applies its own pricing table); documented limitation.

**Local provider routing:** Two paths depending on `model.modelFormat`:
- `'anthropic'`: `buildChildEnv(model.baseUrl, model.id, provider.apiKey)` — no proxy, Claude Code talks directly to the provider's Anthropic-compatible endpoint. The `baseUrl` must NOT include `/v1` (the Anthropic SDK appends it).
- `'openai'`: `startProxy(model.completionsUrl, model.id, trace)` — proxy started on a random local port; `buildChildEnv('http://127.0.0.1', model.id, provider.apiKey, proxyPort)`. The `completionsUrl` is the full endpoint including path (e.g. `https://api.groq.com/openai/v1/chat/completions`).

**Providers that need a non-empty API key:** `normalizeProviders` skips any provider with an empty `key` field (to filter OAuth-only providers like OpenAI/xAI configured via browser login). Local providers that don't validate keys (e.g. Ollama) must still have a non-empty placeholder key set in OpenCode (e.g. `"ollama"`).

**Server command local providers** (`src/server/index.ts`): After loading Zen/Go models, `loadServerModels()` also calls `fetchLocalProviders()` and appends each `LocalProviderModel` as a `ServerModelInfo` with `baseUrl`/`completionsUrl`/`apiKey` routing fields set. The router (`src/server/router.ts`) prefers these per-model fields when present. The `GET /models` endpoint strips `apiKey` from the serialized output to prevent key exposure. Spinner message shows `"N models (M from local providers)"`.

**Proxy translation fixes (v0.3.0):**
- `prompt_cache_key` removed from `translateRequest` output — it's a non-standard field rejected by Google, Groq, Mistral, and most providers.
- `thought_signature` round-trip: Google's Gemini thinking models attach a `thought_signature` to tool calls that must be echoed back in subsequent requests. The proxy encodes it into the Anthropic `tool_use.id` as `{id}::ts::{signature}` so Claude Code preserves it, then decodes it in `translateRequest` to re-inject onto the outgoing `tool_calls` entry. The `tool_call_id` in tool results is also stripped of the suffix. This is invisible to Claude Code.
- Server `handleAnthropicMessages` now supports streaming for openai-format models (checks `body.stream`, pipes through `translateStream` when true).
- Shell injection in API key save paths hardened: macOS profile uses POSIX single-quote escaping; Windows `setx` uses `spawnSync` with argument array.

**Stale free models:** `STALE_FREE_MODELS` in `constants.ts` contains models whose free promotion ended but the API still returns them. Currently only `qwen3.6-plus-free`. These are filtered out in `mergeModels()`.

**Tests** cover pure functions only: `env.ts` (all 3 functions), `models.ts` (`deriveBrand`, `classifyModelFormat`, `mergeModels`, `groupModels`), `proxy.ts` (`translateRequest`, `translateResponse`, token extraction), and `providers.ts` (`resolveEndpoint`, `normalizeProviders`). Interactive modules (`prompts.ts`, `launch.ts`) and `config.ts` are verified manually.

## Key constraints

- `settings.json` is never touched. All Claude Code configuration is env-var-only, passed to the child process. This avoids the backup/restore problem that `ollama launch claude` has.
- `--dry-run` ignores all saved state (env key, Keychain, tier, preferences) and skips all writes. Used to simulate a fresh first-run experience.
- When adding a new backend, update `BACKENDS` in `constants.ts`, the `BackendConfig` id union in `types.ts`, and the subscription tier logic in `prompts.ts` and `cli.ts`.
- `buildChildEnv(baseUrl: string, model, apiKey, proxyPort?)` — takes a plain string URL, not a `BackendConfig`. When `proxyPort` is set, `ANTHROPIC_BASE_URL` is always `http://127.0.0.1:{proxyPort}` regardless of `baseUrl`.
- `startProxy(completionsUrl: string, modelId, debug)` — takes the full chat completions URL including path. Callers must append `/v1/chat/completions` themselves (e.g. `${backend.baseUrl}/v1/chat/completions` for Zen/Go).

## In-progress work (branch: feature/local-providers)

**Status:** Implementation complete. Version bumped to 0.3.0 and installed globally for manual testing.

**What was tested:**
- Gemini 2.5 Flash via Google's OpenAI-compatible endpoint — text responses work, tool calls work (after `thought_signature` fix).
- The `prompt_cache_key` field was causing Google 400 errors and has been removed.

**Pending before merge:**
- Broader manual testing of other local providers (Groq, Mistral, xAI, Anthropic-direct, Ollama via `@ai-sdk/openai-compatible`).
- Ollama note: must set a non-empty placeholder key in OpenCode config (Ollama ignores the auth header).
- PR creation and review.

**Known limitations (by design):**
- Cost display in Claude Code is always inaccurate for non-Anthropic models.
- OAuth-authenticated providers (no stored key) are silently skipped.
- Providers with custom auth mechanisms (e.g. Azure OpenAI with deployment URLs) are not supported.
- The `thought_signature` encoding (`::ts::` separator in tool_use ids) is a workaround; if Google ever changes the signature format to include `::ts::` literally, it would break. Unlikely but worth knowing.
