#!/usr/bin/env node

import { randomUUID } from 'crypto';
import { basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadAppConfig } from './config.js';
import { notifyEvent } from './notify.js';
import { startDaemon, stopDaemon, daemonStatus } from './reply-daemon.js';
import { upsertActiveSession } from './active-sessions.js';
import {
  attachSession,
  createDetachedSession,
  createWindowInCurrentSession,
  isTmuxAvailable,
  selectWindow,
  sanitizeName,
} from './tmux.js';
import { appendJsonl, resolveFromCwd, shellEscape, sleep, todayFileName } from './utils.js';

const HELP = `codex-everywhere

Usage:
  codex-everywhere [codex args...]
  codex-everywhere daemon <start|stop|status>

Behavior:
  - Starts Codex in tmux
  - Sends Discord bot notifications (OMX-compatible config/env)
  - Accepts Discord replies and injects them into the Codex pane
  - Forwards Codex approval prompts through Discord and injects decisions
`;

function codexInstalled() {
  const result = spawnSync('codex', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return !result.error && result.status === 0;
}

function buildRunnerCommand(sessionId, cwd, passthroughArgs = []) {
  const runCodexPath = fileURLToPath(new URL('./run-codex.js', import.meta.url));

  const tokens = [
    'node',
    runCodexPath,
    '--session-id',
    sessionId,
    '--cwd',
    cwd,
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
  const runnerCommand = buildRunnerCommand(sessionId, cwd, codexArgs);

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
    projectPath: cwd,
    startedAt: new Date().toISOString(),
  });

  const startNotifyResult = await notifyWithRetry('session-start', {
    sessionId,
    paneId,
    tmuxSessionName,
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

  await runSession(argv);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-everywhere] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
