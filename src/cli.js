#!/usr/bin/env node

import { randomUUID } from 'crypto';
import { basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadAppConfig } from './config.js';
import {
  createGuildTextChannel,
  deleteDiscordChannel,
  getDiscordChannel,
  listGuildTextChannels,
  sendDiscordMessage,
} from './discord.js';
import { notifyEvent } from './notify.js';
import { startDaemon, stopDaemon, daemonStatus } from './reply-daemon.js';
import { runDiscordSetupCommand } from './setup-discord.js';
import { runBootstrapSetupCommand } from './setup-bootstrap.js';
import {
  listActiveSessions,
  pruneActiveSessions,
  removeActiveSession,
  upsertActiveSession,
} from './active-sessions.js';
import {
  attachSession,
  capturePane,
  createDetachedSession,
  createWindowInCurrentSession,
  isTmuxAvailable,
  killPane,
  killSession,
  listPaneIds,
  sendLiteralToPane,
  selectWindow,
  sanitizeName,
  switchClientSession,
} from './tmux.js';
import { appendJsonl, resolveFromCwd, shellEscape, sleep, todayFileName } from './utils.js';

const HELP = `codex-everywhere

Usage:
  codex-everywhere [codex args...]
  codex-everywhere setup discord [options]
  codex-everywhere setup bootstrap [options]
  codex-everywhere daemon start [--debug|--no-debug]
  codex-everywhere daemon restart [--debug|--no-debug]
  codex-everywhere daemon <stop|status>
  codex-everywhere sessions [list] [--all]
  codex-everywhere sessions attach [selector] [--pane] [--lines <n>] [--all]
  codex-everywhere sessions terminate [selector] [--all] [--wait <sec>] [--force]

Behavior:
  - Starts Codex in tmux
  - Sends Discord bot notifications (OMX-compatible config/env)
  - Accepts Discord replies and injects them into the Codex pane
  - Forwards Codex approval prompts through Discord and injects decisions
  - Lists, opens, and terminates tmux sessions created from Discord channels
  - Deletes per-session Discord channels when those managed sessions are terminated
  - Supports one-shot Discord config setup (\`setup discord\`)
  - Supports one-command guided bootstrap (\`setup bootstrap\`)
`;

function codexInstalled() {
  const result = spawnSync('codex', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return !result.error && result.status === 0;
}

function buildRunnerCommand(sessionId, cwd, channelId = '', passthroughArgs = []) {
  const runCodexPath = fileURLToPath(new URL('./run-codex.js', import.meta.url));

  const tokens = [
    'node',
    runCodexPath,
    '--session-id',
    sessionId,
    '--cwd',
    cwd,
    '--channel-id',
    channelId,
    '--',
    ...passthroughArgs,
  ];

  return tokens.map((token) => shellEscape(token)).join(' ');
}

function projectNameFromCwd(cwd) {
  return sanitizeName(basename(cwd), 'project');
}

const DEFAULT_NEW_CHANNEL_NAME = 'new-channel';

function ensureDiscordConfigured(config) {
  if (!config.notificationsEnabled || !config.discordBot.enabled) {
    throw new Error(
      'Discord bot notification config missing. Set OMX_DISCORD_NOTIFIER_BOT_TOKEN and OMX_DISCORD_NOTIFIER_CHANNEL, or configure ~/.codex/.omx-config.json notifications["discord-bot"].',
    );
  }
}

function normalizeDiscordChannelName(name, fallback = DEFAULT_NEW_CHANNEL_NAME) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 95) || fallback;
}

function randomSuffix(length = 4) {
  const raw = Math.floor(Math.random() * 36 ** Math.max(1, length))
    .toString(36);
  return raw.padStart(Math.max(1, length), '0').slice(0, Math.max(1, length));
}

function inferCliProvisionChannelName(config) {
  const prefix = String(config?.discordProvisioning?.channelPrefix || 'codex-').trim().toLowerCase() || 'codex-';
  const base = normalizeDiscordChannelName(DEFAULT_NEW_CHANNEL_NAME);
  if (base.startsWith(prefix)) {
    return base.slice(0, 95);
  }
  return `${prefix}${base}`.slice(0, 95);
}

