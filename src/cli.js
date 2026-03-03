#!/usr/bin/env node

import { randomUUID } from 'crypto';
import { basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadAppConfig } from './config.js';
import { notifyEvent } from './notify.js';
import { startDaemon, stopDaemon, daemonStatus } from './reply-daemon.js';
import { pruneActiveSessions, upsertActiveSession } from './active-sessions.js';
import {
  attachSession,
  capturePane,
  createDetachedSession,
  createWindowInCurrentSession,
  isTmuxAvailable,
  listPaneIds,
  selectWindow,
  sanitizeName,
  switchClientSession,
} from './tmux.js';
import { appendJsonl, resolveFromCwd, shellEscape, sleep, todayFileName } from './utils.js';

const HELP = `codex-everywhere

Usage:
  codex-everywhere [codex args...]
  codex-everywhere daemon <start|stop|status>
  codex-everywhere sessions [list] [--all]
  codex-everywhere sessions attach [selector] [--pane] [--lines <n>] [--all]

Behavior:
  - Starts Codex in tmux
  - Sends Discord bot notifications (OMX-compatible config/env)
  - Accepts Discord replies and injects them into the Codex pane
  - Forwards Codex approval prompts through Discord and injects decisions
  - Lists and opens tmux sessions that were created from Discord channels
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

function ensureDiscordConfigured(config) {
  if (!config.notificationsEnabled || !config.discordBot.enabled) {
    throw new Error(
      'Discord bot notification config missing. Set OMX_DISCORD_NOTIFIER_BOT_TOKEN and OMX_DISCORD_NOTIFIER_CHANNEL, or configure ~/.codex/.omx-config.json notifications["discord-bot"].',
    );
  }
}

function isProvisionedDiscordSession(session) {
  return session?.provisionedByChannel === true;
}

async function loadManagedSessions(includeAll = false) {
  const sessions = await pruneActiveSessions(listPaneIds());
  const filtered = includeAll ? sessions : sessions.filter(isProvisionedDiscordSession);
  return filtered.sort((a, b) => {
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
    if (token === '--lines') {
      const value = Number.parseInt(String(args[idx + 1] || ''), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('`--lines` must be a positive integer');
      }
      parsed.lines = value;
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
  if (sessions.length === 0) {
    if (includeAll) {
      console.log('[codex-everywhere] no active tmux-backed codex sessions found');
    } else {
      console.log('[codex-everywhere] no Discord-provisioned sessions found (use `--all` to include control-channel sessions)');
    }
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

async function handleSessionsCommand(args) {
  const sub = args[0] || 'list';

  if (sub === 'list') {
    const options = parseSessionCommandOptions(args.slice(1));
    const sessions = await loadManagedSessions(options.includeAll);
    printSessionList(sessions, options.includeAll);
    return;
  }

  if (sub === 'attach') {
    const options = parseSessionCommandOptions(args.slice(1));
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

  throw new Error('unknown sessions command. Use `sessions list` or `sessions attach`');
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
  const channelId = config.discordBot.channelId;
  const runnerCommand = buildRunnerCommand(sessionId, cwd, channelId, codexArgs);

  let tmuxSessionName = '';
  let paneId = '';

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

  await upsertActiveSession({
    sessionId,
    paneId,
    tmuxSessionName,
    channelId,
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

async function handleDaemonCommand(command) {
  if (command === 'start') {
    const result = await startDaemon();
    console.log(result.message);
    process.exit(result.success ? 0 : 1);
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

  throw new Error('unknown daemon command. Use start|stop|status');
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
    await handleDaemonCommand(argv[1] || 'status');
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
