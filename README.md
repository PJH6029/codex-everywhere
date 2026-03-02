# codex-everywhere

Minimal OMX-like Codex add-on focused on messenger interaction.

`codex-everywhere` runs Codex in a tmux pane, sends Discord bot notifications, accepts Discord replies, and injects those replies back into the Codex session.

It also scans for Codex permission prompts (approval UI) and forwards them to Discord so user decisions can be sent back to Codex.

## Features

- Starts Codex in tmux via `codex-everywhere`
- Injects Codex notify hook at runtime (`codex -c notify=[...]`)
- Sends session start/end + turn response notifications to Discord bot channel
- Two-way chat by replying to bot messages
- Approval bridge: detects Codex permission prompts and asks user for `y` / `p` / `n` on Discord
- OMX-compatible Discord env/config keys

## Prerequisites

- Node.js 20+
- `tmux`
- `codex` CLI (`npm i -g @openai/codex`)
- Discord bot token + channel ID

## Install

```bash
cd ~/code/codex-everywhere
npm link
```

Then run:

```bash
codex-everywhere
```

Pass any Codex args through:

```bash
codex-everywhere -m gpt-5.3-codex --full-auto
```

## Discord Configuration

Use OMX-compatible env vars:

```bash
export OMX_DISCORD_NOTIFIER_BOT_TOKEN="<discord-bot-token>"
export OMX_DISCORD_NOTIFIER_CHANNEL="<discord-channel-id>"
```

To enable reply injection auth:

```bash
export OMX_REPLY_ENABLED="true"
export OMX_REPLY_DISCORD_USER_IDS="123456789012345678"
```

Optional:

```bash
export OMX_DISCORD_MENTION="<@123456789012345678>"
export OMX_REPLY_POLL_INTERVAL_MS="3000"
export OMX_REPLY_RATE_LIMIT="10"
export OMX_REPLY_INCLUDE_PREFIX="true"
export OMX_REPLY_AUTO_CONTINUE_ON_DENY="true"
# Optional custom instruction injected after deny (`n`)
export OMX_REPLY_ON_DENY_MESSAGE="User denied this command. Continue without running it and choose a safe alternative."
```

You can also set the same values in `~/.codex/.omx-config.json`:

```json
{
  "notifications": {
    "enabled": true,
    "discord-bot": {
      "enabled": true,
      "botToken": "<token>",
      "channelId": "<channel-id>",
      "mention": "<@123456789012345678>"
    },
    "reply": {
      "enabled": true,
      "authorizedDiscordUserIds": ["123456789012345678"],
      "pollIntervalMs": 3000,
      "rateLimitPerMinute": 10,
      "includePrefix": true,
      "autoContinueOnDeny": true,
      "onDenyMessage": "User denied this command. Continue without running it and choose a safe alternative.",
      "maxMessageLength": 500
    }
  }
}
```

## Daemon Control

```bash
codex-everywhere daemon status
codex-everywhere daemon start
codex-everywhere daemon stop
```

If `daemon start` reports a conflicting listener, stop old OMX reply listeners first:

```bash
pkill -f 'oh-my-codex/dist/notifications/reply-listener.js'
```

## Permission Approval Flow

When Codex asks for command approval, daemon sends a Discord message. Reply to that message with:

- `y` for approve once
- `p` for approve this prefix
- `n` for deny

The decision is injected into the tmux pane.
When denying with `n`, codex-everywhere also injects a short follow-up instruction so Codex continues without stalling.

## Logs and State

- Project logs: `<project>/.omx/logs/codex-everywhere-turns-YYYY-MM-DD.jsonl`
- Global daemon/session state: `~/.omx/state/codex-everywhere/`
