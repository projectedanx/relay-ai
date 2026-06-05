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
  → resolveOrCollectApiKey()   [reads env, macOS Keychain, or prompts user]
  → askSubscriptionTier()      [prompts.ts — one-time question, saved to conf store]
  → getModels()                [models.ts — API fetch + cache enrichment]
  → runWizard()                [prompts.ts — backend/model selector]
  → buildChildEnv()            [env.ts — removes 17 conflicting vars, sets 3 OpenCode vars]
  → launchClaude()             [launch.ts — spawn with stdio:inherit]
```

**Critical URL constraint:** `BACKENDS.baseUrl` in `constants.ts` must NOT include `/v1`. The Anthropic SDK appends `/v1/messages` automatically. Setting it to `https://opencode.ai/zen/v1` would cause requests to hit `/zen/v1/v1/messages` → 404.

**Model discovery two-source merge:**
- Primary: `GET {backendUrl}/v1/models` (no auth needed, returns available IDs)
- Enrichment: `~/.cache/opencode/models.json` (written by OpenCode CLI) — provides `name`, `family`, `cost`, `provider.npm`
- `isAnthropicNative`: true when `provider.npm === '@ai-sdk/anthropic'` in cache
- `sourceBackend`: set from the backend that was queried — critical for `go` tier which shows Zen free models + Go paid models in one list, so the correct `ANTHROPIC_BASE_URL` can be set per selected model

**Subscription tiers** control which models are shown and whether a backend selector appears:
- `free` / `zen`: always Zen backend, no backend selector
- `go`: Go backend, but also fetches Zen for free models — combined list, backend inferred from `sourceBackend` of selected model
- `both`: shows backend selector

**Env isolation:** `buildChildEnv()` copies `process.env`, deletes all 17 vars in `CONFLICTING_ENV_VARS`, then sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. Also always sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (OpenCode proxy doesn't support all Anthropic beta headers). The parent process env is never mutated.

**Preferences** (via `conf` package at `~/.config/opencode-starter/config.json`): `lastBackend`, `lastModel`, `subscriptionTier`, and a 1-hour model list cache. All writes are skipped when `dryRun === true`.

**API key storage options** (macOS):
1. Keychain + `~/.zshrc` auto-load — `security add-generic-password -s opencode-starter -a opencode-starter -w <key>`; `~/.zshrc` line reads from Keychain at shell start. If Keychain entry is deleted, env var becomes `""` which `resolveApiKey()` treats as null.
2. Shell profile (plaintext export)
3. Session only

**Tests** cover pure functions only: `env.ts` (all 3 functions) and `models.ts` (`deriveBrand`, `mergeModels`, `groupModels`). Interactive modules (`prompts.ts`, `launch.ts`) and `config.ts` are verified manually.

## Key constraints

- `settings.json` is never touched. All Claude Code configuration is env-var-only, passed to the child process. This avoids the backup/restore problem that `ollama launch claude` has.
- `--dry-run` ignores all saved state (env key, Keychain, tier, preferences) and skips all writes. Used to simulate a fresh first-run experience.
- When adding a new backend, update `BACKENDS` in `constants.ts`, the `BackendConfig` id union in `types.ts`, and the subscription tier logic in `prompts.ts` and `cli.ts`.
