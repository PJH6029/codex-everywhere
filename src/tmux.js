import { execFileSync, spawnSync } from 'child_process';

function runTmux(args, options = {}) {
  const timeout =
    options.timeout === undefined || options.timeout === null
      ? 5000
      : options.timeout;

  const result = spawnSync('tmux', args, {
    encoding: 'utf-8',
    stdio: options.stdio || ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: options.env,
    timeout,
  });

  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function blockMs(ms) {
  const duration = Math.max(0, Math.trunc(ms));
  if (duration <= 0) return;
  try {
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, duration);
  } catch {
    // Best effort: skip delay if Atomics.wait is unavailable.
  }
}

export function isTmuxAvailable() {
  const result = runTmux(['-V'], { timeout: 3000 });
  return result.ok;
}

export function sanitizeName(value, fallback = 'codex-everywhere') {
  const sanitized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return sanitized || fallback;
}

export function createDetachedSession(sessionName, cwd, command) {
  const result = runTmux([
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{session_name}|#{pane_id}',
    '-s',
    sessionName,
    '-c',
    cwd,
    command,
  ]);

  if (!result.ok) {
    throw new Error(`tmux new-session failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  }

  const [resolvedSessionName, paneId] = result.stdout.trim().split('|');
  return {
    sessionName: resolvedSessionName || sessionName,
    paneId,
  };
}

export function createWindowInCurrentSession(windowName, cwd, command) {
  const result = runTmux([
    'new-window',
    '-P',
    '-F',
    '#{session_name}|#{window_id}|#{pane_id}',
    '-n',
    windowName,
    '-c',
    cwd,
    command,
  ]);

  if (!result.ok) {
    throw new Error(`tmux new-window failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  }

  const [sessionName, windowId, paneId] = result.stdout.trim().split('|');
  return {
    sessionName,
    windowId,
    paneId,
  };
}

export function selectWindow(windowTarget) {
  if (!windowTarget) return false;
  const result = runTmux(['select-window', '-t', String(windowTarget)], {
    timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.ok;
}

export function attachSession(sessionName) {
  const result = runTmux(['attach-session', '-t', sessionName], { stdio: 'inherit', timeout: 0 });
  if (!result.ok) {
    throw new Error(`tmux attach failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
}

export function switchClientSession(sessionName) {
  const result = runTmux(['switch-client', '-t', sessionName], {
    timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.ok;
}

export function killSession(sessionName) {
  if (!sessionName) return false;
  const result = runTmux(['kill-session', '-t', String(sessionName)], {
    timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.ok;
}

export function killPane(paneId) {
  if (!paneId || !/^%\d+$/.test(String(paneId))) return false;
  const result = runTmux(['kill-pane', '-t', String(paneId)], {
    timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.ok;
}

export function capturePane(paneId, lines = 80) {
  if (!paneId || !/^%\d+$/.test(String(paneId))) return '';

  try {
    return execFileSync('tmux', ['capture-pane', '-t', String(paneId), '-p', '-S', `-${Math.max(1, lines)}`], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

export function sendLiteralToPane(paneId, text, pressEnter = true, enterCount = 1) {
  if (!paneId || !/^%\d+$/.test(String(paneId))) return false;

  const safe = String(text ?? '').replace(/\r?\n/g, ' ');
  const send = runTmux(['send-keys', '-t', String(paneId), '-l', '--', safe]);
  if (!send.ok) return false;

  if (pressEnter) {
    // Codex TUI can miss immediate submit keys right after literal injection.
    blockMs(120);
    const repeats = Math.max(1, Math.trunc(enterCount));
    for (let i = 0; i < repeats; i += 1) {
      const enter = runTmux(['send-keys', '-t', String(paneId), 'Enter']);
      if (!enter.ok) return false;
      if (i + 1 < repeats) blockMs(40);
    }
  }

  return true;
}

export function sendKeyToPane(paneId, key) {
  if (!paneId || !/^%\d+$/.test(String(paneId))) return false;
  const result = runTmux(['send-keys', '-t', String(paneId), key]);
  return result.ok;
}

export function listPaneIds() {
  const result = runTmux(['list-panes', '-a', '-F', '#{pane_id}'], {
    timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!result.ok) return new Set();
  const ids = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^%\d+$/.test(line));
  return new Set(ids);
}
