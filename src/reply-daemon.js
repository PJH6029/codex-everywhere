#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import {
  DAEMON_LOCK_PATH,
  DAEMON_PID_PATH,
  DAEMON_STATE_PATH,
  GLOBAL_STATE_DIR,
} from './constants.js';
import { loadAppConfig } from './config.js';
import { addReaction, fetchChannelMessages, sendDiscordMessage } from './discord.js';
import { pruneActiveSessions } from './active-sessions.js';
import { lookupMessageMapping, pruneOldMappings } from './registry.js';
import { capturePane, isTmuxAvailable, listPaneIds, sendLiteralToPane } from './tmux.js';
import { notifyEvent } from './notify.js';
import {
  clampInt,
  ensureDir,
  normalizeMultiline,
  nowIso,
  sleep,
  truncate,
  writeJsonAtomic,
  readJson,
} from './utils.js';

const DEFAULT_STATE = {
  isRunning: false,
  pid: null,
  startedAt: null,
  lastPollAt: null,
  discordLastMessageId: null,
  messagesInjected: 0,
  processedReplyMessageIds: [],
  approvalsNotified: 0,
  errors: 0,
  lastError: '',
  lastApprovalBySession: {},
};

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const REPLY_DAEMON_SCRIPT_PATH = fileURLToPath(import.meta.url);
const OMX_REPLY_LISTENER_PATTERNS = [
  'oh-my-codex/dist/notifications/reply-listener.js',
  'dist/notifications/reply-listener.js',
];