async function resolveControlGuildId(config) {
  const controlChannelId = String(config?.discordBot?.channelId || '').trim();
  if (!controlChannelId) return '';

  const lookedUp = await getDiscordChannel(config.discordBot, controlChannelId).catch(() => ({
    success: false,
    error: 'discord_control_channel_lookup_failed',
  }));
  if (!lookedUp.success) return '';
  return String(lookedUp?.channel?.guild_id || '').trim();
}

async function makeUniqueDiscordChannelName(config, guildId, desiredName) {
  const candidate = normalizeDiscordChannelName(desiredName);
  const listed = await listGuildTextChannels(config.discordBot, guildId).catch(() => ({
    success: false,
    channels: [],
  }));
  if (!listed.success) return candidate;

  const existing = new Set(
    listed.channels.map((channel) => normalizeDiscordChannelName(channel?.name || '')),
  );
  if (!existing.has(candidate)) return candidate;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = randomSuffix(4 + Math.min(2, attempt));
    const maxBaseLength = Math.max(1, 95 - suffix.length - 1);
    const base = candidate.slice(0, maxBaseLength);
    const next = `${base}-${suffix}`;
    if (!existing.has(next)) return next;
  }

  return `${candidate.slice(0, 90)}-${Date.now().toString(36).slice(-4)}`;
}

async function provisionSessionChannelForCli(config, cwd) {
  if (config?.discordProvisioning?.enabled !== true) {
    return { success: false, reason: 'provisioning_disabled' };
  }

  const guildId = await resolveControlGuildId(config);
  if (!guildId) {
    return { success: false, reason: 'discord_control_channel_lookup_failed' };
  }

  const desiredName = inferCliProvisionChannelName(config);
  const channelName = await makeUniqueDiscordChannelName(config, guildId, desiredName);
  const parentId = String(config?.discordProvisioning?.categoryId || '').trim();
  const createResult = await createGuildTextChannel(config.discordBot, guildId, {
    name: channelName,
    parentId,
    topic: `codex-everywhere cwd: ${cwd}`,
  }).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!createResult.success) {
    return { success: false, reason: createResult.error || 'discord_create_channel_failed' };
  }

  const channelId = String(createResult?.channel?.id || '').trim();
  if (!channelId) {
    return { success: false, reason: 'discord_create_channel_missing_id' };
  }

  return {
    success: true,
    channelId,
    channelName,
    guildId,
  };
}

async function loadManagedSessions(includeAll = false) {
  void includeAll;
  const sessions = await pruneActiveSessions(listPaneIds());
  return sessions.sort((a, b) => {
    const ta = new Date(a?.startedAt || 0).getTime();
    const tb = new Date(b?.startedAt || 0).getTime();
    return tb - ta;
  });
}

function parseSessionCommandOptions(args) {
  const parsed = {
    selector: '',
    includeAll: false,
    paneMode: false,
    lines: 120,
    force: false,
    waitSeconds: 12,
  };

  for (let idx = 0; idx < args.length; idx += 1) {
    const token = args[idx];
    if (token === '--all') {
      parsed.includeAll = true;
      continue;
    }
    if (token === '--pane') {
      parsed.paneMode = true;
      continue;
    }
    if (token === '--force') {
      parsed.force = true;
      continue;
    }
    if (token === '--lines') {
      const value = Number.parseInt(String(args[idx + 1] || ''), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('`--lines` must be a positive integer');
      }
      parsed.lines = value;
      idx += 1;
      continue;
    }
    if (token === '--wait') {
      const value = Number.parseInt(String(args[idx + 1] || ''), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('`--wait` must be a positive integer');
      }
      parsed.waitSeconds = value;
      idx += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`unknown option: ${token}`);
    }
    if (!parsed.selector) {
      parsed.selector = token;
      continue;
    }
    throw new Error(`unexpected argument: ${token}`);
  }

  return parsed;
}

function printSessionList(sessions, includeAll) {
  void includeAll;
  if (sessions.length === 0) {
    console.log('[codex-everywhere] no active tmux-backed codex sessions found');
    return;
  }

  console.log('IDX  CHANNEL_ID            SESSION_NAME                      PANE  SESSION_ID');
  for (let idx = 0; idx < sessions.length; idx += 1) {
    const session = sessions[idx];
    const channel = String(session.channelId || '-').padEnd(20, ' ');
    const name = String(session.tmuxSessionName || '-').slice(0, 32).padEnd(32, ' ');
    const pane = String(session.paneId || '-').padEnd(5, ' ');
    const id = String(session.sessionId || '-');
    console.log(`${String(idx + 1).padStart(3, ' ')}  ${channel} ${name} ${pane} ${id}`);
  }
}

