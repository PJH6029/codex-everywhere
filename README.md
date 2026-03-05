# codex-everywhere

Run Codex in tmux, bridge notifications/replies through Discord, and manage multi-session channels from the CLI.

## Quickstart

Install Playwright MCP Bridge first (required for browser automation in setup):
- https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm

```bash
git clone https://github.com/PJH6029/codex-everywhere.git
cd codex-everywhere
npm link
codex-everywhere setup bootstrap
```

During guided setup, complete any requested Discord login/CAPTCHA/re-auth steps.

After setup completes, type `!ce-new` in your control channel.

## What It Does

- Runs Codex in tmux.
- Sends Codex events to Discord (session start/end, turn complete, prompts).
- Accepts Discord replies and injects them into Codex.
- Bridges Codex approval prompts to Discord (`y`, `p`, `n` flow).
- Manages one tmux/Codex session per provisioned Discord channel.

## Detailed Setup

### Prerequisites

- Node.js 20+
- `tmux`
- Codex CLI (`npm i -g @openai/codex`)
- Chrome/Edge/Chromium with Playwright MCP Bridge extension installed
- Discord bot token and permissions in your server

### Bootstrap Flow (`setup bootstrap`)

`codex-everywhere setup bootstrap` (alias: `setup auto`) does the following:

1. Verifies `codex` and `tmux` (auto-installs if missing unless disabled).
2. Writes project `.codex/config.toml` with Playwright MCP extension config and browser tool approvals.
3. Marks this project as trusted in `~/.codex/config.toml`.
4. Installs local setup skill at `./.agents/skills/setup-discord/SKILL.md` if missing.
5. Launches Codex with guided setup prompt and default reasoning effort `xhigh`.

Required manual actions still include:
- Playwright extension install / first connection approval
- `/permissions` approval in Codex
- Discord CAPTCHA / re-auth flows

### Manual Discord Setup (`setup discord`)

If you want to skip guided bootstrap:

```bash
codex-everywhere setup discord \
  --bot-token "$BOT" \
  --guild-name "codex-everywhere-server" \
  --authorized-user-id auto
```

Then start daemon and validate:

```bash
codex-everywhere daemon restart
```

In Discord control channel:

```text
!ce-new
```

## Command Reference

### Main

```bash
codex-everywhere [codex args...]
```

Pass-through args are forwarded to Codex launch.

### `setup bootstrap` options

```bash
codex-everywhere setup bootstrap [options]
```

- `--no-install`: do not auto-install missing prerequisites.
- `--no-launch`: prepare only; do not launch Codex.
- `--model <name>` or `-m <name>`: model override for guided session.
- `--reasoning-effort <level>` or `--effort <level>`: override bootstrap effort (default `xhigh`).
- `--unsafe`: launch Codex with `--dangerously-bypass-approvals-and-sandbox`.

### `setup discord` options

```bash
codex-everywhere setup discord --bot-token <token> [--control-channel-id <id> | --guild-name <name>] [options]
```

Core options:
- `--control-channel-id <id>`
- `--guild-id <id>`
- `--guild-name <name>` (default `codex-everywhere-server`)
- `--control-channel-name <name>` (auto default: `일반` / `general`)
- `--authorized-user-id <id|auto>` (default `auto`)
- `--authorized-user-ids <id,id,...>`
- `--mention-user-id <id>`
- `--provision-enabled <true|false>` (default `true`)
- `--provision-prefix <prefix>` (default `codex-`)
- `--provision-category-id <id>`
- `--poll-interval-ms <int>` (default `3000`)
- `--rate-limit-per-minute <int>` (default `10`)
- `--max-message-length <int>` (default `500`)
- `--max-managed-channels <int>` (default `40`)
- `--config-path <path>` (default `~/.codex-everywhere/config.json`)
- `--skip-test-message`

Use `codex-everywhere setup discord --help` for current examples.

### Daemon commands

```bash
codex-everywhere daemon start [--debug|--no-debug]
codex-everywhere daemon restart [--debug|--no-debug]
codex-everywhere daemon stop
codex-everywhere daemon status
```

### Session commands

```bash
codex-everywhere sessions list [--all]
codex-everywhere sessions attach [selector] [--pane] [--lines <n>] [--all]
codex-everywhere sessions terminate [selector] [--all] [--wait <sec>] [--force]
```

## Architecture

High-level flow:

```text
Discord <-> reply-daemon.js <-> tmux pane <-> run-codex.js <-> Codex
                               \-> notify-hook.js / notify.js
```

Key modules:
- `src/cli.js`: command router and top-level orchestration.
- `src/run-codex.js`: launches Codex process in managed session.
- `src/reply-daemon.js`: reply polling, approval bridge, channel provisioning.
- `src/discord.js`: Discord REST helpers.
- `src/tmux.js`: tmux session/pane operations.
- `src/setup-bootstrap.js`: one-command bootstrap preparation and guided launch.
- `src/setup-discord.js`: writes Discord/reply/provision config.
- `src/config.js`: merges env vars + config file.
- `src/active-sessions.js`: managed session registry.

## Files and State

- Project files written by bootstrap:
  - `./.codex/config.toml`
  - `./.agents/skills/setup-discord/SKILL.md` (if missing)
- Global Codex trust:
  - `~/.codex/config.toml`
- codex-everywhere runtime/config:
  - `~/.codex-everywhere/config.json`
  - `~/.codex-everywhere/state/*`
  - `~/.codex-everywhere/logs/*`

## Troubleshooting

- `guild not found for --guild-name ...`:
  - Create/select the guild first, or pass `--control-channel-id` / `--guild-id`.
- `failed to discover authorized user id automatically`:
  - Send one normal message in control channel, then rerun setup.
- Discord messages look empty:
  - Enable **Message Content Intent** in Discord bot settings.
- Channel deletion fails with permission error:
  - Grant bot `Manage Channels` permission.
- Browser automation cannot connect:
  - Confirm Playwright MCP Bridge extension is installed in the browser profile you are using.

## Development

```bash
npm run check
```