function readPid() {
  if (!existsSync(DAEMON_PID_PATH)) return null;
  const parsed = Number.parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function writePid(pid) {
  ensureDir(GLOBAL_STATE_DIR).catch(() => {});
  writeFileSync(DAEMON_PID_PATH, `${pid}\n`, { mode: 0o600 });
}

function removePid() {
  if (existsSync(DAEMON_PID_PATH)) {
    try {
      unlinkSync(DAEMON_PID_PATH);
    } catch {
      // Best effort
    }
  }
}

function readLockPid() {
  if (!existsSync(DAEMON_LOCK_PATH)) return null;
  const parsed = Number.parseInt(readFileSync(DAEMON_LOCK_PATH, 'utf-8').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function removeLock() {
  if (existsSync(DAEMON_LOCK_PATH)) {
    try {
      unlinkSync(DAEMON_LOCK_PATH);
    } catch {
      // Best effort
    }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listReplyDaemonPids() {
  const result = spawnSync('ps', ['-ax', '-o', 'pid=,args='], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) return null;

      const pid = Number.parseInt(match[1], 10);
      const args = match[2] || '';

      if (!Number.isFinite(pid)) return null;
      if (!args.includes(REPLY_DAEMON_SCRIPT_PATH)) return null;
      if (!/\srun(\s|$)/.test(args)) return null;

      return pid;
    })
    .filter((pid) => Number.isFinite(pid));
}

function listConflictingReplyListenerPids() {
  const result = spawnSync('ps', ['-ax', '-o', 'pid=,args='], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) return null;

      const pid = Number.parseInt(match[1], 10);
      const args = match[2] || '';
      if (!Number.isFinite(pid)) return null;
      if (pid === process.pid) return null;
      if (args.includes(REPLY_DAEMON_SCRIPT_PATH) && /\srun(\s|$)/.test(args)) return null;

      const lowerArgs = args.toLowerCase();
      if (!/\bnode(\s|$)/.test(lowerArgs)) return null;
      const isConflict = OMX_REPLY_LISTENER_PATTERNS.some((pattern) => lowerArgs.includes(pattern.toLowerCase()));
      return isConflict ? pid : null;
    })
    .filter((pid) => Number.isFinite(pid));
}

function isReplyDaemonProcess(pid) {
  return listReplyDaemonPids().includes(pid);
}

function tryAcquireLock() {
  const lockPid = readLockPid();
  if (lockPid && lockPid !== process.pid && isProcessAlive(lockPid) && isReplyDaemonProcess(lockPid)) {
    return false;
  }

  if (lockPid && (!isProcessAlive(lockPid) || !isReplyDaemonProcess(lockPid))) {
    removeLock();
  }

  try {
    writeFileSync(DAEMON_LOCK_PATH, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const currentLockPid = readLockPid();
      if (
        currentLockPid &&
        currentLockPid !== process.pid &&
        isProcessAlive(currentLockPid) &&
        isReplyDaemonProcess(currentLockPid)
      ) {
        return false;
      }

      removeLock();

      try {
        writeFileSync(DAEMON_LOCK_PATH, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function releaseLock() {
  const lockPid = readLockPid();
  if (!lockPid || lockPid === process.pid || !isProcessAlive(lockPid) || !isReplyDaemonProcess(lockPid)) {
    removeLock();
  }
}

export async function isDaemonRunning() {
  const pid = readPid();
  if (pid && isProcessAlive(pid) && isReplyDaemonProcess(pid)) {
    return true;
  }

  const livePids = listReplyDaemonPids().filter((candidate) => candidate !== process.pid && isProcessAlive(candidate));
  if (livePids.length === 0) {
    removePid();
    releaseLock();
    return false;
  }

  writePid(livePids[0]);
  return true;
}

export async function daemonStatus() {
  const state = await readJson(DAEMON_STATE_PATH, DEFAULT_STATE);
  return {
    running: await isDaemonRunning(),
    conflictingListeners: listConflictingReplyListenerPids(),
    state,
  };
}

export async function startDaemon() {
  const conflicts = listConflictingReplyListenerPids();
  if (conflicts.length > 0) {
    return {
      success: false,
      message:
        `conflicting OMX reply listener detected (pid: ${conflicts.join(', ')}). ` +
        "Stop it first: pkill -f 'oh-my-codex/dist/notifications/reply-listener.js'",
    };
  }

  const runningPids = listReplyDaemonPids().filter((candidate) => candidate !== process.pid && isProcessAlive(candidate));
  if (runningPids.length > 0) {
    writePid(runningPids[0]);
    return { success: true, message: `reply daemon already running (pid ${runningPids[0]})` };
  }

  if (!isTmuxAvailable()) {
    return { success: false, message: 'tmux is required for reply injection' };
  }

  await ensureDir(GLOBAL_STATE_DIR);

  const modulePath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [modulePath, 'run'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_EVERYWHERE_DAEMON: '1',
    },
  });

  child.unref();

  if (!child.pid) {
    return { success: false, message: 'failed to spawn daemon process' };
  }

  writePid(child.pid);

  await writeJsonAtomic(DAEMON_STATE_PATH, {
    ...DEFAULT_STATE,
    isRunning: true,
    pid: child.pid,
    startedAt: nowIso(),
  });

  return { success: true, message: `reply daemon started (pid ${child.pid})` };
}

export async function stopDaemon() {
  const daemonPids = new Set(listReplyDaemonPids().filter((candidate) => candidate !== process.pid));
  const pidFromFile = readPid();
  if (pidFromFile && isProcessAlive(pidFromFile) && isReplyDaemonProcess(pidFromFile)) {
    daemonPids.add(pidFromFile);
  }

  if (daemonPids.size === 0) {
    removePid();
    releaseLock();
    return { success: true, message: 'reply daemon is not running' };
  }

  for (const pid of daemonPids) {
    if (!isProcessAlive(pid)) continue;
    if (!isReplyDaemonProcess(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Best effort
    }
  }

  await sleep(250);

  for (const pid of daemonPids) {
    if (!isProcessAlive(pid)) continue;
    if (!isReplyDaemonProcess(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Best effort
    }
  }

  removePid();
  releaseLock();

  const state = await readJson(DAEMON_STATE_PATH, DEFAULT_STATE);
  await writeJsonAtomic(DAEMON_STATE_PATH, {
    ...state,
    isRunning: false,
    pid: null,
  });

  return { success: true, message: `reply daemon stopped (${Array.from(daemonPids).join(', ')})` };
}

function sanitizeReplyInput(text) {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\(/g, '\\$(')
    .replace(/\$\{/g, '\\${')
    .trim();
}

class RateLimiter {
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this.windowMs = 60000;
    this.timestamps = [];
  }

  canProceed() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((ts) => now - ts < this.windowMs);
    if (this.timestamps.length >= this.maxPerMinute) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
}

function parseApprovalDecision(text) {
  const lowered = String(text ?? '').trim().toLowerCase();
  if (/^(y|yes|approve|allow|1)\b/.test(lowered)) {
    return { key: '1', label: 'approve_once' };
  }
  if (/^(p|persist|always|allow\s+all|2)\b/.test(lowered)) {
    return { key: '2', label: 'approve_prefix' };
  }
  if (/^(n|no|deny|reject|3)\b/.test(lowered)) {
    return { key: '3', label: 'deny' };
  }
  return null;
}

function detectApprovalPrompt(content) {
  const normalized = String(content || '');
  if (!normalized) return null;

  const lower = normalized.toLowerCase();
  const hasPrompt =
    lower.includes('would you like to run the following command?') ||
    lower.includes('press enter to confirm or esc to cancel');

  if (!hasPrompt) return null;

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const commandLine = lines.find((line) => line.startsWith('$ '));
  const command = commandLine ? commandLine.slice(2).trim() : '';
  const snippet = truncate(lines.slice(-8).join(' | '), 500);

  const signature = createHash('sha256')
    .update(`${command}\n${snippet}`)
    .digest('hex')
    .slice(0, 16);

  return {
    command,
    signature,
    snippet,
  };
}

function hasBotCheckReaction(message) {
  const reactions = Array.isArray(message?.reactions) ? message.reactions : [];
  return reactions.some((reaction) => {
    if (!reaction || reaction.me !== true) return false;
    const emojiName = String(reaction?.emoji?.name || '');
    return emojiName === '✅' || emojiName === 'white_check_mark';
  });
}

async function injectReplyToPane(mapping, text, config) {
  const prefix = config.reply.includePrefix ? '[reply:discord] ' : '';
  const sanitized = sanitizeReplyInput(`${prefix}${text}`);
  const truncated = truncate(sanitized, config.reply.maxMessageLength);
  return sendLiteralToPane(mapping.tmuxPaneId, truncated, true, 1);
}

async function injectApprovalDecision(mapping, text) {
  const parsed = parseApprovalDecision(text);
  if (!parsed) return { ok: false, reason: 'invalid_decision' };

  const ok = sendLiteralToPane(mapping.tmuxPaneId, parsed.key, true, 1);
  return ok ? { ok: true, decision: parsed.label } : { ok: false, reason: 'tmux_injection_failed' };
}

async function injectDenyFollowup(mapping, config) {
  const message = String(config?.reply?.onDenyMessage || '').trim();
  if (!message) return true;

  await sleep(350);
  return injectReplyToPane(mapping, message, config);
}

async function pollDiscordReplies(config, state, limiter) {
  if (!Array.isArray(state.processedReplyMessageIds)) {
    state.processedReplyMessageIds = [];
  }
  const processed = new Set(state.processedReplyMessageIds);

  const fetchResult = await fetchChannelMessages(config.discordBot, state.discordLastMessageId, 20);
  if (!fetchResult.success) {
    state.errors += 1;
    state.lastError = fetchResult.error || 'discord_fetch_failed';
    return;
  }

  const messages = [...fetchResult.messages].reverse();

  for (const message of messages) {
    state.discordLastMessageId = message.id;
    if (processed.has(message.id)) {
      continue;
    }
    if (hasBotCheckReaction(message)) {
      processed.add(message.id);
      continue;
    }

    const referenceId = message?.message_reference?.message_id;
    if (!referenceId) continue;

    const authorId = String(message?.author?.id || '');
    const isBotMessage = message?.author?.bot === true;
    if (isBotMessage) continue;

    if (!config.reply.authorizedDiscordUserIds.includes(authorId)) {
      continue;
    }

    const mapping = await lookupMessageMapping(referenceId);
    if (!mapping) continue;

    if (!limiter.canProceed()) {
      state.errors += 1;
      state.lastError = 'rate_limited';
      continue;
    }

    let injectResult = { ok: false, reason: 'unknown' };

    if (mapping.kind === 'approval') {
      injectResult = await injectApprovalDecision(mapping, message.content || '');
      if (!injectResult.ok && injectResult.reason === 'invalid_decision') {
        await sendDiscordMessage(config.discordBot, {
          content: 'Approval reply must start with `y`, `p`, or `n`.',
          replyToMessageId: message.id,
        }).catch(() => {});
      }

      if (
        injectResult.ok &&
        injectResult.decision === 'deny' &&
        config.reply.autoContinueOnDeny
      ) {
        const followupOk = await injectDenyFollowup(mapping, config);
        if (!followupOk) {
          state.errors += 1;
          state.lastError = 'tmux_deny_followup_failed';
        }
      }
    } else {
      const ok = await injectReplyToPane(mapping, normalizeMultiline(message.content || ''), config);
      injectResult = ok ? { ok: true } : { ok: false, reason: 'tmux_injection_failed' };
    }

    if (injectResult.ok) {
      state.messagesInjected += 1;
      processed.add(message.id);
      await addReaction(config.discordBot, message.id).catch(() => {});
      const target = mapping.tmuxSessionName
        ? `${mapping.tmuxSessionName} ${mapping.tmuxPaneId}`
        : mapping.tmuxPaneId;
      const action = mapping.kind === 'approval' ? 'Decision injected' : 'Message injected';
      await sendDiscordMessage(config.discordBot, {
        content: `${action} into tmux target \`${target}\`.`,
        replyToMessageId: message.id,
      }).catch(() => {});
    } else {
      state.errors += 1;
      state.lastError = injectResult.reason;
    }
  }

  state.processedReplyMessageIds = Array.from(processed).slice(-200);
}

async function seedDiscordCursorIfNeeded(config, state) {
  if (state.discordLastMessageId) return false;

  const seeded = await fetchChannelMessages(config.discordBot, null, 1);
  if (!seeded.success) {
    state.errors += 1;
    state.lastError = seeded.error || 'discord_seed_failed';
    return false;
  }

  const latest = Array.isArray(seeded.messages) ? seeded.messages[0] : null;
  if (latest?.id) {
    state.discordLastMessageId = latest.id;
  }

  return true;
}

async function scanApprovalPrompts(state) {
  const paneIds = listPaneIds();
  const sessions = await pruneActiveSessions(paneIds);
  const seenSessions = new Set();

  for (const session of sessions) {
    if (!session?.sessionId || !session?.paneId) continue;

    seenSessions.add(session.sessionId);

    const paneContent = capturePane(session.paneId, 90);
    const approval = detectApprovalPrompt(paneContent);

    if (!approval) {
      if (state.lastApprovalBySession[session.sessionId]) {
        delete state.lastApprovalBySession[session.sessionId];
      }
      continue;
    }

    if (state.lastApprovalBySession[session.sessionId] === approval.signature) {
      continue;
    }

    const result = await notifyEvent('approval-request', {
      sessionId: session.sessionId,
      paneId: session.paneId,
      tmuxSessionName: session.tmuxSessionName || '',
      projectPath: session.projectPath || session.cwd,
      command: approval.command || approval.snippet,
    });

    if (result.success) {
      state.approvalsNotified += 1;
      state.lastApprovalBySession[session.sessionId] = approval.signature;
    }
  }

  for (const sessionId of Object.keys(state.lastApprovalBySession)) {
    if (!seenSessions.has(sessionId)) {
      delete state.lastApprovalBySession[sessionId];
    }
  }
}

async function runDaemonLoop() {
  await ensureDir(GLOBAL_STATE_DIR);
  if (!tryAcquireLock()) {
    return;
  }

  const conflicts = listConflictingReplyListenerPids();
  if (conflicts.length > 0) {
    releaseLock();
    return;
  }

  const state = {
    ...DEFAULT_STATE,
    ...(await readJson(DAEMON_STATE_PATH, DEFAULT_STATE)),
  };

  state.isRunning = true;
  state.pid = process.pid;
  state.startedAt = state.startedAt || nowIso();

  let lastPruneAt = 0;
  let stopRequested = false;
  let limiter = new RateLimiter(10);

  const shutdown = async () => {
    stopRequested = true;
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  while (!stopRequested) {
    const config = loadAppConfig();

    state.lastPollAt = nowIso();

    try {
      if (
        config.notificationsEnabled &&
        config.discordBot.enabled &&
        config.reply.enabled &&
        config.reply.authorizedDiscordUserIds.length > 0
      ) {
        const configuredLimit = clampInt(config.reply.rateLimitPerMinute, 10, 1, 120);
        if (limiter.maxPerMinute !== configuredLimit) {
          limiter = new RateLimiter(configuredLimit);
        }
        const seeded = await seedDiscordCursorIfNeeded(config, state);
        if (!seeded) {
          await pollDiscordReplies(config, state, limiter);
        }
      }

      if (config.notificationsEnabled && config.discordBot.enabled) {
        await scanApprovalPrompts(state);
      }

      if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
        await pruneOldMappings().catch(() => {});
        lastPruneAt = Date.now();
      }
    } catch (error) {
      state.errors += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
    }

    await writeJsonAtomic(DAEMON_STATE_PATH, state).catch(() => {});

    const delay = config.reply.enabled
      ? clampInt(config.reply.pollIntervalMs, 3000, 500, 60000)
      : 3000;

    await sleep(delay);
  }

  state.isRunning = false;
  state.pid = null;
  await writeJsonAtomic(DAEMON_STATE_PATH, state).catch(() => {});
  removePid();
  releaseLock();
}

async function main() {
  const command = process.argv[2] || 'status';

  if (command === 'run') {
    await runDaemonLoop();
    return;
  }

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

  console.error('Usage: reply-daemon.js [start|stop|status|run]');
  process.exit(1);
}

if (process.env.CODEX_EVERYWHERE_DAEMON === '1' || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-everywhere] daemon error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