function resolveSessionSelector(sessions, selector) {
  if (!selector) {
    if (sessions.length === 1) return sessions[0];
    return null;
  }

  const index = Number.parseInt(selector, 10);
  if (Number.isFinite(index) && String(index) === selector.trim()) {
    if (index >= 1 && index <= sessions.length) {
      return sessions[index - 1];
    }
  }

  const matches = sessions.filter((session) => {
    return [
      String(session.sessionId || ''),
      String(session.channelId || ''),
      String(session.tmuxSessionName || ''),
      String(session.paneId || ''),
    ].includes(selector);
  });

  if (matches.length === 1) return matches[0];
  return null;
}

async function runPaneMode(session, lines) {
  const paneId = String(session?.paneId || '');
  if (!paneId) {
    throw new Error('selected session does not have a valid pane id');
  }

  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopRequested) {
    const content = capturePane(paneId, lines);
    if (!content) {
      console.error(`[codex-everywhere] pane ${paneId} no longer available`);
      break;
    }
    process.stdout.write('\x1Bc');
    process.stdout.write(content);
    process.stdout.write('\n');
    await sleep(1000);
  }
}

function attachOrSwitchSession(sessionName) {
  if (process.env.TMUX) {
    const ok = switchClientSession(sessionName);
    if (!ok) {
      throw new Error(`tmux switch-client failed for ${sessionName}`);
    }
    return;
  }
  attachSession(sessionName);
}

function optionEnabled(value) {
  return value === true;
}

function assertUnsupportedOptions(options, unsupported, subcommand) {
  for (const key of unsupported) {
    if (key === 'selector' && options.selector) {
      throw new Error('selector is not supported for this subcommand');
    }
    if (key === 'includeAll' && optionEnabled(options.includeAll)) {
      throw new Error('`--all` is not supported for this subcommand');
    }
    if (key === 'lines' && options.lines !== 120) {
      throw new Error(`\`--lines\` is not supported for sessions ${subcommand}`);
    }
    if (key === 'waitSeconds' && options.waitSeconds !== 12) {
      throw new Error(`\`--wait\` is not supported for sessions ${subcommand}`);
    }
    if (optionEnabled(options[key])) {
      const optionFlag = key === 'paneMode' ? '--pane' : `--${key}`;
      throw new Error(`\`${optionFlag}\` is not supported for sessions ${subcommand}`);
    }
  }
}

async function waitForPaneExit(paneId, timeoutMs) {
  const waitMs = Math.max(0, Math.trunc(timeoutMs));
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    if (!listPaneIds().has(paneId)) {
      return true;
    }
    await sleep(250);
  }

  return !listPaneIds().has(paneId);
}

async function shouldSendForcedTerminationNotice(sessionId) {
  const sessions = await listActiveSessions();
  return sessions.some((session) => session.sessionId === sessionId);
}

async function forceTerminateSession(selected, reason = 'terminated:force') {
  const killBySession = selected.tmuxSessionName ? killSession(selected.tmuxSessionName) : false;
  const killByPane = killBySession ? true : killPane(selected.paneId);

  if (!killByPane) {
    throw new Error('failed to force terminate tmux target');
  }

  await waitForPaneExit(selected.paneId, 2500);

  const shouldNotify = await shouldSendForcedTerminationNotice(selected.sessionId);
  await removeActiveSession(selected.sessionId).catch(() => {});

  if (shouldNotify) {
    await notifyWithRetry('session-end', {
      sessionId: selected.sessionId,
      paneId: selected.paneId,
      tmuxSessionName: selected.tmuxSessionName || '',
      channelId: selected.channelId || '',
      projectPath: selected.projectPath || process.cwd(),
      reason,
    }, { attempts: 3, baseDelayMs: 600 });
  }
}

