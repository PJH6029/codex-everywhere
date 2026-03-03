# setup-discord

Use this skill to bootstrap Discord for `codex-everywhere` with minimal manual steps.

## Goal

After running this skill, user should be able to type `!ce-new` in control channel and start working.

## Inputs to collect

- Discord Developer Portal login (user performs this in browser)
- Bot token
- Control channel id

`authorized-user-id` can be auto-discovered from latest non-bot message in control channel.

## Workflow

1. Ensure package is installed and runnable.
   - In repo: `npm link`
   - Sanity: `codex-everywhere --help`
2. Open Discord Developer Portal with Playwright MCP:
   - `https://discord.com/developers/applications`
   - Pause for user login / 2FA when needed.
3. Create app + bot (unless already present):
   - New Application (name: `codex-everywhere` or user choice)
   - Bot tab: create bot, enable **Message Content Intent**
   - Copy bot token
4. Invite bot to server:
   - OAuth2 URL Generator
   - Scope: `bot`
   - Permissions:
     - `View Channels`
     - `Read Message History`
     - `Send Messages`
     - `Add Reactions`
     - `Manage Channels`
   - Open generated URL and complete invite.
5. Prepare control channel:
   - In Discord app, select/create control channel.
   - Copy control channel id (Developer Mode).
   - Ask user to send one normal text message in that channel (needed for auto user-id discovery).
6. Apply local config (single command):
   - `codex-everywhere setup discord --bot-token "<TOKEN>" --control-channel-id "<CHANNEL_ID>" --authorized-user-id auto`
7. Start daemon:
   - `codex-everywhere daemon stop`
   - `codex-everywhere daemon start`
8. Verify:
   - In control channel: `!ce-new`
   - Confirm new channel/session appears.

## Notes

- If `discord_http_403_*missing_permissions*` appears, fix channel/category overrides for bot role.
- If plain channel messages arrive empty, verify **Message Content Intent** is enabled and restart daemon.
- Discord cannot force UI focus switching; use channel mention/link messages.
