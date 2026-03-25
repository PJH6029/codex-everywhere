import { open, readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { CODEX_SESSIONS_DIR } from './constants.js';
import { upsertActiveSession } from './active-sessions.js';
import { notifyEvent } from './notify.js';
import { nowIso } from './utils.js';

const DEFAULT_POLL_INTERVAL_MS = 1200;
const MAX_SEEN_PLAN_IDS = 64;

async function collectSessionLogFiles(rootDir = CODEX_SESSIONS_DIR, depth = 0, files = []) {
  if (depth > 4) return files;

  let entries = [];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionLogFiles(fullPath, depth + 1, files);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

    try {
      const fileStat = await stat(fullPath);
      files.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
    } catch {
      // Ignore files that disappear during discovery.
    }
  }

  return files;
}

async function readSessionMeta(filePath) {
  try {
    const content = await readFile(filePath, 'utf-8');
    const firstLine = content.split('\n', 1)[0] || '';
    if (!firstLine) return null;

    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== 'session_meta') return null;

    const payload = parsed.payload;
    if (!payload || typeof payload !== 'object') return null;

    return {
      cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
      id: typeof payload.id === 'string' ? payload.id : '',
      timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : '',
    };
  } catch {
    return null;
  }
}

function scoreSessionLogCandidate(meta, candidate, startedAtMs) {
  const referenceMs = Number.parseInt(String(startedAtMs || 0), 10);
  const metaMs = Date.parse(meta.timestamp || '');
  const effectiveMs = Number.isFinite(metaMs) ? metaMs : candidate.mtimeMs;
  const windowStartMs = Number.isFinite(referenceMs) ? referenceMs - 30_000 : Number.NEGATIVE_INFINITY;

  if (!Number.isFinite(effectiveMs) || effectiveMs < windowStartMs) {
    return Number.POSITIVE_INFINITY;
  }

  const distance = Math.abs(effectiveMs - referenceMs);
  const beforeStartPenalty = effectiveMs < referenceMs ? 5_000 : 0;
  return distance + beforeStartPenalty;
}

async function findSessionLogFile(options = {}) {
  const candidates = await collectSessionLogFiles();
  if (candidates.length === 0) return '';

  const referenceMs = Number.parseInt(String(options.startedAtMs || 0), 10);
  const recentCandidates = candidates
    .filter((candidate) => (
      !Number.isFinite(referenceMs) || candidate.mtimeMs >= referenceMs - 30_000
    ))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 20);

  let bestPath = '';
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of recentCandidates) {
    const meta = await readSessionMeta(candidate.path);
    if (!meta || meta.cwd !== options.projectPath) continue;

    const score = scoreSessionLogCandidate(meta, candidate, options.startedAtMs);
    if (score >= bestScore) continue;

    bestScore = score;
    bestPath = candidate.path;
  }

  return bestPath;
}

