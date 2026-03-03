# codex-everywhere

Minimal OMX-like Codex add-on focused on messenger interaction.

`codex-everywhere` runs Codex in a tmux pane, sends Discord bot notifications, accepts Discord replies, and injects those replies back into the Codex session.

It also scans for Codex permission prompts (approval UI) and forwards them to Discord so user decisions can be sent back to Codex.

## Features

- Starts Codex in tmux via `codex-everywhere`
- Injects Codex notify hook at runtime (`codex -c notify=[...]`)
- Sends session start/end + turn response notifications to Discord bot channel
- Two-way chat by replying to bot messages
- Terminal-to-Discord sync: prompts typed directly in tmux are posted to Discord
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
- Discord bot permissions in your server (see Discord setup below)

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

### Discord Developer Portal + Server Setup (Required)

1. Create or open your Discord application and bot in the Developer Portal.
2. In `Bot` settings:
   - Enable **Message Content Intent**.
3. In `OAuth2 > URL Generator`:
   - Scopes: `bot`
   - Bot permissions (minimum):
     - `View Channels`
     - `Read Message History`
     - `Send Messages`
     - `Add Reactions`
   - Additional permission for channel auto-cleanup on terminate:
     - `Manage Channels`
4. Re-invite the bot with updated permissions if needed.
5. In Discord server/channel/category permission overrides:
   - Make sure the bot role is not denied the permissions above.
   - If using category-based channel provisioning, set permissions on that category too.

Without **Message Content Intent**, plain channel messages may appear empty to the bot.
Without **Manage Channels**, session termination works but channel deletion fails with `discord_http_403`.

### Runtime Config (Env Vars)

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

`OMX_REPLY_INCLUDE_PREFIX="true"` is recommended.  
It helps avoid echo loops by tagging Discord-injected prompts as `[reply:discord]`.

Recommended restart after changing env/config:

```bash
codex-everywhere daemon stop
codex-everywhere daemon start
```

You can also set the same values in `~/.codex/.omx-config.json`:

```json
{
  "notifications": {
    "enabled": true,
    "events": {
      "user-input": { "enabled": true }
    },
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

For channel-provisioned sessions, `sessions terminate` also deletes the bound Discord channel after termination.

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
- Control channel is always polled so orchestration commands work even while other sessions are running.

### Control-Channel Session Create Command

In the control channel, send one of:

- `!ce-new`
- `!ce-new <name>`
- `!ce-new --cwd ~/code/my-project`
- `!ce-new <name> --cwd ~/code/my-project`

Behavior:

- Creates a new text channel in the same guild (and configured category if set).
- Starts a new Codex session bound to that channel and directory.
- Sends a channel mention + link in control channel so you can jump there quickly.
- Discord does not allow bots to force client focus switching; click the mention/link to switch.

### Discord-side Termination Command

To terminate from Discord directly, send one of these exact messages in the session channel:

- `!ce-exit`
- `!ce-terminate`
- `!codex-exit`
- `!codex-terminate`
- `/exit` (alias; may conflict with Discord slash-command UX, so `!ce-exit` is recommended)

The daemon safely terminates the bound Codex session (graceful `/exit` first, force fallback if needed).  
If the channel is a provisioned per-session channel, the channel is deleted after termination.
After channel deletion, codex-everywhere posts a handoff message in the control channel.

If plain channel messages are injected as empty content, enable **Message Content Intent** for the bot in the Discord Developer Portal.  
Replies/mentions may still work without it, but plain text command parsing is unreliable when that intent is disabled.

## Discord Troubleshooting

- `discord_http_401`:
  - Bot token is invalid/expired, or wrong token is loaded.
- `discord_http_403_*missing_permissions*` on channel delete:
  - Grant bot role `Manage Channels` in server and channel/category overrides.
- Plain channel messages are treated as empty:
  - Enable **Message Content Intent**.
  - Restart daemon after intent/permission updates.
- `!ce-exit` did nothing:
  - Ensure message came from a user in `OMX_REPLY_DISCORD_USER_IDS`.
  - Use exact command text (or reply/mention with the command).

## Logs and State

- Project logs: `<project>/.omx/logs/codex-everywhere-turns-YYYY-MM-DD.jsonl`
- Global daemon/session state: `~/.omx/state/codex-everywhere/`
