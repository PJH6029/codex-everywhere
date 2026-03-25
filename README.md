# codex-everywhere

Run Codex in tmux, bridge notifications/replies through Discord, and manage multi-session channels from the CLI.

## Quickstart

Bootstrap will install the Playwright skill through Codex on first run if it is missing.
Bootstrap uses `gpt-5.4` by default and falls back to `gpt-5.3-codex` only if `gpt-5.4` is unavailable.
Make sure `npx` is available before running guided setup.

```bash
git clone https://github.com/PJH6029/codex-everywhere.git
cd codex-everywhere
npm link
codex-everywhere setup bootstrap
```

During guided setup, complete any requested Discord login/CAPTCHA/re-auth steps in the browser. The guided agent should continue automatically after the page reaches the expected post-auth state; no separate "I've done" message should be needed.

After setup completes, type `/ce new` in your control channel. Legacy `!ce-new` still works. Inside a session channel, use `/ce plan` or `!ce-plan` to switch Codex into Plan mode.

## What It Does

- Runs Codex in tmux.
- Sends Codex events to Discord (session start/end, progress updates, turn complete, prompts).
- Registers a native `/ce` slash command and handles it through the Discord Gateway while the daemon is running.
- Accepts Discord replies and injects them into Codex.
- Bridges Codex approval prompts to Discord (`y`, `p`, `n` flow).
- Bridges Codex Plan mode proposals to Discord (`1` implement, `2` stay in Plan mode).
- Manages one tmux/Codex session per provisioned Discord channel.

## Detailed Setup

### Prerequisites

- Node.js 20+
- `tmux`
- Codex CLI (`npm i -g @openai/codex`)
- Playwright CLI (`npm i -g @playwright/cli@latest`)
- `npx` available for the Playwright skill wrapper
- Discord bot token and permissions in your server

### Bootstrap Flow (`setup bootstrap`)

`codex-everywhere setup bootstrap` (alias: `setup auto`) does the following:

1. Verifies `codex` and `tmux` (auto-installs if missing unless disabled).
2. Verifies `npx` and, if needed, launches `codex exec` to run `$skill-installer playwright`.
3. Marks this project as trusted in `~/.codex/config.toml`.
4. Installs local setup skill at `./.agents/skills/setup-discord/SKILL.md` if missing.
5. Launches Codex with guided setup prompt, default model `gpt-5.4` (fallback `gpt-5.3-codex`), and default reasoning effort `xhigh`.

Required manual actions still include:
- `/permissions` approval in Codex
- Discord login / CAPTCHA / re-auth flows in the browser (the guided agent should resume automatically after the page clears the auth gate)

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
/ce new
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

- `--no-install`: do not auto-install missing prerequisites or the Playwright skill.
- `--no-launch`: prepare only; do not launch Codex.
- `--model <name>` or `-m <name>`: override the default bootstrap model selection.
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

### Discord commands

- Control channel:
  - `/ce new`
  - `/ce help`
  - Legacy aliases: `!ce-new`, `!ce-help`
- Session channels:
  - `/ce help`
  - `/ce meta`
  - `/ce plan`
  - `/ce perm`
  - `/ce exit`
  - Legacy aliases: `!ce-help`, `!ce-meta`, `!ce-plan`, `!ce-perm`, `!ce-exit`
- Plan mode flow:
  - Use `/ce plan` or `!ce-plan`, then send your planning request as the next message.
  - When Codex proposes a plan, reply `1` to implement it or `2` to stay in Plan mode.

## Architecture

High-level flow:

```text
Discord <-> reply-daemon.js <-> tmux pane <-> run-codex.js <-> Codex
                               \-> notify-hook.js / notify.js
                               \-> codex-session-commentary.js / notify.js
```

Key modules:
- `src/cli.js`: command router and top-level orchestration.
- `src/run-codex.js`: launches Codex process in managed session.
- `src/codex-session-commentary.js`: tails Codex session JSONL for commentary-phase progress updates.
- `src/reply-daemon.js`: reply polling, slash-command dispatch, approval bridge, and channel provisioning.
- `src/discord.js`: Discord REST helpers.
- `src/discord-slash-commands.js`: slash-command registration and Discord Gateway interaction runtime.
- `src/tmux.js`: tmux session/pane operations.
- `src/setup-bootstrap.js`: one-command bootstrap preparation and guided launch.
- `src/setup-discord.js`: writes Discord/reply/provision config.
- `src/config.js`: merges env vars + config file.
- `src/active-sessions.js`: managed session registry.

## Files and State

- Project files written by bootstrap:
  - `./.agents/skills/setup-discord/SKILL.md` (if missing)
- Global Codex trust:
  - `~/.codex/config.toml`
- codex-everywhere runtime/config:
  - `~/.codex-everywhere/config.json`
  - `~/.codex-everywhere/state/*`
  - `~/.codex-everywhere/logs/<project-slug>/*`

`setup discord` stores the Discord bot token, control channel id, resolved provisioning guild id, and authorized user ids in `~/.codex-everywhere/config.json`.

## Troubleshooting

- `guild not found for --guild-name ...`:
  - Create/select the guild first, or pass `--control-channel-id` / `--guild-id`.
- `failed to discover authorized user id automatically`:
  - Send one normal message in control channel, then rerun setup.
- Discord messages look empty:
  - Enable **Message Content Intent** in Discord bot settings.
- `/ce` does not appear in Discord:
  - Restart the daemon so it can register guild commands, then re-authorize the bot with the `applications.commands` scope if needed.
- Channel deletion fails with permission error:
  - Grant bot `Manage Channels` permission.
- Browser automation cannot start:
  - Confirm `npx` is available and rerun `codex-everywhere setup bootstrap` without `--no-install` so it can reinstall the Playwright skill if needed.

## Development

```bash
npm run check
npm test
```
