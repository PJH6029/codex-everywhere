---
name: setup-discord
description: Bootstrap Discord app/bot/server setup for codex-everywhere and apply local config with minimal manual steps.
---

# setup-discord

Use this skill to bootstrap Discord for `codex-everywhere` with minimal manual steps.

## Goal

After running this skill, user should be able to type `!ce-new` in control channel and start working.

Target defaults:

- Server (guild) name: `codex-everywhere-server`
- Control channel name: `일반` (Korean) or `general` (English)

## Inputs to collect

- Discord Developer Portal login (user performs this in browser)
- Bot token
- Control channel id

`authorized-user-id` can be auto-discovered from latest non-bot message in control channel.

## Workflow

1. Ensure Codex has full access permission.
   - In Codex terminal, run `/permissions` and allow full access for setup.
   - Recommend user watches setup live while automation runs.
2. Ensure package is installed and runnable.
   - In repo: `npm link`
   - Sanity: `codex-everywhere --help`
3. Use the installed `$playwright` skill for browser automation.
   - Follow its prerequisite check first: `command -v npx >/dev/null 2>&1`
   - Set the wrapper path:
     - `export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"`
     - `export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"`
   - Sanity-check the wrapper: `"$PWCLI" --help`
   - If `npx` or the wrapper is missing, pause and ask the user to install the Playwright skill in `~/.codex/skills/playwright`.
4. Open Discord Developer Portal with Playwright CLI.
   - `"$PWCLI" open https://discord.com/developers/applications --headed`
   - Use `"$PWCLI" snapshot` before clicking and re-snapshot after navigation or major DOM changes.
   - Pause for user login / 2FA when needed.
5. Create app + bot (unless already present):
   - New Application (name: `codex-everywhere` or user choice)
   - Bot tab: create bot, enable **Message Content Intent**
   - Bot token generation/reveal may require re-authentication; ask user to complete it
   - Copy bot token
6. Invite bot to server:
   - OAuth2 URL Generator
   - Scope: `bot`
   - Permissions:
     - `View Channels`
     - `Read Message History`
     - `Send Messages`
     - `Add Reactions`
     - `Manage Channels`
   - Open generated URL and complete invite
   - If CAPTCHA appears, user must solve it.
7. Create server/guild (Playwright CLI on Discord Web):
   - Create server named `codex-everywhere-server`.
   - Keep the default first text channel (`일반` or `general` depending on locale).
8. Prepare control channel:
   - Ask user to send one normal text message in that default channel (needed for auto user-id discovery).
9. Apply local config (single command, no channel-id copy needed):
   - `codex-everywhere setup discord --bot-token "<TOKEN>" --guild-name "codex-everywhere-server" --authorized-user-id auto`
   - Optional locale explicit: `--control-channel-name "일반"` or `--control-channel-name "general"`
10. Start daemon:
   - `codex-everywhere daemon stop`
   - `codex-everywhere daemon start`
11. Verify:
   - In control channel: `!ce-new`
   - Confirm new channel/session appears.

## Notes

- Use the Playwright CLI skill flow for this setup.
- If `discord_http_403_*missing_permissions*` appears, fix channel/category overrides for bot role.
- If plain channel messages arrive empty, verify **Message Content Intent** is enabled and restart daemon.
- Discord cannot force UI focus switching; use channel mention/link messages.
