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
   - If login / 2FA / CAPTCHA is required, tell the user to complete it in the browser and keep polling from Playwright until the intended post-auth state is visible. Do not ask the user to type a separate "I'm done" message.
5. Create app + bot (unless already present):
   - New Application (name: `codex-everywhere` or user choice)
   - Bot tab: create bot, enable **Message Content Intent**
   - Bot token generation/reveal may require re-authentication; tell the user to complete it in the browser and resume automatically once the token UI or post-auth modal state is visible again
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
   - If CAPTCHA appears, user must solve it in the browser; keep polling and continue automatically once the authorize/success state changes
7. Create server/guild (Playwright CLI on Discord Web):
   - Create server named `codex-everywhere-server`.
   - Keep the default first text channel (`일반` or `general` depending on locale).
8. Prepare control channel:
   - Use Playwright in Discord Web to send one normal text message in that default channel from the logged-in user account (for example: `setup ping`).
   - Do this on the user's behalf; do not ask the user to type the first message manually.
   - This message is needed for auto `authorized-user-id` discovery because `setup discord --authorized-user-id auto` resolves the latest non-bot channel message.
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
- For every manual auth gate, prefer waiting on a positive completion signal instead of chat confirmation.
- The initial control-channel ping for auto user-id discovery must be sent from the logged-in Discord user in Discord Web, not from the bot/API setup confirmation message.
- Good signals:
  - Discord Developer Portal login complete: URL is back on `discord.com/developers/applications` and the applications list or `New Application` UI is visible.
  - Token re-auth complete: the password/2FA modal disappears and the reveal/regenerate token UI becomes available again.
  - Bot invite complete: the authorize page changes to a success/redirected state or the previous authorize controls disappear.
  - Discord Web login complete: guild/channel UI is visible and the target guild/channel can be reached.
- Prefer `"$PWCLI" run-code "await page.waitForURL(...)"` or `"$PWCLI" run-code "await page.waitForFunction(...)"` with `timeout: 0` and light polling over asking the user to type "done".
- Example waits:
  - `"$PWCLI" run-code "await page.waitForURL(/discord\\.com\\/developers\\/applications/, { timeout: 0 })"`
  - `"$PWCLI" run-code "await page.waitForFunction(() => /new application|applications/i.test(document.body?.innerText || ''), { polling: 1000, timeout: 0 })"`
  - `"$PWCLI" run-code "await page.waitForFunction(() => !/two-factor|re-auth|captcha/i.test(document.body?.innerText || ''), { polling: 1000, timeout: 0 })"`
- Use auth-page disappearance only as a fallback when there is no reliable target URL, button, modal, or text to wait for.
- If `discord_http_403_*missing_permissions*` appears, fix channel/category overrides for bot role.
- If plain channel messages arrive empty, verify **Message Content Intent** is enabled and restart daemon.
- Discord cannot force UI focus switching; use channel mention/link messages.
