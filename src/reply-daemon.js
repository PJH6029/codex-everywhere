#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { stat } from 'fs/promises';
import { spawn, spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  DAEMON_LOCK_PATH,
  DAEMON_PID_PATH,
  DAEMON_STATE_PATH,
  GLOBAL_STATE_DIR,
} from './constants.js';
import { loadAppConfig } from './config.js';
import {
  addReaction,
  createGuildTextChannel,
  deleteDiscordChannel,
  fetchChannelMessages,
  getDiscordChannel,
  listGuildTextChannels,
  sendDiscordMessage,
} from './discord.js';
import {
  pruneActiveSessions,
  removeActiveSession,
  upsertActiveSession,
} from './active-sessions.js';
import { lookupMessageMapping, pruneOldMappings } from './registry.js';
import {
  capturePane,
  createDetachedSession,
  isTmuxAvailable,
  killPane,
  killSession,
  listPaneIds,
  sanitizeName,
  sendLiteralToPane,
} from './tmux.js';
import { notifyEvent } from './notify.js';
import {
  clampInt,
  ensureDir,
  normalizeMultiline,
  nowIso,
  parseBoolean,
  shellEscape,
  sleep,
  summarizeProject,
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
  discordLastMessageByChannel: {},
  messagesInjected: 0,
  processedReplyMessageIds: [],
  processedReplyMessageIdsByChannel: {},
  provisionGuildId: '',
  provisionKnownChannelIds: [],
  lastProvisionScanAt: null,
  approvalsNotified: 0,
  errors: 0,
  lastError: '',
  lastApprovalBySession: {},
  debug: false,
};

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const REPLY_DAEMON_SCRIPT_PATH = fileURLToPath(import.meta.url);
const RUN_CODEX_SCRIPT_PATH = fileURLToPath(new URL('./run-codex.js', import.meta.url));
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

function resolveDaemonDebugValue(options = {}, fallback = false) {
  if (typeof options?.debug === 'boolean') {
    return options.debug;
  }

  if (typeof process.env.OMX_CE_DEBUG === 'string') {
    return parseBoolean(process.env.OMX_CE_DEBUG, fallback);
  }

  if (typeof process.env.CODEX_EVERYWHERE_DEBUG === 'string') {
    return parseBoolean(process.env.CODEX_EVERYWHERE_DEBUG, fallback);
  }

  return fallback;
}

export async function startDaemon(options = {}) {
  const priorState = await readJson(DAEMON_STATE_PATH, DEFAULT_STATE);
  const debug = resolveDaemonDebugValue(options, priorState?.debug === true);

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
    if (typeof options?.debug === 'boolean') {
      await writeJsonAtomic(DAEMON_STATE_PATH, {
        ...DEFAULT_STATE,
        ...priorState,
        isRunning: true,
        pid: runningPids[0],
        startedAt: priorState?.startedAt || nowIso(),
        debug,
      });
    }
    return { success: true, message: `reply daemon already running (pid ${runningPids[0]}, debug ${debug ? 'on' : 'off'})` };
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
      CODEX_EVERYWHERE_DEBUG: debug ? '1' : '0',
    },
  });

  child.unref();

  if (!child.pid) {
    return { success: false, message: 'failed to spawn daemon process' };
  }

  writePid(child.pid);

  await writeJsonAtomic(DAEMON_STATE_PATH, {
    ...DEFAULT_STATE,
    ...priorState,
    isRunning: true,
    pid: child.pid,
    startedAt: nowIso(),
    debug,
  });

  return { success: true, message: `reply daemon started (pid ${child.pid}, debug ${debug ? 'on' : 'off'})` };
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

const TERMINATE_MESSAGE_COMMANDS = new Set([
  '!ce-exit',
  '!ce-terminate',
  '!codex-exit',
  '!codex-terminate',
  '/exit',
]);
const CREATE_SESSION_MESSAGE_COMMANDS = new Set([
  '!ce-new',
  '!ce-create',
  '!codex-new',
]);

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

function parseLifecycleCommand(text) {
  const normalized = String(text || '')
    .replace(/^(?:<@!?\d{17,20}>\s*)+/g, '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (TERMINATE_MESSAGE_COMMANDS.has(normalized)) {
    return { kind: 'terminate-session' };
  }
  return null;
}

