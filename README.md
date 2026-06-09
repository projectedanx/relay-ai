# relay-ai

> Relay any model into any coding agent — launch tools, switch providers, and run local API gateways.

[![npm version](https://img.shields.io/npm/v/relay-ai)](https://www.npmjs.com/package/relay-ai)
[![License](https://img.shields.io/npm/l/relay-ai)](https://github.com/jacob-bd/relay-ai/blob/main/LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jacobbd)

**relay-ai** is an interactive CLI that launches AI coding tools and runs Anthropic-compatible API gateways on your machine. Today that means **Claude Code** and **Claude Desktop (Cowork + Code)**. Tomorrow we'll add more agents.

Pick your backend:

- **OpenCode Zen / Go** — cloud models with your OpenCode API key
- **OpenCode-configured providers** — BYOK providers you've already set up in [OpenCode](https://opencode.ai) (Groq, Mistral, OpenAI, Gemini, Ollama, Cerebras, Perplexity, Bedrock, and others)
- **Google Vertex AI** — Claude on Vertex via `relay-ai server --vertex` and local gcloud credentials (no OpenCode key required)

## Commands

| Command | Description |
|---------|-------------|
| `relay-ai` | Print help (does not launch Claude Code) |
| `relay-ai claude` | Interactive wizard → launch Claude Code |
| `relay-ai models` | Manage favorite models for mid-session `/model` switching |
| `relay-ai server` | Foreground API gateway (OpenCode Zen/Go + local providers) |
| `relay-ai server --vertex` | Foreground Anthropic-compatible gateway to Claude on Vertex AI |
| `relay-ai codex` | 🔜 Planned |

Bare `relay-ai` prints help and migration guidance. Use `relay-ai claude` for the wizard.

## Features

- **Backend selector:** OpenCode Zen (free tier + subscription) or OpenCode Go (subscription)
- **Subscription-aware wizard:** You tell us what you have (free / Zen / Go / both), and we filter the model list
- **Free models highlighted:** Green `(free)` label on zero-cost Zen options
- **OpenCode provider import:** Any provider configured in OpenCode shows up automatically on the next run
- **SDK adapter proxy:** Non-Anthropic providers route through the Vercel AI SDK (same packages OpenCode uses), so Claude Code still speaks Anthropic format. Labeled `(via proxy)` in the picker
- **Favorite models:** Save up to 20 and switch mid-session with Claude Code's `/model` command
- **Smart model pickers:** Recent models per provider, search for large lists (>25), paginated browse (15 per page)
- **API server:** Run a local gateway on port **17645** for Claude Code, Claude Desktop, or any Anthropic-compatible client
- **Server wizard:** Filter exposed providers, mask discovery ids for Claude Desktop, optional favorites-only catalog, local vs network listen mode
- **Vertex gateway:** Anthropic-compatible Claude on Google Vertex AI using gcloud Application Default Credentials
- **Clean environment isolation:** We strip 17 conflicting env vars (Vertex AI, Bedrock, AWS, Foundry, stale Anthropic config) from the child process only. We never touch `~/.claude/settings.json` (see caveat below)
- **Secure key storage:** Your OpenCode API key goes in the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service) or your shell profile
- **Cross-platform:** macOS, Windows, Linux (Ubuntu, Fedora, distros with GNOME Keyring or KWallet)
- **Dry run mode:** Walk through the full wizard and preview the launch command without starting anything
- **Preference memory:** Last backend, provider, and model are pre-selected next time
- **Migration:** Automatically imports config from legacy `opencode-starter` on first run

## Supported tools

| Tool | Command | Status |
|------|---------|--------|
| Claude Code | `relay-ai claude` | ✅ Supported |
| Favorite models | `relay-ai models` | ✅ Supported |
| OpenCode API server | `relay-ai server` | ✅ Supported |
| Vertex API gateway | `relay-ai server --vertex` | ✅ Supported |
| Claude Desktop (Cowork + Code) | `relay-ai server` or `--vertex` + [setup guide](docs/CLAUDE_DESKTOP_SETUP.md) | ✅ Supported |
| Codex | `relay-ai codex` | 🔜 Planned |

## Prerequisites

- Node.js 18+
- A supported AI coding tool installed (e.g. [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code))
- An [OpenCode API key](https://opencode.ai/auth) for Zen/Go cloud backends (not required for Vertex gateway)
- [OpenCode CLI](https://opencode.ai) installed and configured if you want OpenCode-configured providers (optional)
- For **Vertex gateway:** [Google Cloud SDK](https://cloud.google.com/sdk) with `gcloud auth application-default login`, a GCP project with Vertex AI enabled, and Claude partner models enabled in that project

**A note on naming:** When we say "OpenCode-configured providers," we mean providers imported from your OpenCode config. That's not the same thing as "I downloaded Llama and I'm running it locally." Ollama can be one of those providers if you've set it up in OpenCode, but most people are pointing at cloud APIs they've configured themselves.

## Installation

```bash
# Install globally
npm install -g relay-ai

# Upgrade to the latest version
npm update -g relay-ai
```

## Setup

Grab your OpenCode API key at [opencode.ai/auth](https://opencode.ai/auth) (skip this if you only use the Vertex gateway).

On first run, relay-ai asks for the key and where to save it. Options vary by OS:

| Platform | Secure storage | Plaintext fallback |
|----------|---------------|-------------------|
| macOS | Keychain (optional: + `~/.zshrc` auto-load) | Shell profile |
| Windows | Credential Manager | `setx` user env var |
| Linux (desktop) | Secret Service (GNOME Keyring / KWallet) | Shell profile |
| Linux (headless) | n/a | Shell profile |

The key is active in your current session right away, no matter which option you pick. No terminal restart needed.

## Usage

### Launch Claude Code

```bash
relay-ai claude
```

First run: the wizard asks about your OpenCode subscription so it can show the right models. We save that and skip it next time. If you've configured providers in OpenCode, you'll also pick between cloud Zen/Go and an OpenCode-configured provider.

#### Favorite models and mid-session switching

Save the models you bounce between:

```bash
relay-ai models
```

Add up to 20 favorites from Zen, Go, or any OpenCode-configured provider. When you have favorites, `relay-ai claude` starts a multi-route proxy automatically. Claude Code's `/model` command lists your starting model plus favorites. Switch live, no restart.

No favorites? Launch works like before: single model, no switch menu. `--dry-run` ignores saved favorites so you can preview a single-model launch.

#### `relay-ai claude` options

| Flag | Description |
|------|-------------|
| `--dry-run` | Run the full wizard but preview the launch command instead of executing |
| `--setup` | Re-configure your subscription tier |
| `--trace` | Write debug logs to `/tmp/relay-ai-debug.log` and show errors on exit |
| `--help` | Show command help |
| `--version` | Show version |

```bash
relay-ai claude --dry-run
relay-ai claude --setup
relay-ai claude --trace
```

Claude Code flags and session IDs pass through unchanged:

```bash
relay-ai claude -c
relay-ai claude --resume abc-123
relay-ai claude abc-123
```

Use `--` when you want every following token passed directly to Claude Code:

```bash
relay-ai claude -- --print "hello"
relay-ai claude -- --dangerously-skip-permissions
relay-ai claude --dry-run -- --print "test"
```

## Server mode

Run relay-ai as a foreground API gateway on port **17645**. Two modes:

| Mode | Command | Auth | Models |
|------|---------|------|--------|
| **OpenCode gateway** | `relay-ai server` | OpenCode API key | Zen, Go, and OpenCode-configured providers |
| **Vertex gateway** | `relay-ai server --vertex` | gcloud Application Default Credentials | Claude on Vertex AI |

> **Claude Desktop (Cowork + Code):** Gateway setup for Desktop's Cowork and Code tabs (not Chat). See [docs/CLAUDE_DESKTOP_SETUP.md](docs/CLAUDE_DESKTOP_SETUP.md).

### OpenCode gateway (`relay-ai server`)

Requires a configured OpenCode API key and subscription tier (`relay-ai claude --setup`).

The wizard asks:

| Prompt | What it does |
|--------|--------------|
| **Configure & start** vs **Start with saved settings** | Full wizard or reuse saved server preferences |
| **Exposed providers** | Limit which providers appear in the catalog (Zen, Go, Groq, OpenAI, etc.) |
| **Mask gateway model ids for discovery?** | Recommended **Yes** for Claude Desktop — hides competitor vendor strings in model ids so discovery works |
| **Expose only favorite models?** | Optional cap at your favorites (manage with `relay-ai models`) |
| **Listen mode** | **Local only** (`127.0.0.1`) or **Network** (`0.0.0.0` + server password) |

**Local mode** — point any Anthropic-compatible client at your machine:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:17645/anthropic"
export ANTHROPIC_API_KEY="anything"
```

**Network mode** — other devices on your LAN:

```bash
export ANTHROPIC_BASE_URL="http://<server-ip>:17645/anthropic"
export ANTHROPIC_API_KEY="<server-password>"
```

By default the server password stays in memory only. If you choose to save it, relay-ai stores it in `~/.relay-ai/config.json`.

OpenAI-format models also get an OpenAI-compatible endpoint:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:17645/openai/v1"
export OPENAI_API_KEY="anything"
```

Health check:

```bash
curl -s http://127.0.0.1:17645/health
curl -s http://127.0.0.1:17645/anthropic/v1/models | head
```

The spinner reports how many models loaded and how many came from OpenCode-configured providers.

### Vertex gateway (`relay-ai server --vertex`)

Anthropic-compatible gateway to Claude on Google Vertex AI. No OpenCode API key required.

**Setup:**

```bash
gcloud auth application-default login
export ANTHROPIC_VERTEX_PROJECT_ID="your-gcp-project"   # or GOOGLE_CLOUD_PROJECT
export GOOGLE_CLOUD_LOCATION="global"                   # optional; default: global
relay-ai server --vertex
```

**Default models:** `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5`

**Shorthand aliases** (for Claude Code `/model` and `settings.json`): `sonnet`, `opus`, `haiku`. Append `[1m]` for 1M context on Sonnet and Opus only (Haiku stays 200k).

**Custom catalog:** copy `vertex-models.example.json` to `~/.relay-ai/vertex-models.json` and edit. Override the config directory with `RELAY_AI_HOME`.

When the gateway is running:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:17645/anthropic"
export ANTHROPIC_API_KEY="anything"
```

**Claude Code tip:** When routing through the gateway, unset native Vertex env vars so Claude Code doesn't bypass the proxy:

```bash
unset CLAUDE_CODE_USE_VERTEX ANTHROPIC_VERTEX_PROJECT_ID CLOUD_ML_REGION
export ENABLE_TOOL_SEARCH=true
```

Network mode works the same as the OpenCode server — the wizard asks for a server password when binding to `0.0.0.0`.

## How it works

### Subscription tiers

First run, relay-ai asks what you have access to:

| Tier | Backends available | Models shown |
|------|--------------------|--------------|
| Free only | Zen | Free Zen models only |
| Zen subscription | Zen | All Zen models (paid + free) |
| Go subscription | Zen + Go | All Go models + Zen free models |
| Both | Zen + Go | All models on both backends |

Run `relay-ai claude --setup` anytime to change your tier.

### Environment isolation

When you launch, relay-ai builds a clean child environment:

1. Removes 17 conflicting env vars from the child process (Vertex AI, Bedrock, AWS, Foundry, stale Anthropic config)
2. Sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_MODEL` for the session
3. Passes `--model <selected>` to Claude Code as a backup override

When Claude Code exits (normal exit, Ctrl+C, terminal close), your shell is unchanged. No cleanup step. No restore needed.

**Caveat: Claude Code persists the model.** relay-ai doesn't edit `~/.claude/settings.json`, but Claude Code saves the model you launched with (via `--model` and `ANTHROPIC_MODEL`). A later bare `claude` launch may still show that model, e.g. `anthropic-opencode-go__deepseek-v4-flash` from a prior relay-ai session. To get back to a first-party default, run `claude --model sonnet` (or your preferred Claude model), or remove the `"model"` key from `~/.claude/settings.json`. If you used the favorites switch menu, Claude Code may also cache the gateway catalog at `~/.claude/cache/gateway-models.json`. Delete that file if `/model` shows stale entries from a dead proxy.

### Model compatibility

OpenCode exposes models through different API formats. relay-ai handles them when it can:

| Model format | Examples | How it works | Label |
|---|---|---|---|
| Anthropic native | Claude, Qwen, MiniMax (Go) | Direct connection | *(none)* |
| OpenAI chat completions | DeepSeek, Kimi, MiMo, GLM, Grok, GPT-4o (OpenCode OpenAI provider) | SDK adapter proxy (Vercel AI SDK) | `via proxy` |
| OpenAI Responses API | GPT-5.4+, GPT-5.5, Codex, o-series (OpenCode OpenAI provider only) | Same proxy; SDK picks Responses API | `via proxy` |
| Gemini native | Gemini (OpenCode Google provider) | SDK adapter, Gemini native API | `via proxy` |
| Other SDK providers | Cerebras, Perplexity, Bedrock, Vertex, Together AI, etc. | Whatever `api.npm` OpenCode assigns | `via proxy` |
| Not in cloud wizard | GPT, Gemini on OpenCode Zen/Go | Use an OpenCode-configured provider instead (OpenAI/Google in OpenCode config) | `not yet supported` |

The SDK adapter proxy starts on a random local port for proxy-routed models and stops when Claude Code exits. Each `relay-ai claude` session gets its own port, so multiple terminals are fine. (`relay-ai server` uses fixed port `17645`. One server instance per machine.)

### Provider notes

**Mistral (free tier):** Rate limits are tight. Expect HTTP 429 during tool-heavy sessions. Claude Code retries with backoff. That's Mistral throttling, not a proxy bug.

**OpenAI (OpenCode-configured provider):** Configure OpenAI in [OpenCode](https://opencode.ai) with your API key, then pick the OpenAI provider at launch. Newer GPT models use OpenAI's Responses API. The SDK picks `responses` vs `chat` from the model ID. OpenCode catalog IDs can differ from API IDs (e.g. `gpt-5.5-fast` maps to upstream `gpt-5.5`). If you see "model not available", run `relay-ai claude --trace` and check `/tmp/relay-ai-debug.log`.

`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` is set for direct (non-proxy) routes only. Proxy sessions keep tool-search betas.

### API key storage

relay-ai uses [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring) for the OS credential store. On later runs it checks silently. Key found? Wizard skips the prompt.

| Platform | Credential store | Notes |
|----------|-----------------|-------|
| macOS | macOS Keychain | Optional `~/.zshrc` auto-load line for system-wide availability |
| Windows | Windows Credential Manager | `setx` available as plaintext alternative |
| Linux (desktop) | Secret Service API (GNOME Keyring, KWallet) | Needs a running keyring daemon |
| Linux (headless) | Not available | Falls back to shell profile or session-only |

If the native module fails to load, credential store options are skipped and you get shell profile / session-only storage.

## Configuration

Preferences, favorites, subscription tier, server settings, and optional server password:

```text
~/.relay-ai/config.json
```

Vertex model catalog override:

```text
~/.relay-ai/vertex-models.json    # see vertex-models.example.json
```

Override the config directory:

```bash
export RELAY_AI_HOME="/path/to/your/relay-ai-home"
```

The OpenCode API key is stored separately, based on what you chose during setup (Keychain, credential store, or shell profile).

## Upgrading from opencode-starter

If you used the old **opencode-starter** CLI, relay-ai migrates automatically on first run:

- Config moves from `~/.opencode-starter/` → `~/.relay-ai/`
- Legacy Keychain / credential-store entries are read and re-saved under `relay-ai`
- The CLI command is now `relay-ai` (not `opencode-starter`)
- Launch Claude Code with `relay-ai claude` (bare `relay-ai` prints help)

The deprecated `OPENCODE_STARTER_HOME` env var still works as a fallback for `RELAY_AI_HOME`.

## Contributing

Private beta right now. Issues and PRs welcome on GitHub.

## Disclaimer

This project and its creator have **no affiliation** with OpenCode, Anthropic, Claude, Google, or any other vendor named or integrated here. Trademarks belong to their respective owners.

relay-ai was built for **education and research**, and mostly for fun. It routes inference through services you configure yourself (OpenCode Zen/Go, OpenCode-configured providers, Vertex AI, and gateways you run locally). Use at your own risk.

## Vibe Coding Alert

Full transparency: this project was vibe coded with AI coding assistants. If you're an experienced developer, you might look at parts of this codebase and wince. That's okay.

The goal was to scratch an itch: launch Claude Code and Claude Desktop (Cowork + Code) against OpenCode backends and Vertex without fighting env vars, proxies, and model discovery. The code works. It's not corporate polish.

If something makes you cringe, open an issue or PR. Human expertise is irreplaceable. For the tone and spirit of this section, see [notebooklm-mcp-cli](https://github.com/jacob-bd/notebooklm-mcp-cli) on the same GitHub org.

## License

MIT
