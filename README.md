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
- Multi-channel mode: each Discord channel can own one Codex session
  - New channels that match provisioning filters auto-start a detached Codex session
  - Messages posted in that channel route directly to that session
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

# Optional channel provisioning controls (new channel => new Codex session)
export OMX_DISCORD_PROVISION_ENABLED="true"
export OMX_DISCORD_PROVISION_PREFIX="codex-"
export OMX_DISCORD_PROVISION_CATEGORY_ID=""
export OMX_DISCORD_PROVISION_POLL_INTERVAL_MS="3000"
export OMX_DISCORD_PROVISION_MAX_CHANNELS="40"
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
      "mention": "<@123456789012345678>",
      "provisioning": {
        "enabled": true,
        "channelPrefix": "codex-",
        "categoryId": "",
        "pollIntervalMs": 3000,
        "maxManagedChannels": 40
      }
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

## Session Access (From Desktop)

List Discord-provisioned sessions:

```bash
codex-everywhere sessions list
```

Include all active sessions (including control-channel sessions):

```bash
codex-everywhere sessions list --all
```

Attach to a session by selector (index, channel ID, session ID, pane ID, or tmux session name):

```bash
codex-everywhere sessions attach 1
codex-everywhere sessions attach 1478000836398551083
```

Open live pane mode instead of tmux attach:

```bash
codex-everywhere sessions attach 1 --pane
codex-everywhere sessions attach 1 --pane --lines 160
```

Terminate a session safely (graceful `/exit` first):

```bash
codex-everywhere sessions terminate 1
```

If graceful exit stalls, force-kill the tmux target after a timeout:

```bash
codex-everywhere sessions terminate 1 --wait 8 --force
```

## Permission Approval Flow

When Codex asks for command approval, daemon sends a Discord message. Reply to that message with:

- `y` for approve once
- `p` for approve this prefix
- `n` for deny

The decision is injected into the tmux pane.
When denying with `n`, codex-everywhere also injects a short follow-up instruction so Codex continues without stalling.

## Channel-per-session Mode

The configured `notifications.discord-bot.channelId` acts as the control channel and guild anchor.

- Existing matching channels are baselined when daemon starts.
- Creating a new matching text channel (same guild, optional prefix/category filters) auto-starts a new detached Codex session bound to that channel.
- Any authorized user message in that channel is injected into its bound Codex session.
- Reply-threading still works; channel routing is used as fallback when message references are absent.

## Logs and State

- Project logs: `<project>/.omx/logs/codex-everywhere-turns-YYYY-MM-DD.jsonl`
- Global daemon/session state: `~/.omx/state/codex-everywhere/`
