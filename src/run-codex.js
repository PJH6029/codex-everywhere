#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { findActiveSessionById, removeActiveSession } from './active-sessions.js';
import { loadAppConfig } from './config.js';
import { deleteDiscordChannel, sendDiscordMessage } from './discord.js';
import { notifyEvent } from './notify.js';
import { appendJsonl, resolveFromCwd, sleep, todayFileName } from './utils.js';

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    sessionId: '',
    cwd: process.cwd(),
    channelId: '',
    passthrough: [],
  };

  let idx = 0;
  while (idx < args.length) {
    const current = args[idx];
    if (current === '--') {
      parsed.passthrough = args.slice(idx + 1);
      return parsed;
    }
    if (current === '--session-id') {
      parsed.sessionId = args[idx + 1] || '';
      idx += 2;
      continue;
    }
    if (current === '--cwd') {
      parsed.cwd = args[idx + 1] || parsed.cwd;
      idx += 2;
      continue;
    }
    if (current === '--channel-id') {
      parsed.channelId = args[idx + 1] || '';
      idx += 2;
      continue;
    }
    idx += 1;
  }

  parsed.passthrough = [];
  return parsed;
}

function hasArg(args, value) {
  return args.includes(value);
}

async function notifyWithRetry(event, payload, options = {}) {
  const attempts = Math.max(1, Number.parseInt(String(options.attempts ?? 3), 10) || 3);
  const baseDelayMs = Math.max(100, Number.parseInt(String(options.baseDelayMs ?? 700), 10) || 700);
  const projectPath = payload.projectPath || process.cwd();
  const logPath = resolveFromCwd(projectPath, '.codex-everywhere', 'logs', todayFileName('codex-everywhere-notify'));

  let lastResult = { success: false, error: 'unknown' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await notifyEvent(event, payload).catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    lastResult = result;

    await appendJsonl(logPath, {
      timestamp: new Date().toISOString(),
      event,
      attempt,
      success: result.success === true,
      error: result.success ? null : result.error || 'notify_failed',
      session_id: payload.sessionId || '',
      message_id: result.messageId || null,
      used_fallback_token: result.usedFallbackToken === true,
    }).catch(() => {});

    if (result.success) return result;
    if (attempt < attempts) {
      await sleep(baseDelayMs * attempt);
    }
  }

  return lastResult;
}

function shouldDeleteManagedChannel(session, config) {
  const channelId = String(session?.channelId || '').trim();
  if (!channelId || !/^\d{17,20}$/.test(channelId)) return false;
  if (channelId === String(config?.discordBot?.channelId || '').trim()) return false;
  return session?.provisionedByChannel === true;
}

async function sendControlChannelHandoff(config, session, trigger = 'session-end') {
  const controlChannelId = String(config?.discordBot?.channelId || '').trim();
  const sessionChannelId = String(session?.channelId || '').trim();
  if (!controlChannelId || controlChannelId === sessionChannelId) return;

  const debug = config?.debug === true;
  await sendDiscordMessage(config.discordBot, {
    channelId: controlChannelId,
    content: [
      debug
        ? `Session \`${session?.sessionId || ''}\` finished via ${trigger}.`
        : `A Codex session finished via ${trigger}.`,
      `Continue here in <#${controlChannelId}>.`,
      'Create another session with `!ce-new [name] --cwd <path>`.',
    ].join('\n'),
  }).catch(() => {});
}

async function cleanupManagedSessionChannelOnExit(session, reason = 'session-end') {
  if (!session || typeof session !== 'object') {
    return { deleted: false, reason: 'session_missing' };
  }

  const config = loadAppConfig();
  if (!config.notificationsEnabled || !config.discordBot.enabled) {
    return { deleted: false, reason: 'discord_not_configured' };
  }

  if (!shouldDeleteManagedChannel(session, config)) {
    return { deleted: false, reason: 'not_managed_channel' };
  }

  const channelId = String(session.channelId || '').trim();
  const deleteResult = await deleteDiscordChannel(
    config.discordBot,
    channelId,
    `codex-everywhere:run-codex:${reason}`,
  ).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (deleteResult.success) {
    await sendControlChannelHandoff(config, session, reason).catch(() => {});
    return { deleted: true, reason: '' };
  }

  const errorText = String(deleteResult.error || 'discord_delete_channel_failed');
  if (errorText.includes('discord_http_404')) {
    // Already deleted by another path (CLI/Discord termination flow).
    return { deleted: true, reason: 'already_deleted' };
  }

  const detail = errorText.includes('missing_permissions')
    ? `${errorText} (grant the bot 'Manage Channels' permission on this channel/category)`
    : errorText;

  await sendDiscordMessage(config.discordBot, {
    channelId,
    content: `Failed to auto-delete this session channel: ${detail}`,
  }).catch(() => {});

  const controlChannelId = String(config?.discordBot?.channelId || '').trim();
  if (controlChannelId && controlChannelId !== channelId) {
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content:
        config.debug === true
          ? `Failed to auto-delete session \`${session.sessionId || ''}\` channel <#${channelId}>: ${detail}`
          : `Failed to auto-delete a finished session channel <#${channelId}>: ${detail}`,
    }).catch(() => {});
  }

  return { deleted: false, reason: detail };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const sessionId = parsed.sessionId || process.env.CODEX_EVERYWHERE_SESSION_ID || 'unknown-session';
  const channelId = parsed.channelId || process.env.CODEX_EVERYWHERE_DISCORD_CHANNEL || '';
  const codexBinary = process.env.CODEX_EVERYWHERE_CODEX_BIN || 'codex';

  const hookPath = fileURLToPath(new URL('./notify-hook.js', import.meta.url));
  const escapedHook = hookPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const notifyConfig = `notify=[\"node\",\"${escapedHook}\"]`;

  const passthrough = [...parsed.passthrough];
  if (!hasArg(passthrough, '--no-alt-screen')) {
    passthrough.unshift('--no-alt-screen');
  }

  const codexArgs = ['-c', notifyConfig, ...passthrough];

  const child = spawn(codexBinary, codexArgs, {
    cwd: parsed.cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      CODEX_EVERYWHERE_SESSION_ID: sessionId,
      CODEX_EVERYWHERE_PROJECT_PATH: parsed.cwd,
      CODEX_EVERYWHERE_DISCORD_CHANNEL: channelId,
    },
  });

  child.on('exit', async (code, signal) => {
    const reason = signal ? `signal:${signal}` : `exit:${code ?? 0}`;
    const activeSession = await findActiveSessionById(sessionId).catch(() => null);

    await removeActiveSession(sessionId).catch(() => {});

    await notifyWithRetry('session-end', {
      sessionId,
      paneId: process.env.TMUX_PANE || '',
      tmuxSessionName: process.env.CODEX_EVERYWHERE_TMUX_SESSION || '',
      projectPath: parsed.cwd,
      channelId,
      reason,
    }, { attempts: 3, baseDelayMs: 600 });

    await cleanupManagedSessionChannelOnExit(activeSession, 'session-end').catch(() => {});

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', async (error) => {
    const activeSession = await findActiveSessionById(sessionId).catch(() => null);
    await removeActiveSession(sessionId).catch(() => {});
    await cleanupManagedSessionChannelOnExit(activeSession, 'spawn-error').catch(() => {});
    console.error(`[codex-everywhere] failed to start codex: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(`[codex-everywhere] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