async function terminateSession(selected, options) {
  const paneId = String(selected?.paneId || '');
  if (!paneId) {
    throw new Error('selected session does not have a valid pane id');
  }

  const submitted = sendLiteralToPane(paneId, '/exit', true, 1);
  if (!submitted) {
    if (!options.force) {
      throw new Error('failed to submit graceful `/exit` command to the selected pane');
    }
    await forceTerminateSession(selected, 'terminated:force-no-exit-submit');
    return { terminated: true, forced: true };
  }

  const gracefulExited = await waitForPaneExit(paneId, options.waitSeconds * 1000);
  if (gracefulExited) {
    return { terminated: true, forced: false };
  }

  if (!options.force) {
    throw new Error(`session did not exit within ${options.waitSeconds}s (retry with \`--force\`)`);
  }

  await forceTerminateSession(selected, 'terminated:force-timeout');
  return { terminated: true, forced: true };
}

function shouldDeleteManagedChannel(session, config) {
  const channelId = String(session?.channelId || '').trim();
  if (!channelId || !/^\d{17,20}$/.test(channelId)) return false;
  if (channelId === String(config?.discordBot?.channelId || '').trim()) return false;
  return session?.provisionedByChannel === true;
}

async function deleteManagedChannelForTerminatedSession(session, trigger = 'cli') {
  const config = loadAppConfig();
  if (!config.notificationsEnabled || !config.discordBot.enabled) {
    return { deleted: false, reason: 'discord_not_configured' };
  }

  if (!shouldDeleteManagedChannel(session, config)) {
    return { deleted: false, reason: 'not_managed_channel' };
  }

  const channelId = String(session.channelId).trim();
  const debug = config.debug === true;
  await sendDiscordMessage(config.discordBot, {
    channelId,
    content: debug
      ? `Session \`${session.sessionId}\` terminated by ${trigger}. This channel will now be deleted.`
      : `Session terminated by ${trigger}. This channel will now be deleted.`,
  }).catch(() => {});

  await sleep(350);

  const result = await deleteDiscordChannel(
    config.discordBot,
    channelId,
    `codex-everywhere:${trigger}:session-terminate`,
  ).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!result.success) {
    let reason = result.error || 'discord_delete_channel_failed';
    if (reason.includes('missing_permissions')) {
      reason =
        `${reason} (grant the bot 'Manage Channels' permission on this channel/category)`;
    }
    return { deleted: false, reason };
  }

  const controlChannelId = String(config?.discordBot?.channelId || '').trim();
  const sessionChannelId = String(session?.channelId || '').trim();
  if (controlChannelId && controlChannelId !== sessionChannelId) {
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content: [
        debug
          ? `Session \`${session.sessionId}\` finished via ${trigger}.`
          : `A Codex session finished via ${trigger}.`,
        `Continue here in <#${controlChannelId}>.`,
        'Create another session with `!ce-new [name] --cwd <path>`.',
      ].join('\n'),
    }).catch(() => {});
  }

  return { deleted: true, reason: '' };
}

async function handleSessionsCommand(args) {
  const sub = args[0] || 'list';

  if (sub === 'list') {
    const options = parseSessionCommandOptions(args.slice(1));
    assertUnsupportedOptions(options, ['selector', 'paneMode', 'lines', 'force', 'waitSeconds'], 'list');
    const sessions = await loadManagedSessions(options.includeAll);
    printSessionList(sessions, options.includeAll);
    return;
  }

  if (sub === 'attach') {
    const options = parseSessionCommandOptions(args.slice(1));
    assertUnsupportedOptions(options, ['force', 'waitSeconds'], 'attach');
    const sessions = await loadManagedSessions(options.includeAll);
    const selected = resolveSessionSelector(sessions, options.selector);

    if (!selected) {
      printSessionList(sessions, options.includeAll);
      if (!options.selector && sessions.length > 1) {
        throw new Error('multiple sessions found; provide a selector (index, channel id, session id, pane id, or tmux session name)');
      }
      throw new Error(`session not found for selector: ${options.selector || '(empty)'}`);
    }

    if (options.paneMode) {
      await runPaneMode(selected, options.lines);
      return;
    }

    if (!selected.tmuxSessionName) {
      throw new Error('selected session does not have a tmux session name; use `--pane` mode');
    }

    attachOrSwitchSession(selected.tmuxSessionName);
    return;
  }

  if (sub === 'terminate' || sub === 'stop' || sub === 'kill') {
    const options = parseSessionCommandOptions(args.slice(1));
    assertUnsupportedOptions(options, ['paneMode', 'lines'], 'terminate');
    const sessions = await loadManagedSessions(options.includeAll);
    const selected = resolveSessionSelector(sessions, options.selector);

    if (!selected) {
      printSessionList(sessions, options.includeAll);
      if (!options.selector && sessions.length > 1) {
        throw new Error('multiple sessions found; provide a selector (index, channel id, session id, pane id, or tmux session name)');
      }
      throw new Error(`session not found for selector: ${options.selector || '(empty)'}`);
    }

    const result = await terminateSession(selected, options);
    const channelDeleteResult = await deleteManagedChannelForTerminatedSession(selected, 'cli').catch((error) => ({
      deleted: false,
      reason: error instanceof Error ? error.message : String(error),
    }));

    if (result.forced) {
      console.log(`[codex-everywhere] force-terminated session ${selected.sessionId}`);
      if (channelDeleteResult.deleted) {
        console.log(`[codex-everywhere] deleted channel ${selected.channelId}`);
      } else if (channelDeleteResult.reason && channelDeleteResult.reason !== 'not_managed_channel') {
        console.warn(`[codex-everywhere] warning: channel delete failed (${channelDeleteResult.reason})`);
      }
      return;
    }
    console.log(`[codex-everywhere] graceful termination requested for session ${selected.sessionId}`);
    if (channelDeleteResult.deleted) {
      console.log(`[codex-everywhere] deleted channel ${selected.channelId}`);
    } else if (channelDeleteResult.reason && channelDeleteResult.reason !== 'not_managed_channel') {
      console.warn(`[codex-everywhere] warning: channel delete failed (${channelDeleteResult.reason})`);
    }
    return;
  }

  throw new Error('unknown sessions command. Use `sessions list`, `sessions attach`, or `sessions terminate`');
}