function splitCommandTokens(text) {
  const source = String(text || '');
  const matches = source.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const quotedWithDouble = token.startsWith('"') && token.endsWith('"') && token.length >= 2;
      const quotedWithSingle = token.startsWith('\'') && token.endsWith('\'') && token.length >= 2;
      if (quotedWithDouble || quotedWithSingle) {
        return token.slice(1, -1);
      }
      return token;
    });
}

function parseCreateSessionCommand(text) {
  const normalized = String(text || '')
    .replace(/^(?:<@!?\d{17,20}>\s*)+/g, '')
    .trim();
  if (!normalized) return null;

  const tokens = splitCommandTokens(normalized);
  if (tokens.length === 0) return null;

  const head = String(tokens[0] || '').toLowerCase();
  if (!CREATE_SESSION_MESSAGE_COMMANDS.has(head)) {
    return null;
  }

  let cwd = '';
  let name = '';
  const nameParts = [];

  for (let idx = 1; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (token === '--cwd') {
      cwd = String(tokens[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length).trim();
      continue;
    }
    if (token === '--name') {
      name = String(tokens[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token.startsWith('--name=')) {
      name = token.slice('--name='.length).trim();
      continue;
    }
    if (token.startsWith('--')) {
      return {
        kind: 'create-session',
        error: `unknown_option:${token}`,
      };
    }
    nameParts.push(token);
  }

  if (!name && nameParts.length > 0) {
    name = nameParts.join('-');
  }

  return {
    kind: 'create-session',
    cwd,
    name,
  };
}

function extractUserMessageContent(message) {
  return normalizeMultiline(String(message?.content || ''));
}

function resolveRequestedCwd(requestedCwd) {
  const input = String(requestedCwd || '').trim();
  if (!input) {
    return process.cwd();
  }
  if (input.startsWith('~/')) {
    const home = process.env.HOME || '';
    if (home) {
      return resolve(home, input.slice(2));
    }
  }
  return resolve(process.cwd(), input);
}

async function validateCwdDirectory(path) {
  try {
    const fileStat = await stat(path);
    return fileStat.isDirectory();
  } catch {
    return false;
  }
}

function inferProvisionedChannelName(cwdPath, requestedName, config) {
  const prefix = String(config?.discordProvisioning?.channelPrefix || 'codex-').trim().toLowerCase() || 'codex-';
  const requested = String(requestedName || '').trim();
  const base = requested || basename(cwdPath || process.cwd()) || 'session';
  const slug = sanitizeName(base, 'session');
  if (slug.startsWith(prefix)) {
    return slug.slice(0, 95);
  }
  return `${prefix}${slug}`.slice(0, 95);
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

function getChannelCursorMap(state) {
  if (!state.discordLastMessageByChannel || typeof state.discordLastMessageByChannel !== 'object') {
    state.discordLastMessageByChannel = {};
  }
  return state.discordLastMessageByChannel;
}

function getProcessedByChannelMap(state) {
  if (!state.processedReplyMessageIdsByChannel || typeof state.processedReplyMessageIdsByChannel !== 'object') {
    state.processedReplyMessageIdsByChannel = {};
  }
  return state.processedReplyMessageIdsByChannel;
}

function getProcessedSetForChannel(state, channelId) {
  const map = getProcessedByChannelMap(state);
  const current = map[channelId];
  if (!Array.isArray(current)) {
    map[channelId] = [];
    return new Set();
  }
  return new Set(current);
}

function setProcessedSetForChannel(state, channelId, processed) {
  const map = getProcessedByChannelMap(state);
  map[channelId] = Array.from(processed).slice(-200);
}

function buildRunnerCommand(sessionId, cwd, channelId) {
  const tokens = [
    'node',
    RUN_CODEX_SCRIPT_PATH,
    '--session-id',
    sessionId,
    '--cwd',
    cwd,
    '--channel-id',
    channelId,
    '--',
  ];
  return tokens.map((token) => shellEscape(token)).join(' ');
}

function matchesProvisionFilters(channel, config) {
  if (!channel || typeof channel !== 'object') return false;
  const id = String(channel.id || '');
  if (!id) return false;

  if (id === config.discordBot.channelId) return false;

  const name = String(channel.name || '').toLowerCase();
  const prefix = String(config.discordProvisioning.channelPrefix || '').trim().toLowerCase();
  if (prefix && !name.startsWith(prefix)) return false;

  const categoryId = String(config.discordProvisioning.categoryId || '').trim();
  if (categoryId) {
    const parentId = String(channel.parent_id || '');
    if (parentId !== categoryId) return false;
  }

  return true;
}

function activeSessionByChannelId(sessions, channelId) {
  const target = String(channelId || '');
  if (!target) return null;
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    if (String(sessions[i]?.channelId || '') === target) {
      return sessions[i];
    }
  }
  return null;
}

async function launchProvisionedSession(channel, config, options = {}) {
  const channelId = String(channel.id || '');
  const cwd = String(options.cwd || process.cwd());
  const sessionId = randomUUID();
  const project = sanitizeName(summarizeProject(cwd), 'project');
  const channelName = sanitizeName(String(channel.name || ''), 'channel');
  const sessionName = `ce-${project}-${channelName}-${Date.now().toString(36).slice(-4)}`;
  const runnerCommand = buildRunnerCommand(sessionId, cwd, channelId);

  const created = createDetachedSession(sessionName, cwd, runnerCommand);

  const sessionRecord = await upsertActiveSession({
    sessionId,
    paneId: created.paneId,
    tmuxSessionName: created.sessionName,
    channelId,
    projectPath: cwd,
    startedAt: nowIso(),
    provisionedByChannel: options.provisionedByChannel !== false,
  });

  await notifyEvent('session-start', {
    sessionId,
    paneId: created.paneId,
    tmuxSessionName: created.sessionName,
    channelId,
    projectPath: cwd,
  }).catch(() => {});

  return sessionRecord;
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

function shouldDeleteManagedSessionChannel(session, config) {
  const channelId = String(session?.channelId || '').trim();
  if (!channelId || !/^\d{17,20}$/.test(channelId)) return false;
  if (channelId === String(config?.discordBot?.channelId || '').trim()) return false;
  return session?.provisionedByChannel === true;
}

async function sendControlChannelHandoff(config, session, trigger = 'terminate') {
  const controlChannelId = String(config?.discordBot?.channelId || '').trim();
  const sessionChannelId = String(session?.channelId || '').trim();
  if (!controlChannelId || controlChannelId === sessionChannelId) {
    return;
  }

  await sendDiscordMessage(config.discordBot, {
    channelId: controlChannelId,
    content: [
      config?.debug === true
        ? `Session \`${session?.sessionId || ''}\` finished via ${trigger}.`
        : `A Codex session finished via ${trigger}.`,
      `Continue here in <#${controlChannelId}>.`,
      'Create another session with `!ce-new [name] --cwd <path>`.',
    ].join('\n'),
  }).catch(() => {});
}

async function terminateSessionFromDiscordCommand(session, config, sourceMessageId = '') {
  const paneId = String(session?.paneId || '');
  const channelId = String(session?.channelId || '').trim();
  if (!paneId) {
    return { ok: false, error: 'missing_pane_id' };
  }

  const submitted = sendLiteralToPane(paneId, '/exit', true, 1);
  let forced = false;

  if (!submitted || !(await waitForPaneExit(paneId, 10000))) {
    const killBySession = session.tmuxSessionName ? killSession(session.tmuxSessionName) : false;
    const killByPane = killBySession ? true : killPane(paneId);
    if (!killByPane) {
      return { ok: false, error: 'tmux_terminate_failed' };
    }

    forced = true;
    await waitForPaneExit(paneId, 2500);
    await removeActiveSession(session.sessionId).catch(() => {});
    await notifyEvent('session-end', {
      sessionId: session.sessionId,
      paneId: session.paneId,
      tmuxSessionName: session.tmuxSessionName || '',
      channelId,
      projectPath: session.projectPath || process.cwd(),
      reason: submitted ? 'terminated:force-timeout' : 'terminated:force-no-exit-submit',
    }).catch(() => {});
  }

  if (!shouldDeleteManagedSessionChannel(session, config)) {
    return { ok: true, forced, channelDeleted: false };
  }

  await sendDiscordMessage(config.discordBot, {
    channelId,
    content:
      config?.debug === true
        ? `Session \`${session.sessionId}\` terminated by Discord command. This channel will now be deleted.`
        : 'Session terminated by Discord command. This channel will now be deleted.',
    replyToMessageId: sourceMessageId || undefined,
  }).catch(() => {});

  await sleep(350);

  const deleteResult = await deleteDiscordChannel(
    config.discordBot,
    channelId,
    'codex-everywhere:discord-command:session-terminate',
  ).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!deleteResult.success) {
    let error = deleteResult.error || 'discord_delete_channel_failed';
    if (error.includes('missing_permissions')) {
      error = `${error} (grant the bot 'Manage Channels' permission on this channel/category)`;
    }
    return {
      ok: true,
      forced,
      channelDeleted: false,
      channelDeleteError: error,
    };
  }

  await sendControlChannelHandoff(config, session, 'discord-command').catch(() => {});

  return { ok: true, forced, channelDeleted: true };
}

async function handleCreateSessionCommandInControlChannel(config, state, message, command, activeSessions) {
  const controlChannelId = String(config?.discordBot?.channelId || '').trim();
  const sourceChannelId = String(message?.channel_id || '').trim();
  if (!controlChannelId || sourceChannelId !== controlChannelId) {
    return { handled: false, activeSessions };
  }

  const errorHint = String(command?.error || '').trim();
  if (errorHint) {
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content: [
        `Cannot create session: \`${errorHint}\`.`,
        'Usage: `!ce-new [name] --cwd <path>`',
        'Example: `!ce-new bugfix --cwd ~/code/codex-everywhere`',
      ].join('\n'),
      replyToMessageId: message.id,
    }).catch(() => {});
    return { handled: true, activeSessions };
  }

  const requestedCwd = resolveRequestedCwd(command?.cwd || '');
  const cwdOk = await validateCwdDirectory(requestedCwd);
  if (!cwdOk) {
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content: `Cannot create session: directory not found or not a directory: \`${requestedCwd}\``,
      replyToMessageId: message.id,
    }).catch(() => {});
    return { handled: true, activeSessions };
  }

  const guildId = await ensureProvisionGuildId(config, state);
  if (!guildId) {
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content: 'Cannot create session channel: failed to resolve guild from control channel.',
      replyToMessageId: message.id,
    }).catch(() => {});
    return { handled: true, activeSessions };
  }

  const channelName = inferProvisionedChannelName(requestedCwd, command?.name || '', config);
  const parentId = String(config?.discordProvisioning?.categoryId || '').trim();
  const createResult = await createGuildTextChannel(config.discordBot, guildId, {
    name: channelName,
    parentId,
    topic: `codex-everywhere cwd: ${requestedCwd}`,
  }).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!createResult.success) {
    let reason = createResult.error || 'discord_create_channel_failed';
    if (reason.includes('missing_permissions')) {
      reason = `${reason} (grant the bot 'Manage Channels' permission on this server/category)`;
    }
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content: `Cannot create session channel: ${reason}`,
      replyToMessageId: message.id,
    }).catch(() => {});
    return { handled: true, activeSessions };
  }

  const createdChannel = createResult.channel || {};
  const createdChannelId = String(createdChannel.id || '').trim();
  if (!createdChannelId) {
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content: 'Channel create API returned no channel id.',
      replyToMessageId: message.id,
    }).catch(() => {});
    return { handled: true, activeSessions };
  }

  if (activeSessionByChannelId(activeSessions, createdChannelId)) {
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content: `Channel <#${createdChannelId}> already has an active session.`,
      replyToMessageId: message.id,
    }).catch(() => {});
    return { handled: true, activeSessions };
  }

  const sessionRecord = await launchProvisionedSession(createdChannel, config, {
    cwd: requestedCwd,
    provisionedByChannel: true,
  }).catch(() => null);

  if (!sessionRecord) {
    await sendDiscordMessage(config.discordBot, {
      channelId: controlChannelId,
      content: `Created <#${createdChannelId}> but failed to start Codex session.`,
      replyToMessageId: message.id,
    }).catch(() => {});
    return { handled: true, activeSessions };
  }

  const knownIds = Array.isArray(state.provisionKnownChannelIds) ? state.provisionKnownChannelIds : [];
  const knownSet = new Set(knownIds.filter((id) => typeof id === 'string'));
  knownSet.add(createdChannelId);
  state.provisionKnownChannelIds = Array.from(knownSet).slice(-2000);
  state.lastProvisionScanAt = nowIso();

  const channelLink = `https://discord.com/channels/${guildId}/${createdChannelId}`;
  await sendDiscordMessage(config.discordBot, {
    channelId: controlChannelId,
    content: [
      config?.debug === true
        ? `Created <#${createdChannelId}> and started session \`${sessionRecord.sessionId}\`.`
        : `Created <#${createdChannelId}> and started a new Codex session.`,
      `Directory: \`${requestedCwd}\``,
      `Open channel: ${channelLink}`,
    ].join('\n'),
    replyToMessageId: message.id,
  }).catch(() => {});

  return {
    handled: true,
    activeSessions: [...activeSessions, sessionRecord],
  };
}

