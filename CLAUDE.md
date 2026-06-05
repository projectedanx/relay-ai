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

**Data flow:**
```
cli.ts
  → resolveOrCollectApiKey()   [reads env, OS credential store (all platforms), or prompts user]
  → askSubscriptionTier()      [prompts.ts — one-time question, saved to conf store]
  → getModels()                [models.ts — API fetch + cache enrichment + format classification]
  → runWizard()                [prompts.ts — backend/model selector, filters unsupported]
  → startProxy()               [proxy.ts — only for OpenAI-format models, translates Anthropic↔OpenAI]
  → buildChildEnv()            [env.ts — removes 17 conflicting vars, sets 3 OpenCode vars]
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

**Translation proxy** (`src/proxy.ts`): For models using OpenAI `/chat/completions` format, a local HTTP proxy starts on `127.0.0.1:<random-port>`. It accepts Anthropic-format requests at `/v1/messages`, translates to OpenAI format, forwards to `{backendUrl}/v1/chat/completions`, and translates responses back. Handles streaming SSE, tool calls, thinking/reasoning blocks, images, and prompt caching. Zero external dependencies — uses Node.js built-in `http` + `fetch`. The proxy starts before Claude Code and stops after it exits. Adapted from [cucoleadan/opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy) (MIT).

**Subscription tiers** control which models are shown and whether a backend selector appears:
- `free` / `zen`: always Zen backend, no backend selector
- `go`: Go backend, but also fetches Zen for free models — combined list, backend inferred from `sourceBackend` of selected model
- `both`: shows backend selector

**Env isolation:** `buildChildEnv()` copies `process.env`, deletes all 17 vars in `CONFLICTING_ENV_VARS`, then sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. Also always sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (OpenCode proxy doesn't support all Anthropic beta headers). The parent process env is never mutated.

**Preferences** (via `conf` package at `~/.config/opencode-starter/config.json`): `lastBackend`, `lastModel`, `subscriptionTier`, and a 1-hour model list cache. All writes are skipped when `dryRun === true`.

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

**Stale free models:** `STALE_FREE_MODELS` in `constants.ts` contains models whose free promotion ended but the API still returns them. Currently only `qwen3.6-plus-free`. These are filtered out in `mergeModels()`.

**Tests** cover pure functions only: `env.ts` (all 3 functions), `models.ts` (`deriveBrand`, `classifyModelFormat`, `mergeModels`, `groupModels`), and `proxy.ts` (`translateRequest`, `translateResponse`, token extraction). Interactive modules (`prompts.ts`, `launch.ts`) and `config.ts` are verified manually.

## Key constraints

- `settings.json` is never touched. All Claude Code configuration is env-var-only, passed to the child process. This avoids the backup/restore problem that `ollama launch claude` has.
- `--dry-run` ignores all saved state (env key, Keychain, tier, preferences) and skips all writes. Used to simulate a fresh first-run experience.
- When adding a new backend, update `BACKENDS` in `constants.ts`, the `BackendConfig` id union in `types.ts`, and the subscription tier logic in `prompts.ts` and `cli.ts`.