async function notifyWithRetry(event, payload, options = {}) {
  const attempts = Math.max(1, Number.parseInt(String(options.attempts ?? 3), 10) || 3);
  const baseDelayMs = Math.max(100, Number.parseInt(String(options.baseDelayMs ?? 700), 10) || 700);
  const projectPath = payload.projectPath || process.cwd();
  const logPath = resolveFromCwd(projectPath, '.omx', 'logs', todayFileName('codex-everywhere-notify'));

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

async function runSession(codexArgs) {
  if (!codexInstalled()) {
    throw new Error('codex binary not found. Install with: npm i -g @openai/codex');
  }

  if (!isTmuxAvailable()) {
    throw new Error('tmux is required. Please install tmux first.');
  }

  const config = loadAppConfig();
  ensureDiscordConfigured(config);

  const daemonResult = await startDaemon();
  if (!daemonResult.success) {
    throw new Error(`reply daemon start failed: ${daemonResult.message}`);
  }

  const cwd = process.cwd();
  const sessionId = randomUUID();
  let channelId = String(config.discordBot.channelId || '').trim();
  let provisionedByChannel = false;
  let channelName = '';
  let provisionedGuildId = '';
  let autoChannelNamePending = false;

  const provisionResult = await provisionSessionChannelForCli(config, cwd);
  if (provisionResult.success) {
    channelId = provisionResult.channelId;
    channelName = provisionResult.channelName;
    provisionedGuildId = provisionResult.guildId;
    provisionedByChannel = true;
    autoChannelNamePending = true;
  } else if (provisionResult.reason !== 'provisioning_disabled') {
    console.warn(
      `[codex-everywhere] warning: session channel provisioning failed (${provisionResult.reason}); using control channel`,
    );
  }

  const runnerCommand = buildRunnerCommand(sessionId, cwd, channelId, codexArgs);

  let tmuxSessionName = '';
  let paneId = '';

  try {
    if (process.env.TMUX) {
      const windowName = `ce-${projectNameFromCwd(cwd)}`;
      const created = createWindowInCurrentSession(windowName, cwd, runnerCommand);
      tmuxSessionName = created.sessionName;
      paneId = created.paneId;
      if (process.stdin.isTTY && process.stdout.isTTY) {
        selectWindow(created.windowId);
      }
    } else {
      const sessionName = `ce-${projectNameFromCwd(cwd)}-${Date.now().toString(36).slice(-4)}`;
      const created = createDetachedSession(sessionName, cwd, runnerCommand);
      tmuxSessionName = created.sessionName;
      paneId = created.paneId;
    }
  } catch (error) {
    if (provisionedByChannel && channelId) {
      await deleteDiscordChannel(
        config.discordBot,
        channelId,
        'codex-everywhere:cleanup:tmux-start-failed',
      ).catch(() => {});
    }
    throw error;
  }

  await upsertActiveSession({
    sessionId,
    paneId,
    tmuxSessionName,
    channelId,
    channelName,
    channelRoutingKey: `discord:${channelId}`,
    autoChannelNamePending,
    provisionedByChannel,
    projectPath: cwd,
    startedAt: new Date().toISOString(),
  });

  const startNotifyResult = await notifyWithRetry('session-start', {
    sessionId,
    paneId,
    tmuxSessionName,
    channelId,
    projectPath: cwd,
  }, { attempts: 4, baseDelayMs: 800 });

  if (!startNotifyResult.success) {
    console.warn(
      `[codex-everywhere] warning: session-start notification failed after retries (${startNotifyResult.error || 'unknown_error'})`,
    );
  }

  const controlChannelId = String(config.discordBot.channelId || '').trim();
  if (
    provisionedByChannel &&
    provisionedGuildId &&
    controlChannelId &&
    controlChannelId !== channelId
  ) {
    const channelLink = `https://discord.com/channels/${provisionedGuildId}/${channelId}`;
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content: [
        config.debug === true
          ? `Started session \`${sessionId}\` in <#${channelId}>.`
          : `Started a new session in <#${channelId}>.`,
        `Directory: \`${cwd}\``,
        `Open channel: ${channelLink}`,
      ].join('\n'),
    }).catch(() => {});
  }

  if (process.env.TMUX) {
    console.log(`[codex-everywhere] started in tmux session ${tmuxSessionName}, pane ${paneId}`);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`[codex-everywhere] started in tmux session ${tmuxSessionName}, pane ${paneId}`);
    console.log(`[codex-everywhere] attach manually with: tmux attach-session -t ${tmuxSessionName}`);
    return;
  }

  attachSession(tmuxSessionName);
}

