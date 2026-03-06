#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { stat } from 'fs/promises';
import { spawn, spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { resolve } from 'path';
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
  updateDiscordChannel,
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
  userQuestionsNotified: 0,
  errors: 0,
  lastError: '',
  lastApprovalBySession: {},
  lastUserQuestionBySession: {},
  suppressConversationInterruptedBySession: {},
  debug: false,
};

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DENY_INTERRUPTED_SUPPRESS_MS = 15000;
const REPLY_DAEMON_SCRIPT_PATH = fileURLToPath(import.meta.url);
const RUN_CODEX_SCRIPT_PATH = fileURLToPath(new URL('./run-codex.js', import.meta.url));
const LEGACY_REPLY_LISTENER_PATTERNS = [
  'oh-my-codex/dist/notifications/reply-listener.js',
  'dist/notifications/reply-listener.js',
];

function readPid() {
  if (!existsSync(DAEMON_PID_PATH)) return null;
  const parsed = Number.parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function writePid(pid) {
  mkdirSync(GLOBAL_STATE_DIR, { recursive: true });
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
      const isConflict = LEGACY_REPLY_LISTENER_PATTERNS.some((pattern) => lowerArgs.includes(pattern.toLowerCase()));
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
    mkdirSync(GLOBAL_STATE_DIR, { recursive: true });
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
        mkdirSync(GLOBAL_STATE_DIR, { recursive: true });
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
        `conflicting legacy reply listener detected (pid: ${conflicts.join(', ')}). ` +
        "codex-everywhere has no OMX dependency, but this safety check prevents reply-injection races. " +
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
const META_MESSAGE_COMMANDS = new Set([
  '!ce-meta',
  '!codex-meta',
]);
const HELP_MESSAGE_COMMANDS = new Set([
  '!ce-help',
  '!codex-help',
]);
const POLICY_MESSAGE_COMMANDS = new Set([
  '!ce-perm',
  '!ce-permission',
  '!ce-policy',
  '!codex-perm',
  '!codex-policy',
]);
const CREATE_SESSION_MESSAGE_COMMANDS = new Set([
  '!ce-new',
  '!ce-create',
  '!codex-new',
]);
const CREATE_SESSION_APPROVAL_POLICIES = new Set([
  'untrusted',
  'on-request',
  'on-failure',
  'never',
]);
const CREATE_SESSION_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
const DEFAULT_NEW_CHANNEL_NAME = 'new-channel';

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

function normalizeCreateSessionApproval(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CREATE_SESSION_APPROVAL_POLICIES.has(normalized) ? normalized : '';
}

function normalizeCreateSessionSandbox(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CREATE_SESSION_SANDBOX_MODES.has(normalized) ? normalized : '';
}

function buildLaunchPolicySpec(approvalPolicy, sandboxMode, fullAuto) {
  let nextApprovalPolicy = String(approvalPolicy || '').trim().toLowerCase();
  let nextSandboxMode = String(sandboxMode || '').trim().toLowerCase();
  const nextFullAuto = fullAuto === true;

  if (nextFullAuto) {
    if (!nextApprovalPolicy) nextApprovalPolicy = 'on-request';
    if (!nextSandboxMode) nextSandboxMode = 'workspace-write';
  }

  const codexArgs = [];
  if (nextApprovalPolicy) {
    codexArgs.push('--ask-for-approval', nextApprovalPolicy);
  }
  if (nextSandboxMode) {
    codexArgs.push('--sandbox', nextSandboxMode);
  }

  return {
    approvalPolicy: nextApprovalPolicy,
    sandboxMode: nextSandboxMode,
    fullAuto: nextFullAuto,
    codexArgs,
  };
}

function markConversationInterruptedSuppressed(state, sessionId, ttlMs = DENY_INTERRUPTED_SUPPRESS_MS) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  if (!state.suppressConversationInterruptedBySession || typeof state.suppressConversationInterruptedBySession !== 'object') {
    state.suppressConversationInterruptedBySession = {};
  }
  state.suppressConversationInterruptedBySession[id] = Date.now() + Math.max(1000, Math.trunc(ttlMs));
}

function isConversationInterruptedSuppressed(state, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const map = state.suppressConversationInterruptedBySession;
  if (!map || typeof map !== 'object') return false;

  const expiresAt = Number(map[id] || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    delete map[id];
    return false;
  }
  if (expiresAt <= Date.now()) {
    delete map[id];
    return false;
  }
  return true;
}

function hasPendingApprovalForPane(paneId) {
  if (!paneId) return false;
  const paneContent = capturePane(paneId, 90);
  return !!detectApprovalPrompt(paneContent);
}

function parseLifecycleCommand(text) {
  const normalized = String(text || '')
    .replace(/^(?:<@!?\d{17,20}>\s*)+/g, '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (HELP_MESSAGE_COMMANDS.has(normalized)) {
    return { kind: 'session-help' };
  }
  if (TERMINATE_MESSAGE_COMMANDS.has(normalized)) {
    return { kind: 'terminate-session' };
  }
  if (META_MESSAGE_COMMANDS.has(normalized)) {
    return { kind: 'session-meta' };
  }
  return null;
}

function parsePolicyCommand(text) {
  const normalized = String(text || '')
    .replace(/^(?:<@!?\d{17,20}>\s*)+/g, '')
    .trim();
  if (!normalized) return null;

  const tokens = splitCommandTokens(normalized);
  if (tokens.length === 0) return null;

  const head = String(tokens[0] || '').toLowerCase();
  if (!POLICY_MESSAGE_COMMANDS.has(head)) {
    return null;
  }

  let approvalPolicy = '';
  let sandboxMode = '';
  let fullAuto = false;
  let resetDefault = false;

  for (let idx = 1; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (token === '--approval' || token === '--ask-for-approval' || token === '-a') {
      const raw = String(tokens[idx + 1] || '').trim();
      if (!raw || raw.startsWith('-')) {
        return {
          kind: 'set-launch-policy',
          error: `missing_option_value:${token}`,
        };
      }
      const normalizedApproval = normalizeCreateSessionApproval(raw);
      if (!normalizedApproval) {
        return {
          kind: 'set-launch-policy',
          error: `invalid_approval_policy:${raw}`,
        };
      }
      approvalPolicy = normalizedApproval;
      idx += 1;
      continue;
    }
    if (token.startsWith('--approval=')) {
      const raw = token.slice('--approval='.length).trim();
      const normalizedApproval = normalizeCreateSessionApproval(raw);
      if (!normalizedApproval) {
        return {
          kind: 'set-launch-policy',
          error: `invalid_approval_policy:${raw}`,
        };
      }
      approvalPolicy = normalizedApproval;
      continue;
    }
    if (token.startsWith('--ask-for-approval=')) {
      const raw = token.slice('--ask-for-approval='.length).trim();
      const normalizedApproval = normalizeCreateSessionApproval(raw);
      if (!normalizedApproval) {
        return {
          kind: 'set-launch-policy',
          error: `invalid_approval_policy:${raw}`,
        };
      }
      approvalPolicy = normalizedApproval;
      continue;
    }
    if (token.startsWith('-a=')) {
      const raw = token.slice('-a='.length).trim();
      const normalizedApproval = normalizeCreateSessionApproval(raw);
      if (!normalizedApproval) {
        return {
          kind: 'set-launch-policy',
          error: `invalid_approval_policy:${raw}`,
        };
      }
      approvalPolicy = normalizedApproval;
      continue;
    }
    if (token === '--sandbox' || token === '-s') {
      const raw = String(tokens[idx + 1] || '').trim();
      if (!raw || raw.startsWith('-')) {
        return {
          kind: 'set-launch-policy',
          error: `missing_option_value:${token}`,
        };
      }
      const normalizedSandbox = normalizeCreateSessionSandbox(raw);
      if (!normalizedSandbox) {
        return {
          kind: 'set-launch-policy',
          error: `invalid_sandbox_mode:${raw}`,
        };
      }
      sandboxMode = normalizedSandbox;
      idx += 1;
      continue;
    }
    if (token.startsWith('--sandbox=')) {
      const raw = token.slice('--sandbox='.length).trim();
      const normalizedSandbox = normalizeCreateSessionSandbox(raw);
      if (!normalizedSandbox) {
        return {
          kind: 'set-launch-policy',
          error: `invalid_sandbox_mode:${raw}`,
        };
      }
      sandboxMode = normalizedSandbox;
      continue;
    }
    if (token.startsWith('-s=')) {
      const raw = token.slice('-s='.length).trim();
      const normalizedSandbox = normalizeCreateSessionSandbox(raw);
      if (!normalizedSandbox) {
        return {
          kind: 'set-launch-policy',
          error: `invalid_sandbox_mode:${raw}`,
        };
      }
      sandboxMode = normalizedSandbox;
      continue;
    }
    if (token === '--full-auto') {
      fullAuto = true;
      continue;
    }
    if (token === '--default' || token === 'default') {
      resetDefault = true;
      continue;
    }
    if (token.startsWith('-')) {
      return {
        kind: 'set-launch-policy',
        error: `unknown_option:${token}`,
      };
    }
    return {
      kind: 'set-launch-policy',
      error: `unknown_option:${token}`,
    };
  }

  if (resetDefault) {
    return {
      kind: 'set-launch-policy',
      resetDefault: true,
      approvalPolicy: '',
      sandboxMode: '',
      fullAuto: false,
      codexArgs: [],
    };
  }

  const launchPolicy = buildLaunchPolicySpec(approvalPolicy, sandboxMode, fullAuto);
  if (launchPolicy.codexArgs.length === 0) {
    return {
      kind: 'set-launch-policy',
      error: 'missing_policy_args',
    };
  }

  return {
    kind: 'set-launch-policy',
    ...launchPolicy,
  };
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
  let approvalPolicy = '';
  let sandboxMode = '';
  let fullAuto = false;
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
    if (token === '--approval' || token === '--ask-for-approval' || token === '-a') {
      const raw = String(tokens[idx + 1] || '').trim();
      if (!raw || raw.startsWith('-')) {
        return {
          kind: 'create-session',
          error: `missing_option_value:${token}`,
        };
      }
      const normalizedApproval = normalizeCreateSessionApproval(raw);
      if (!normalizedApproval) {
        return {
          kind: 'create-session',
          error: `invalid_approval_policy:${raw}`,
        };
      }
      approvalPolicy = normalizedApproval;
      idx += 1;
      continue;
    }
    if (token.startsWith('--approval=')) {
      const raw = token.slice('--approval='.length).trim();
      const normalizedApproval = normalizeCreateSessionApproval(raw);
      if (!normalizedApproval) {
        return {
          kind: 'create-session',
          error: `invalid_approval_policy:${raw}`,
        };
      }
      approvalPolicy = normalizedApproval;
      continue;
    }
    if (token.startsWith('--ask-for-approval=')) {
      const raw = token.slice('--ask-for-approval='.length).trim();
      const normalizedApproval = normalizeCreateSessionApproval(raw);
      if (!normalizedApproval) {
        return {
          kind: 'create-session',
          error: `invalid_approval_policy:${raw}`,
        };
      }
      approvalPolicy = normalizedApproval;
      continue;
    }
    if (token.startsWith('-a=')) {
      const raw = token.slice('-a='.length).trim();
      const normalizedApproval = normalizeCreateSessionApproval(raw);
      if (!normalizedApproval) {
        return {
          kind: 'create-session',
          error: `invalid_approval_policy:${raw}`,
        };
      }
      approvalPolicy = normalizedApproval;
      continue;
    }
    if (token === '--sandbox' || token === '-s') {
      const raw = String(tokens[idx + 1] || '').trim();
      if (!raw || raw.startsWith('-')) {
        return {
          kind: 'create-session',
          error: `missing_option_value:${token}`,
        };
      }
      const normalizedSandbox = normalizeCreateSessionSandbox(raw);
      if (!normalizedSandbox) {
        return {
          kind: 'create-session',
          error: `invalid_sandbox_mode:${raw}`,
        };
      }
      sandboxMode = normalizedSandbox;
      idx += 1;
      continue;
    }
    if (token.startsWith('--sandbox=')) {
      const raw = token.slice('--sandbox='.length).trim();
      const normalizedSandbox = normalizeCreateSessionSandbox(raw);
      if (!normalizedSandbox) {
        return {
          kind: 'create-session',
          error: `invalid_sandbox_mode:${raw}`,
        };
      }
      sandboxMode = normalizedSandbox;
      continue;
    }
    if (token.startsWith('-s=')) {
      const raw = token.slice('-s='.length).trim();
      const normalizedSandbox = normalizeCreateSessionSandbox(raw);
      if (!normalizedSandbox) {
        return {
          kind: 'create-session',
          error: `invalid_sandbox_mode:${raw}`,
        };
      }
      sandboxMode = normalizedSandbox;
      continue;
    }
    if (token === '--full-auto') {
      fullAuto = true;
      continue;
    }
    if (token.startsWith('--')) {
      return {
        kind: 'create-session',
        error: `unknown_option:${token}`,
      };
    }
    if (token.startsWith('-')) {
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

  const launchPolicy = buildLaunchPolicySpec(approvalPolicy, sandboxMode, fullAuto);

  return {
    kind: 'create-session',
    cwd,
    name,
    ...launchPolicy,
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

function inferProvisionedChannelName(_cwdPath, requestedName, config) {
  const prefix = String(config?.discordProvisioning?.channelPrefix || 'codex-').trim().toLowerCase() || 'codex-';
  const requested = String(requestedName || '').trim();
  const base = requested || DEFAULT_NEW_CHANNEL_NAME;
  const slug = sanitizeName(base, DEFAULT_NEW_CHANNEL_NAME);
  if (slug.startsWith(prefix)) {
    return slug.slice(0, 95);
  }
  return `${prefix}${slug}`.slice(0, 95);
}

function normalizeChannelName(name, fallback = DEFAULT_NEW_CHANNEL_NAME) {
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

async function makeUniqueChannelName(config, guildId, desiredName, excludeChannelId = '') {
  const candidate = normalizeChannelName(desiredName);
  const listed = await listGuildTextChannels(config.discordBot, guildId).catch(() => ({
    success: false,
    channels: [],
  }));
  if (!listed.success) return candidate;

  const normalizedExclude = String(excludeChannelId || '').trim();
  const existing = new Set(
    listed.channels
      .filter((channel) => String(channel?.id || '').trim() !== normalizedExclude)
      .map((channel) => normalizeChannelName(channel?.name || '')),
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

function inferAutoChannelNameFromMessage(content, config) {
  const normalized = String(content || '')
    .toLowerCase()
    .replace(/^(?:\[reply:discord\]\s*)+/g, '')
    .replace(/^!ce-[a-z0-9_-]+(?:\s+.*)?$/g, '')
    .replace(/^\$[a-z0-9_-]+(?:\s+.*)?$/g, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';

  const words = normalized.split(' ').filter(Boolean).slice(0, 8);
  if (words.length === 0) return '';

  const prefix = String(config?.discordProvisioning?.channelPrefix || 'codex-').trim().toLowerCase() || 'codex-';
  const slug = sanitizeName(words.join('-'), '');
  if (!slug) return '';
  if (slug === DEFAULT_NEW_CHANNEL_NAME) return '';
  return `${prefix}${slug}`.slice(0, 95);
}

async function maybeAutoRenameSessionChannel(config, state, session, messageContent) {
  if (!session?.autoChannelNamePending) return session;
  if (!session?.provisionedByChannel) return session;

  const channelId = String(session.channelId || '').trim();
  if (!channelId) return session;

  const desiredName = inferAutoChannelNameFromMessage(messageContent, config);
  if (!desiredName) return session;

  const guildId = await ensureProvisionGuildId(config, state);
  if (!guildId) return session;

  const uniqueName = await makeUniqueChannelName(config, guildId, desiredName, channelId);
  const currentName = normalizeChannelName(session.channelName || '');
  if (uniqueName === currentName) {
    const next = {
      ...session,
      autoChannelNamePending: false,
      channelName: uniqueName,
      autoChannelRenamedAt: nowIso(),
    };
    await upsertActiveSession(next).catch(() => {});
    return next;
  }

  const renamed = await updateDiscordChannel(config.discordBot, channelId, {
    name: uniqueName,
    reason: 'codex-everywhere:auto-topic-channel-name',
  }).catch(() => ({
    success: false,
    error: 'discord_update_channel_failed',
  }));

  if (!renamed.success) {
    state.errors += 1;
    state.lastError = renamed.error || 'discord_update_channel_failed';
    return session;
  }

  const next = {
    ...session,
    channelName: uniqueName,
    autoChannelNamePending: false,
    autoChannelRenamedAt: nowIso(),
  };

  await upsertActiveSession(next).catch(() => {});
  if (config.debug === true) {
    await sendDiscordMessage(config.discordBot, {
      channelId,
      content: `Auto-renamed channel to \`${uniqueName}\`.`,
    }).catch(() => {});
  }
  return next;
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

function detectUserInputPrompt(content) {
  const normalized = String(content || '');
  if (!normalized) return null;

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const lower = lines.join('\n').toLowerCase();
  const hasRequestOverlay =
    lines.some((line) => /^question\s+\d+\s*\/\s*\d+/i.test(line)) &&
    lower.includes('enter to submit answer') &&
    lower.includes('esc to interrupt');
  const hasConversationInterrupted =
    lower.includes('conversation interrupted - tell the model what to do differently');

  if (!hasRequestOverlay && !hasConversationInterrupted) {
    return null;
  }

  let question = '';
  let promptContent = '';
  let optionLines = [];

  if (hasRequestOverlay) {
    const headerIndex = lines.findIndex((line) => /^question\s+\d+\s*\/\s*\d+/i.test(line));
    if (headerIndex >= 0) {
      const questionLines = [];
      const collectedOptions = [];
      for (let idx = headerIndex + 1; idx < lines.length; idx += 1) {
        const line = lines[idx];
        if (!line) continue;
        const normalizedOption = line.replace(/^[›>]\s*/, '');
        if (/^(?:[›>]\s*)?\d+\.\s+/.test(line)) {
          collectedOptions.push(normalizedOption);
          continue;
        }
        if (
          /^type your answer/i.test(line) ||
          /^tab to add notes/i.test(line) ||
          /^enter to submit answer/i.test(line) ||
          /^←\/→ to navigate questions/i.test(line) ||
          /^esc to interrupt/i.test(line)
        ) {
          continue;
        }
        if (collectedOptions.length > 0) {
          continue;
        }
        questionLines.push(line);
      }
      optionLines = collectedOptions;
      question = questionLines.join(' ').trim();
      if (question || optionLines.length > 0) {
        promptContent = [question, optionLines.length > 0 ? optionLines.join('\n') : '']
          .filter(Boolean)
          .join('\n\n')
          .trim();
      }
    }
  }

  if (!question && hasConversationInterrupted) {
    question = 'Conversation was interrupted. Tell Codex what to do differently.';
  }

  if (!question) {
    question = 'Codex is waiting for your response.';
  }
  if (!promptContent) {
    promptContent = question;
  }

  const snippet = truncate(lines.slice(-16).join(' | '), 700);
  const headerLine = lines.find((line) => /^question\s+\d+\s*\/\s*\d+/i.test(line)) || '';
  const progressMatch = headerLine.match(/question\s+(\d+)\s*\/\s*(\d+)/i);
  const progressKey = progressMatch ? `${progressMatch[1]}/${progressMatch[2]}` : '';
  const kind = hasConversationInterrupted ? 'conversation-interrupted' : 'request-user-input';
  const signatureSeed = `${kind}|${progressKey}|${question.toLowerCase()}|${optionLines
    .map((line) => line.toLowerCase())
    .join('|')}`;
  const signature = createHash('sha256')
    .update(signatureSeed)
    .digest('hex')
    .slice(0, 16);

  return {
    question,
    content: promptContent,
    kind,
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

function buildRunnerCommand(sessionId, cwd, channelId, passthroughArgs = []) {
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
    ...passthroughArgs,
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

function activeSessionById(sessions, sessionId) {
  const target = String(sessionId || '').trim();
  if (!target) return null;
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    if (String(sessions[i]?.sessionId || '') === target) {
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
  const codexArgs = Array.isArray(options.codexArgs) ? options.codexArgs.filter((item) => typeof item === 'string') : [];
  const runnerCommand = buildRunnerCommand(sessionId, cwd, channelId, codexArgs);
  const autoChannelNamePending = options.autoChannelNamePending === true;

  const created = createDetachedSession(sessionName, cwd, runnerCommand);

  const sessionRecord = await upsertActiveSession({
    sessionId,
    paneId: created.paneId,
    tmuxSessionName: created.sessionName,
    channelId,
    projectPath: cwd,
    startedAt: nowIso(),
    channelName: normalizeChannelName(String(channel.name || ''), DEFAULT_NEW_CHANNEL_NAME),
    channelRoutingKey: `discord:${channelId}`,
    autoChannelNamePending,
    provisionedByChannel: options.provisionedByChannel !== false,
    launchApprovalPolicy: String(options.approvalPolicy || ''),
    launchSandboxMode: String(options.sandboxMode || ''),
    launchFullAuto: options.fullAuto === true,
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
  if (!hasPendingApprovalForPane(mapping.tmuxPaneId)) {
    return { ok: false, reason: 'no_pending_approval' };
  }

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

function describeLaunchPolicy(command) {
  const approval = String(command?.approvalPolicy || '').trim() || '(default)';
  const sandbox = String(command?.sandboxMode || '').trim() || '(default)';
  const fullAuto = command?.fullAuto === true;
  const mode = command?.resetDefault === true ? 'default' : (fullAuto ? 'full-auto' : 'custom');
  return `mode=${mode}, approval=${approval}, sandbox=${sandbox}`;
}

function formatChannelHelp(config, isControlChannel, hasBoundSession) {
  const controlChannelId = String(config?.discordBot?.channelId || '').trim();
  const controlChannelText = controlChannelId ? `<#${controlChannelId}>` : 'the control channel';
  const sharedTail = [
    '',
    'Approval policy values: `untrusted | on-request | on-failure | never`',
    'Sandbox mode values: `read-only | workspace-write | danger-full-access`',
  ];

  if (isControlChannel) {
    return [
      '# codex-everywhere Help',
      '',
      'This is the control channel. Create/manage Codex sessions from here.',
      '',
      'Commands:',
      '- `!ce-new [name] [--cwd <path>] [--approval <policy>] [--sandbox <mode>] [--full-auto]`',
      '- `!ce-help`',
      '',
      'Examples:',
      '- `!ce-new`',
      '- `!ce-new bugfix --cwd ~/code/my-project`',
      '- `!ce-new docs --approval on-request --sandbox workspace-write`',
      ...sharedTail,
      '',
      `Use session-channel commands inside provisioned channels: \`!ce-meta\`, \`!ce-perm ...\`, \`!ce-exit\`, \`!ce-help\`.`,
    ].join('\n');
  }

  return [
    '# codex-everywhere Help',
    '',
    hasBoundSession
      ? 'This channel is bound to a Codex session.'
      : 'No active Codex session is currently bound to this channel.',
    '',
    'Commands in this channel:',
    '- `!ce-help`',
    '- `!ce-meta`',
    '- `!ce-perm --approval <policy> --sandbox <mode>`',
    '- `!ce-perm --full-auto`',
    '- `!ce-perm --default`',
    '- `!ce-exit`',
    '',
    'Any normal message is forwarded to Codex.',
    '',
    `To create a new channel/session, use \`!ce-new\` in ${controlChannelText}.`,
    ...sharedTail,
  ].join('\n');
}

async function restartSessionWithLaunchPolicy(session, config, command) {
  const paneId = String(session?.paneId || '');
  const channelId = String(session?.channelId || '').trim();
  if (!paneId) {
    return { ok: false, error: 'missing_pane_id' };
  }
  if (!channelId) {
    return { ok: false, error: 'missing_channel_id' };
  }

  const freezeDelete = {
    ...session,
    provisionedByChannel: false,
  };
  await upsertActiveSession(freezeDelete).catch(() => {});

  const submitted = sendLiteralToPane(paneId, '/exit', true, 1);
  if (!submitted || !(await waitForPaneExit(paneId, 12000))) {
    const killBySession = session.tmuxSessionName ? killSession(session.tmuxSessionName) : false;
    const killByPane = killBySession ? true : killPane(paneId);
    if (!killByPane) {
      return { ok: false, error: 'tmux_restart_stop_failed' };
    }
    await waitForPaneExit(paneId, 2500);
  }

  await removeActiveSession(session.sessionId).catch(() => {});

  const channelLookup = await getDiscordChannel(config.discordBot, channelId).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!channelLookup.success) {
    return {
      ok: false,
      error: channelLookup.error || 'discord_channel_lookup_failed',
    };
  }

  const channel = channelLookup.channel || {
    id: channelId,
    name: session.channelName || DEFAULT_NEW_CHANNEL_NAME,
  };

  const restarted = await launchProvisionedSession(channel, config, {
    cwd: session.projectPath || process.cwd(),
    provisionedByChannel: true,
    autoChannelNamePending: false,
    approvalPolicy: command?.approvalPolicy || '',
    sandboxMode: command?.sandboxMode || '',
    fullAuto: command?.fullAuto === true,
    codexArgs: Array.isArray(command?.codexArgs) ? command.codexArgs : [],
  }).catch(() => null);

  if (!restarted) {
    return { ok: false, error: 'session_restart_launch_failed' };
  }

  return { ok: true, session: restarted };
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
        'Usage: `!ce-new [name] --cwd <path> [--approval <policy>] [--sandbox <mode>] [--full-auto]`',
        'Example: `!ce-new bugfix --cwd ~/code/codex-everywhere --approval on-request --sandbox workspace-write`',
        'Approval policy: `untrusted | on-request | on-failure | never`',
        'Sandbox mode: `read-only | workspace-write | danger-full-access`',
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

  const requestedName = String(command?.name || '').trim();
  const channelNameBase = inferProvisionedChannelName(requestedCwd, requestedName, config);
  const parentId = String(config?.discordProvisioning?.categoryId || '').trim();
  const channelName = await makeUniqueChannelName(config, guildId, channelNameBase);
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
    autoChannelNamePending: !requestedName,
    approvalPolicy: command?.approvalPolicy || '',
    sandboxMode: command?.sandboxMode || '',
    fullAuto: command?.fullAuto === true,
    codexArgs: Array.isArray(command?.codexArgs) ? command.codexArgs : [],
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

    const policyCommand = parsePolicyCommand(userContent);
    if (policyCommand?.kind === 'set-launch-policy') {
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

      const errorHint = String(policyCommand?.error || '').trim();
      if (errorHint) {
        await sendDiscordMessage(config.discordBot, {
          channelId,
          content: [
            `Cannot update policy: \`${errorHint}\`.`,
            'Usage: `!ce-perm [--approval <policy>] [--sandbox <mode>] [--full-auto] [--default]`',
            'Example: `!ce-perm --approval on-request --sandbox workspace-write`',
            'Approval policy: `untrusted | on-request | on-failure | never`',
            'Sandbox mode: `read-only | workspace-write | danger-full-access`',
          ].join('\n'),
          replyToMessageId: message.id,
        }).catch(() => {});
        continue;
      }

      await sendDiscordMessage(config.discordBot, {
        channelId,
        content: [
          `Updating session launch policy: \`${describeLaunchPolicy(policyCommand)}\`.`,
          'Restarting Codex in this channel now.',
        ].join('\n'),
        replyToMessageId: message.id,
      }).catch(() => {});

      const restarted = await restartSessionWithLaunchPolicy(session, config, policyCommand);
      if (!restarted.ok || !restarted.session) {
        state.errors += 1;
        state.lastError = restarted.error || 'session_policy_restart_failed';
        await sendDiscordMessage(config.discordBot, {
          channelId,
          content: `Policy update failed: ${restarted.error || 'unknown error'}.`,
          replyToMessageId: message.id,
        }).catch(() => {});
        continue;
      }

      activeSessions = [
        ...activeSessions.filter((candidate) => candidate?.sessionId !== session.sessionId),
        restarted.session,
      ];
      state.messagesInjected += 1;

      await sendDiscordMessage(config.discordBot, {
        channelId,
        content: `Policy applied. New session launch policy: \`${describeLaunchPolicy(policyCommand)}\`.`,
        replyToMessageId: message.id,
      }).catch(() => {});
      continue;
    }

    const lifecycle = parseLifecycleCommand(userContent);
    if (lifecycle?.kind === 'session-help') {
      if (!limiter.canProceed()) {
        state.errors += 1;
        state.lastError = 'rate_limited';
        continue;
      }

      processed.add(message.id);
      await addReaction(config.discordBot, message.id, '%E2%9C%85', channelId).catch(() => {});

      const session = activeSessionByChannelId(activeSessions, channelId);
      const isControlChannelForHelp = channelId === String(config.discordBot.channelId || '').trim();
      await sendDiscordMessage(config.discordBot, {
        channelId,
        content: formatChannelHelp(config, isControlChannelForHelp, !!session),
        replyToMessageId: message.id,
      }).catch(() => {});
      continue;
    }

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

    if (lifecycle?.kind === 'session-meta') {
      if (!limiter.canProceed()) {
        state.errors += 1;
        state.lastError = 'rate_limited';
        continue;
      }

      processed.add(message.id);
      await addReaction(config.discordBot, message.id, '%E2%9C%85', channelId).catch(() => {});

      const session = activeSessionByChannelId(activeSessions, channelId);
      if (!session) {
        await sendDiscordMessage(config.discordBot, {
          channelId,
          content: 'No active Codex session is bound to this channel.',
          replyToMessageId: message.id,
        }).catch(() => {});
        continue;
      }

      await sendDiscordMessage(config.discordBot, {
        channelId,
        content: [
          '# Session Metadata',
          '',
          `Session: \`${session.sessionId || ''}\``,
          `Channel ID: \`${session.channelId || ''}\``,
          `Routing Key: \`${session.channelRoutingKey || `discord:${session.channelId || ''}`}\``,
          `tmux: \`${session.tmuxSessionName || ''}\``,
          `Pane: \`${session.paneId || ''}\``,
          `Project: \`${session.projectPath || ''}\``,
          session.startedAt ? `Started: \`${session.startedAt}\`` : null,
          session.channelName ? `Channel Name: \`${session.channelName}\`` : null,
          `Auto Name Pending: \`${session.autoChannelNamePending === true}\``,
          `Launch Approval: \`${session.launchApprovalPolicy || '(default)'}\``,
          `Launch Sandbox: \`${session.launchSandboxMode || '(default)'}\``,
          `Launch Full Auto: \`${session.launchFullAuto === true}\``,
        ]
          .filter(Boolean)
          .join('\n'),
        replyToMessageId: message.id,
      }).catch(() => {});
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

    // Allow plain channel replies like "y"/"n" during approval overlays without
    // requiring reply threading; this avoids accidental chat-prefix injection.
    if (mapping.kind === 'chat') {
      const parsedDecision = parseApprovalDecision(userContent);
      if (parsedDecision && hasPendingApprovalForPane(mapping.tmuxPaneId)) {
        mapping = {
          ...mapping,
          kind: 'approval',
        };
      }
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
      } else if (!injectResult.ok && injectResult.reason === 'no_pending_approval') {
        await sendDiscordMessage(config.discordBot, {
          channelId,
          content: 'No approval prompt is currently active for this session.',
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
        } else {
          markConversationInterruptedSuppressed(state, mapping.sessionId);
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

      if (mapping.kind === 'chat') {
        const active = activeSessionById(activeSessions, mapping.sessionId);
        if (active?.autoChannelNamePending) {
          const next = await maybeAutoRenameSessionChannel(config, state, active, userContent);
          if (next && next.sessionId === active.sessionId) {
            activeSessions = activeSessions.map((session) => (
              session?.sessionId === active.sessionId ? { ...session, ...next } : session
            ));
          }
        }
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
  const configuredGuildId = String(config?.discordProvisioning?.guildId || '').trim();
  const controlChannelId = String(config?.discordBot?.channelId || '').trim();

  if (controlChannelId) {
    const controlChannelResult = await getDiscordChannel(config.discordBot, controlChannelId);
    if (controlChannelResult.success) {
      const guildId = String(controlChannelResult?.channel?.guild_id || '');
      if (guildId) {
        state.provisionGuildId = guildId;
        return guildId;
      }
    } else if (!configuredGuildId) {
      state.provisionGuildId = '';
      state.errors += 1;
      state.lastError = controlChannelResult.error || 'discord_control_channel_lookup_failed';
      return '';
    }
  }

  if (configuredGuildId) {
    state.provisionGuildId = configuredGuildId;
    return configuredGuildId;
  }

  state.provisionGuildId = '';
  state.errors += 1;
  state.lastError = controlChannelId
    ? 'discord_control_channel_missing_guild'
    : 'discord_control_channel_lookup_failed';
  return '';
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

      const defaultName = inferProvisionedChannelName(process.cwd(), '', config);
      const channelName = normalizeChannelName(String(channel?.name || ''), '');
      const created = await launchProvisionedSession(channel, config, {
        autoChannelNamePending: channelName === normalizeChannelName(defaultName, ''),
      }).catch(() => null);
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

async function scanInteractivePrompts(config, state) {
  const paneIds = listPaneIds();
  const sessions = await pruneActiveSessions(paneIds);
  const seenSessions = new Set();

  for (const session of sessions) {
    if (!session?.sessionId || !session?.paneId) continue;

    seenSessions.add(session.sessionId);

    const paneContent = capturePane(session.paneId, 90);
    const approval = detectApprovalPrompt(paneContent);
    const userQuestion = detectUserInputPrompt(paneContent);

    if (!approval) {
      if (state.lastApprovalBySession[session.sessionId]) {
        delete state.lastApprovalBySession[session.sessionId];
      }
    } else if (state.lastApprovalBySession[session.sessionId] !== approval.signature) {
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

    if (!userQuestion) {
      if (state.lastUserQuestionBySession[session.sessionId]) {
        delete state.lastUserQuestionBySession[session.sessionId];
      }
    } else if (state.lastUserQuestionBySession[session.sessionId] !== userQuestion.signature) {
      if (
        userQuestion.kind === 'conversation-interrupted' &&
        isConversationInterruptedSuppressed(state, session.sessionId)
      ) {
        state.lastUserQuestionBySession[session.sessionId] = userQuestion.signature;
        continue;
      }

      const result = await notifyEvent('ask-user-question', {
        sessionId: session.sessionId,
        paneId: session.paneId,
        tmuxSessionName: session.tmuxSessionName || '',
        channelId: session.channelId || config.discordBot.channelId || '',
        projectPath: session.projectPath || session.cwd,
        question: userQuestion.question,
        content: userQuestion.content || userQuestion.question || userQuestion.snippet,
      });

      if (result.success) {
        state.userQuestionsNotified += 1;
        state.lastUserQuestionBySession[session.sessionId] = userQuestion.signature;
      }
    }
  }

  for (const sessionId of Object.keys(state.lastApprovalBySession)) {
    if (!seenSessions.has(sessionId)) {
      delete state.lastApprovalBySession[sessionId];
    }
  }

  for (const sessionId of Object.keys(state.lastUserQuestionBySession)) {
    if (!seenSessions.has(sessionId)) {
      delete state.lastUserQuestionBySession[sessionId];
    }
  }

  if (
    state.suppressConversationInterruptedBySession &&
    typeof state.suppressConversationInterruptedBySession === 'object'
  ) {
    for (const sessionId of Object.keys(state.suppressConversationInterruptedBySession)) {
      if (!seenSessions.has(sessionId)) {
        delete state.suppressConversationInterruptedBySession[sessionId];
        continue;
      }
      const expiresAt = Number(state.suppressConversationInterruptedBySession[sessionId] || 0);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        delete state.suppressConversationInterruptedBySession[sessionId];
      }
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
        await scanInteractivePrompts(config, state);
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

  if (command === 'restart') {
    const stopResult = await stopDaemon();
    console.log(stopResult.message);
    if (!stopResult.success) {
      process.exit(1);
    }

    const startResult = await startDaemon({ debug: debugOption });
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

  console.error('Usage: reply-daemon.js [start|restart|stop|status|run]');
  process.exit(1);
}

if (process.env.CODEX_EVERYWHERE_DAEMON === '1' || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-everywhere] daemon error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
