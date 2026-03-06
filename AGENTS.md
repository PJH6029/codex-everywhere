# codex-everywhere

## Project Overview

- `codex-everywhere` is a Node.js CLI that runs Codex inside `tmux`, sends Codex events to Discord, and injects Discord replies back into managed Codex sessions.
- The primary user flow is: bootstrap setup, configure Discord, start the daemon, then create sessions from the Discord control channel with `!ce-new`.
- This repo is a single-package ESM CLI. There is no monorepo workspace.

## Important Entry Points

- `bin/codex-everywhere.js`: installed CLI entrypoint.
- `src/cli.js`: top-level command router and session orchestration.
- `src/run-codex.js`: launches Codex in a managed `tmux` pane/session.
- `src/reply-daemon.js`: long-running Discord polling, approvals bridge, and per-channel session provisioning.
- `src/setup-bootstrap.js`: guided one-command bootstrap flow.
- `src/setup-discord.js`: writes Discord/reply/provisioning config.
- `src/config.js`: merges `~/.codex-everywhere/config.json` with supported environment overrides.
- `src/discord.js` and `src/tmux.js`: low-level Discord REST and `tmux` helpers.

## Prerequisites

- Node.js `>=20`
- `npm`
- `tmux`
- Codex CLI installed globally: `npm i -g @openai/codex`
- Playwright CLI installed globally: `npm i -g @playwright/cli@latest`
- `npx` available on `PATH`
- A Discord bot token and permission to invite/manage the bot in the target guild

## Recommended Setup Flow

1. Install the package locally:
   - `npm link`
2. Run guided bootstrap:
   - `codex-everywhere setup bootstrap`
3. During guided setup, complete any Discord login, CAPTCHA, or re-auth steps in the browser when prompted.
4. After setup completes, restart the daemon if needed:
   - `codex-everywhere daemon restart`
5. In the Discord control channel, send:
   - `!ce-new`

Bootstrap defaults and behavior:

- Default setup model: `gpt-5.4`
- Fallback setup model: `gpt-5.3-codex` if `gpt-5.4` is unavailable
- Default reasoning effort: `xhigh`
- Marks this repo as trusted in `~/.codex/config.toml`
- Installs the local setup skill at `./.agents/skills/setup-discord/SKILL.md` if missing
- Verifies `codex`, `tmux`, and `npx`, and can bootstrap the Playwright skill through Codex if needed

Useful bootstrap flags:

- `codex-everywhere setup bootstrap --no-install`
- `codex-everywhere setup bootstrap --no-launch`
- `codex-everywhere setup bootstrap --model <name>`
- `codex-everywhere setup bootstrap --reasoning-effort <level>`
- `codex-everywhere setup bootstrap --unsafe`

## Manual Discord Setup

Use this when the user wants to skip guided bootstrap:

```bash
codex-everywhere setup discord \
  --bot-token "$BOT" \
  --guild-name "codex-everywhere-server" \
  --authorized-user-id auto
```

Then start or restart the daemon:

```bash
codex-everywhere daemon restart
```

Defaults and expectations:

- Default guild name: `codex-everywhere-server`
- Default control channel name auto-detection: `일반` or `general`
- `--authorized-user-id auto` resolves from the latest non-bot message in the control channel
- If auto-discovery fails, send one normal user message in the control channel and rerun setup

## Runtime Files And State

- Main config: `~/.codex-everywhere/config.json`
- Runtime state: `~/.codex-everywhere/state/*`
- Runtime logs: `~/.codex-everywhere/logs/<project-slug>/*`
- Codex global trust config: `~/.codex/config.toml`
- Local setup skill source in this repo: `./.agents/skills/setup-discord/SKILL.md`

Important note:

- `setup discord` stores the Discord bot token and channel/guild/user configuration in `~/.codex-everywhere/config.json`. Treat that file as sensitive and never commit copied secrets into the repository.

## Development Workflow

- Install locally with `npm link`
- Run syntax checks with `npm run check`
- Quick CLI sanity checks:
  - `codex-everywhere --help`
  - `codex-everywhere setup discord --help`
- There is currently no broader automated test suite in this repo; validate behavior with targeted CLI checks and careful code review.

When changing behavior, prefer keeping these docs in sync:

- `README.md` for user-facing setup and command reference
- `AGENTS.md` for future agent/project guidance
- `.agents/skills/setup-discord/SKILL.md` when Discord bootstrap workflow changes

## Project-Specific Guidance For Agents

- Prefer `rg` for searches and keep changes focused on the CLI and setup flow that the user asked about.
- Check `README.md` and the relevant `src/*.js` file before changing setup instructions or defaults.
- Do not modify runtime files under `~/.codex-everywhere/*` unless the user explicitly asks for local environment setup.
- Do not commit or expose Discord bot tokens, channel ids, or copied local config values from `~/.codex-everywhere/config.json` or `.env`.
- If the user asks to bootstrap Discord app/bot/server setup for this repo, use the local `setup-discord` skill below.

## Local Skills

- `setup-discord` (file: `.agents/skills/setup-discord/SKILL.md`)
  - Use when the user asks to bootstrap Discord app/bot/server setup for `codex-everywhere` with minimal manual configuration.
  - Skill activation keyword: `$setup-discord`
  - Prefer the CLI one-shot command:
    - `codex-everywhere setup discord --bot-token "<TOKEN>" --guild-name "codex-everywhere-server" --authorized-user-id auto`