function parseDaemonCommandOptions(args) {
  const command = String(args[0] || 'status').trim().toLowerCase();
  let debug;

  for (let idx = 1; idx < args.length; idx += 1) {
    const token = String(args[idx] || '').trim();
    if (token === '--debug') {
      debug = true;
      continue;
    }
    if (token === '--no-debug') {
      debug = false;
      continue;
    }
    throw new Error(`unknown daemon option: ${token}`);
  }

  if (typeof debug === 'boolean' && command !== 'start' && command !== 'restart') {
    throw new Error('`--debug` and `--no-debug` are only supported with `daemon start|restart`');
  }

  return { command, debug };
}

async function handleDaemonCommand(args) {
  const { command, debug } = parseDaemonCommandOptions(args);

  if (command === 'start') {
    const result = await startDaemon({ debug });
    console.log(result.message);
    process.exit(result.success ? 0 : 1);
  }

  if (command === 'restart') {
    const stopResult = await stopDaemon();
    console.log(stopResult.message);
    if (!stopResult.success) {
      process.exit(1);
    }

    const startResult = await startDaemon({ debug });
    console.log(startResult.message);
    process.exit(startResult.success ? 0 : 1);
  }

  if (command === 'stop') {
    const result = await stopDaemon();
    console.log(result.message);
    process.exit(result.success ? 0 : 1);
  }

  if (command === 'status') {
    const status = await daemonStatus();
    console.log(JSON.stringify(status, null, 2));
    process.exit(0);
  }

  throw new Error('unknown daemon command. Use start|restart|stop|status');
}

async function handleSetupCommand(args) {
  const sub = String(args[0] || '').trim().toLowerCase();
  if (!sub || sub === 'discord') {
    await runDiscordSetupCommand(args.slice(sub ? 1 : 0));
    return;
  }
  if (sub === 'bootstrap' || sub === 'auto') {
    await runBootstrapSetupCommand(args.slice(1));
    return;
  }
  throw new Error('unknown setup command. Use `setup discord` or `setup bootstrap`');
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    await runSession([]);
    return;
  }

  const first = argv[0];
  if (first === '--help' || first === '-h' || first === 'help') {
    console.log(HELP);
    return;
  }

  if (first === 'daemon') {
    await handleDaemonCommand(argv.slice(1));
    return;
  }

  if (first === 'setup') {
    await handleSetupCommand(argv.slice(1));
    return;
  }

  if (first === 'sessions' || first === 'session') {
    await handleSessionsCommand(argv.slice(1));
    return;
  }

  await runSession(argv);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-everywhere] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