async function readNewText(filePath, offset) {
  let handle;

  try {
    const fileStat = await stat(filePath);
    if (!Number.isFinite(fileStat.size)) {
      return { nextOffset: offset, text: '' };
    }
    if (fileStat.size <= offset) {
      return { nextOffset: fileStat.size, text: '' };
    }

    const length = fileStat.size - offset;
    const buffer = Buffer.alloc(length);
    handle = await open(filePath, 'r');
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return {
      nextOffset: offset + bytesRead,
      text: buffer.toString('utf-8', 0, bytesRead),
    };
  } catch {
    return { nextOffset: offset, text: '' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizeCollaborationModeKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'default' || normalized === 'plan') {
    return normalized;
  }
  return '';
}

export function parseCodexSessionLogLine(line) {
  if (!line) return null;

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (parsed?.type !== 'event_msg') return null;

  const payload = parsed.payload;
  if (!payload || typeof payload !== 'object') return null;

  if (payload.type === 'agent_message') {
    if (String(payload.phase || '').trim().toLowerCase() !== 'commentary') {
      return null;
    }

    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    return message
      ? { type: 'commentary', message }
      : null;
  }

  if (payload.type === 'task_started') {
    const mode = normalizeCollaborationModeKind(payload.collaboration_mode_kind);
    return mode
      ? { type: 'collaboration-mode', mode }
      : null;
  }

  if (payload.type === 'item_completed') {
    const item = payload.item;
    if (!item || typeof item !== 'object' || item.type !== 'Plan') {
      return null;
    }

    const planText = typeof item.text === 'string' ? item.text.trim() : '';
    const itemId = typeof item.id === 'string' ? item.id.trim() : '';
    if (!planText) return null;

    return {
      type: 'plan-completed',
      itemId,
      planText,
    };
  }

  return null;
}

export function startCodexSessionCommentaryRelay(options = {}) {
  const pollIntervalMs = Math.max(
    400,
    Number.parseInt(String(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS), 10) || DEFAULT_POLL_INTERVAL_MS,
  );

  let sessionLogPath = '';
  let offset = 0;
  let remainder = '';
  let hasSentProgressHeader = false;
  let currentCollaborationMode = normalizeCollaborationModeKind(options.initialCollaborationMode) || 'default';
  let stopped = false;
  let timer = null;
  let running = Promise.resolve();
  const seenPlanItemIds = [];
  const seenPlanItemIdSet = new Set();

  async function relayMessage(message) {
    const result = await notifyEvent('progress-update', {
      sessionId: options.sessionId,
      paneId: options.paneId,
      tmuxSessionName: options.tmuxSessionName,
      projectPath: options.projectPath,
      channelId: options.channelId,
      content: message,
      includeHeader: !hasSentProgressHeader,
    }).catch(() => {});
    if (result?.success) {
      hasSentProgressHeader = true;
    }
  }

  function rememberPlanItemId(itemId) {
    if (!itemId || seenPlanItemIdSet.has(itemId)) return false;
    seenPlanItemIdSet.add(itemId);
    seenPlanItemIds.push(itemId);
    while (seenPlanItemIds.length > MAX_SEEN_PLAN_IDS) {
      const removed = seenPlanItemIds.shift();
      if (removed) {
        seenPlanItemIdSet.delete(removed);
      }
    }
    return true;
  }

  async function syncCollaborationMode(mode) {
    if (!mode || mode === currentCollaborationMode) return;
    currentCollaborationMode = mode;
    await upsertActiveSession({
      sessionId: options.sessionId,
      collaborationModeKind: mode,
      collaborationModeUpdatedAt: nowIso(),
    }).catch(() => {});
  }

  async function relayPlanDecisionRequest(planText, itemId) {
    if (!planText) return;
    if (itemId && !rememberPlanItemId(itemId)) return;

    await notifyEvent('plan-decision-request', {
      sessionId: options.sessionId,
      paneId: options.paneId,
      tmuxSessionName: options.tmuxSessionName,
      projectPath: options.projectPath,
      channelId: options.channelId,
      planItemId: itemId,
      content: planText,
    }).catch(() => {});
  }

  async function processLine(line) {
    const event = parseCodexSessionLogLine(line);
    if (!event) return;

    if (event.type === 'commentary') {
      await relayMessage(event.message);
      return;
    }

    if (event.type === 'collaboration-mode') {
      await syncCollaborationMode(event.mode);
      return;
    }

    if (event.type === 'plan-completed') {
      await relayPlanDecisionRequest(event.planText, event.itemId);
    }
  }

  async function flushRemainder() {
    const line = remainder.trim();
    if (!line) return;
    remainder = '';
    await processLine(line);
  }

  async function processOnce() {
    if (!sessionLogPath) {
      sessionLogPath = await findSessionLogFile(options);
      if (!sessionLogPath) return;
    }

    const chunk = await readNewText(sessionLogPath, offset);
    offset = chunk.nextOffset;
    if (!chunk.text) return;

    const combined = `${remainder}${chunk.text}`;
    const lines = combined.split('\n');
    remainder = lines.pop() || '';

    for (const line of lines) {
      await processLine(line);
    }
  }

  function queueProcess() {
    running = running
      .then(() => processOnce())
      .catch(() => {});
    return running;
  }

  queueProcess();
  timer = setInterval(() => {
    if (stopped) return;
    queueProcess();
  }, pollIntervalMs);

  return {
    async stop({ flush = true } = {}) {
      if (stopped) {
        await running.catch(() => {});
        return;
      }

      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      if (flush) {
        await running.catch(() => {});
        await processOnce().catch(() => {});
        await flushRemainder().catch(() => {});
      }

      await running.catch(() => {});
    },
  };
}
