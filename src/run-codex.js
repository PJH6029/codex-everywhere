#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { removeActiveSession } from './active-sessions.js';
import { notifyEvent } from './notify.js';
import { appendJsonl, resolveFromCwd, sleep, todayFileName } from './utils.js';

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    sessionId: '',
    cwd: process.cwd(),
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

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const sessionId = parsed.sessionId || process.env.CODEX_EVERYWHERE_SESSION_ID || 'unknown-session';
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
    },
  });

  child.on('exit', async (code, signal) => {
    await removeActiveSession(sessionId).catch(() => {});

    const reason = signal ? `signal:${signal}` : `exit:${code ?? 0}`;
    await notifyWithRetry('session-end', {
      sessionId,
      paneId: process.env.TMUX_PANE || '',
      tmuxSessionName: process.env.CODEX_EVERYWHERE_TMUX_SESSION || '',
      projectPath: parsed.cwd,
      reason,
    }, { attempts: 3, baseDelayMs: 600 });

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', async (error) => {
    await removeActiveSession(sessionId).catch(() => {});
    console.error(`[codex-everywhere] failed to start codex: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(`[codex-everywhere] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