async function pollDiscordRepliesInChannel(config, state, limiter, channelId, activeSessions) {
  const channelCursorMap = getChannelCursorMap(state);
  const lastCursor = channelCursorMap[channelId] || null;
  const processed = getProcessedSetForChannel(state, channelId);

  const fetchResult = await fetchChannelMessages(config.discordBot, channelId, lastCursor, 20);
  if (!fetchResult.success) {
    state.errors += 1;
    state.lastError = fetchResult.error || 'discord_fetch_failed';
    return;
  }

  const messages = [...fetchResult.messages].reverse();

  for (const message of messages) {
    channelCursorMap[channelId] = message.id;
    state.discordLastMessageId = message.id;

    if (processed.has(message.id)) continue;
    if (hasBotCheckReaction(message)) {
      processed.add(message.id);
      continue;
    }

    const authorId = String(message?.author?.id || '');
    const isBotMessage = message?.author?.bot === true;
    if (isBotMessage) continue;

    if (!config.reply.authorizedDiscordUserIds.includes(authorId)) {
      continue;
    }

    const userContent = extractUserMessageContent(message);
    if (!userContent) {
      processed.add(message.id);
      await addReaction(config.discordBot, message.id, '%E2%9C%85', channelId).catch(() => {});
      await sendDiscordMessage(config.discordBot, {
        channelId,
        content:
          'Received empty message content, so nothing was injected. If plain channel messages keep coming through empty, enable **Message Content Intent** for your Discord bot or mention/reply to the bot.',
        replyToMessageId: message.id,
      }).catch(() => {});
      continue;
    }

    const isControlChannel = channelId === String(config.discordBot.channelId || '').trim();
    if (isControlChannel) {
      const createCommand = parseCreateSessionCommand(userContent);
      if (createCommand?.kind === 'create-session') {
        if (!limiter.canProceed()) {
          state.errors += 1;
          state.lastError = 'rate_limited';
          continue;
        }

        processed.add(message.id);
        await addReaction(config.discordBot, message.id, '%E2%9C%85', channelId).catch(() => {});

        const created = await handleCreateSessionCommandInControlChannel(
          config,
          state,
          message,
          createCommand,
          activeSessions,
        );
        if (created?.handled) {
          activeSessions = created.activeSessions;
          state.messagesInjected += 1;
          continue;
        }
      }
    }

    const lifecycle = parseLifecycleCommand(userContent);
    if (lifecycle?.kind === 'terminate-session') {
      if (!limiter.canProceed()) {
        state.errors += 1;
        state.lastError = 'rate_limited';
        continue;
      }

      processed.add(message.id);
      await addReaction(config.discordBot, message.id, '%E2%9C%85', channelId).catch(() => {});

      const session = activeSessionByChannelId(activeSessions, channelId);
      if (!session?.paneId) {
        await sendDiscordMessage(config.discordBot, {
          channelId,
          content: 'No active Codex session is bound to this channel.',
          replyToMessageId: message.id,
        }).catch(() => {});
        continue;
      }

      await sendDiscordMessage(config.discordBot, {
        channelId,
        content:
          config?.debug === true
            ? `Termination requested for session \`${session.sessionId}\`.`
            : 'Termination requested. Closing this Codex session.',
        replyToMessageId: message.id,
      }).catch(() => {});

      const terminated = await terminateSessionFromDiscordCommand(session, config, message.id);
      if (!terminated.ok) {
        state.errors += 1;
        state.lastError = terminated.error || 'session_terminate_failed';
        await sendDiscordMessage(config.discordBot, {
          channelId,
          content:
            config?.debug === true
              ? `Failed to terminate session \`${session.sessionId}\`: ${terminated.error || 'unknown error'}.`
              : `Failed to terminate this session: ${terminated.error || 'unknown error'}.`,
          replyToMessageId: message.id,
        }).catch(() => {});
        continue;
      }

      state.messagesInjected += 1;
      activeSessions = activeSessions.filter((candidate) => candidate?.sessionId !== session.sessionId);

      if (!terminated.channelDeleted) {
        const mode = terminated.forced ? 'force-terminated' : 'terminated';
        const suffix = terminated.channelDeleteError
          ? ` Channel delete failed: ${terminated.channelDeleteError}.`
          : '';
        await sendDiscordMessage(config.discordBot, {
          channelId,
          content:
            config?.debug === true
              ? `Session \`${session.sessionId}\` ${mode}.${suffix}`
              : `Session ${mode}.${suffix}`,
          replyToMessageId: message.id,
        }).catch(() => {});
      }
      continue;
    }

    const referenceId = message?.message_reference?.message_id || '';
    const mappedByReference = referenceId ? await lookupMessageMapping(referenceId) : null;

    let mapping = null;
    if (mappedByReference && (!mappedByReference.channelId || mappedByReference.channelId === channelId)) {
      mapping = mappedByReference;
    }

    if (!mapping) {
      const session = activeSessionByChannelId(activeSessions, channelId);
      if (!session?.paneId) {
        continue;
      }
      mapping = {
        kind: 'chat',
        sessionId: session.sessionId,
        tmuxPaneId: session.paneId,
        tmuxSessionName: session.tmuxSessionName || '',
        channelId,
      };
    }

    if (!limiter.canProceed()) {
      state.errors += 1;
      state.lastError = 'rate_limited';
      continue;
    }

    let injectResult = { ok: false, reason: 'unknown' };

    if (mapping.kind === 'approval') {
      injectResult = await injectApprovalDecision(mapping, userContent);
      if (!injectResult.ok && injectResult.reason === 'invalid_decision') {
        await sendDiscordMessage(config.discordBot, {
          channelId,
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
      const ok = await injectReplyToPane(mapping, userContent, config);
      injectResult = ok ? { ok: true } : { ok: false, reason: 'tmux_injection_failed' };
    }

    if (injectResult.ok) {
      state.messagesInjected += 1;
      processed.add(message.id);
      await addReaction(config.discordBot, message.id, '%E2%9C%85', channelId).catch(() => {});
      if (config?.debug === true) {
        const target = mapping.tmuxSessionName
          ? `${mapping.tmuxSessionName} ${mapping.tmuxPaneId}`
          : mapping.tmuxPaneId;
        const action = mapping.kind === 'approval' ? 'Decision injected' : 'Message injected';
        await sendDiscordMessage(config.discordBot, {
          channelId,
          content: `${action} into tmux target \`${target}\`.`,
          replyToMessageId: message.id,
        }).catch(() => {});
      }
    } else {
      state.errors += 1;
      state.lastError = injectResult.reason;
    }
  }

  setProcessedSetForChannel(state, channelId, processed);
  state.processedReplyMessageIds = state.processedReplyMessageIdsByChannel[channelId] || [];
}

async function seedDiscordCursorIfNeeded(config, state, channelId) {
  const channelCursorMap = getChannelCursorMap(state);
  if (channelCursorMap[channelId]) return false;

  const seeded = await fetchChannelMessages(config.discordBot, channelId, null, 1);
  if (!seeded.success) {
    state.errors += 1;
    state.lastError = seeded.error || 'discord_seed_failed';
    return false;
  }

  const latest = Array.isArray(seeded.messages) ? seeded.messages[0] : null;
  if (latest?.id) {
    channelCursorMap[channelId] = latest.id;
    state.discordLastMessageId = latest.id;
  }

  return true;
}

async function ensureProvisionGuildId(config, state) {
  if (state.provisionGuildId) return state.provisionGuildId;

  const controlChannelResult = await getDiscordChannel(config.discordBot, config.discordBot.channelId);
  if (!controlChannelResult.success) {
    state.errors += 1;
    state.lastError = controlChannelResult.error || 'discord_control_channel_lookup_failed';
    return '';
  }

  const guildId = String(controlChannelResult?.channel?.guild_id || '');
  if (!guildId) {
    state.errors += 1;
    state.lastError = 'discord_control_channel_missing_guild';
    return '';
  }

  state.provisionGuildId = guildId;
  return guildId;
}

async function provisionSessionsForNewChannels(config, state, activeSessions) {
  if (!config.discordProvisioning.enabled) return activeSessions;

  const guildId = await ensureProvisionGuildId(config, state);
  if (!guildId) return activeSessions;

  const channelsResult = await listGuildTextChannels(config.discordBot, guildId);
  if (!channelsResult.success) {
    state.errors += 1;
    state.lastError = channelsResult.error || 'discord_list_channels_failed';
    return activeSessions;
  }

  const eligibleChannels = channelsResult.channels.filter((channel) => matchesProvisionFilters(channel, config));
  const knownList = Array.isArray(state.provisionKnownChannelIds) ? state.provisionKnownChannelIds : [];
  const knownSet = new Set(knownList.filter((id) => typeof id === 'string'));

  if (!state.lastProvisionScanAt) {
    state.provisionKnownChannelIds = eligibleChannels.map((channel) => String(channel.id));
    state.lastProvisionScanAt = nowIso();
    return activeSessions;
  }

  const nextSessions = [...activeSessions];
  const managedCount = nextSessions.filter((session) => {
    const channelId = String(session?.channelId || '');
    return channelId && channelId !== config.discordBot.channelId;
  }).length;
  let count = managedCount;

  for (const channel of eligibleChannels) {
    const channelId = String(channel.id || '');
    if (!channelId) continue;

    if (!knownSet.has(channelId)) {
      knownSet.add(channelId);

      if (activeSessionByChannelId(nextSessions, channelId)) {
        continue;
      }

      if (count >= config.discordProvisioning.maxManagedChannels) {
        continue;
      }

      const created = await launchProvisionedSession(channel, config).catch(() => null);
      if (created) {
        nextSessions.push(created);
        count += 1;
      }
    }
  }

  state.provisionKnownChannelIds = Array.from(knownSet).slice(-2000);
  state.lastProvisionScanAt = nowIso();

  return nextSessions;
}

async function scanApprovalPrompts(config, state) {
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
      channelId: session.channelId || config.discordBot.channelId || '',
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
  state.debug = resolveDaemonDebugValue({}, state.debug === true);

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
    const persistedState = await readJson(DAEMON_STATE_PATH, null);
    if (persistedState && typeof persistedState?.debug === 'boolean') {
      state.debug = persistedState.debug;
    }

    const config = loadAppConfig();

    state.lastPollAt = nowIso();

    try {
      const paneIds = listPaneIds();
      let activeSessions = await pruneActiveSessions(paneIds);

      if (config.notificationsEnabled && config.discordBot.enabled && config.discordProvisioning.enabled) {
        const lastScanMs = new Date(state.lastProvisionScanAt || 0).getTime();
        const shouldScan =
          !Number.isFinite(lastScanMs) ||
          Date.now() - lastScanMs >= config.discordProvisioning.pollIntervalMs;
        if (shouldScan) {
          activeSessions = await provisionSessionsForNewChannels(config, state, activeSessions);
        }
      }

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

        const managedChannelIds = new Set();
        for (const session of activeSessions) {
          const channelId = String(session?.channelId || '').trim();
          if (channelId) managedChannelIds.add(channelId);
        }

        if (config.discordBot.channelId) {
          managedChannelIds.add(config.discordBot.channelId);
        }

        for (const channelId of managedChannelIds) {
          const seeded = await seedDiscordCursorIfNeeded(config, state, channelId);
          if (!seeded) {
            await pollDiscordRepliesInChannel(config, state, limiter, channelId, activeSessions);
          }
        }
      }

      if (config.notificationsEnabled && config.discordBot.enabled) {
        await scanApprovalPrompts(config, state);
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
  const flag = String(process.argv[3] || '').trim();
  const debugOption = flag === '--debug'
    ? true
    : flag === '--no-debug'
      ? false
      : undefined;
  if (flag && typeof debugOption === 'undefined') {
    console.error('Usage: reply-daemon.js start [--debug|--no-debug]');
    process.exit(1);
  }

  if (command === 'run') {
    await runDaemonLoop();
    return;
  }

  if (command === 'start') {
    const result = await startDaemon({ debug: debugOption });
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
