import { createHash } from 'crypto';
import { INPUT_SYNC_STATE_PATH } from './constants.js';
import { readJson, writeJsonAtomic } from './utils.js';

const MAX_TRACKED_SESSIONS = 400;

function normalizeSyncMap(value) {
  return value && typeof value === 'object' ? { ...value } : {};
}

function pruneSyncMap(entries) {
  const sessionIds = Object.keys(entries);
  if (sessionIds.length <= MAX_TRACKED_SESSIONS) return entries;

  const sorted = sessionIds
    .map((id) => ({ id, updatedAt: String(entries[id]?.updatedAt || '') }))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const next = { ...entries };
  for (let idx = 0; idx < sorted.length - MAX_TRACKED_SESSIONS; idx += 1) {
    delete next[sorted[idx].id];
  }
  return next;
}

async function readInputSyncState() {
  const state = await readJson(INPUT_SYNC_STATE_PATH, {
    bySession: {},
    injectedBySession: {},
  });

  return {
    bySession: normalizeSyncMap(state?.bySession),
    injectedBySession: normalizeSyncMap(state?.injectedBySession),
  };
}

async function writeInputSyncState(state) {
  await writeJsonAtomic(INPUT_SYNC_STATE_PATH, {
    bySession: pruneSyncMap(normalizeSyncMap(state?.bySession)),
    injectedBySession: pruneSyncMap(normalizeSyncMap(state?.injectedBySession)),
  }).catch(() => {});
}

export function normalizeUserInputForSync(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

export function inputFingerprint(sessionId, input) {
  return createHash('sha256')
    .update(`${sessionId}\n${input}`)
    .digest('hex')
    .slice(0, 24);
}

export async function shouldForwardUserInput(sessionId, input) {
  const normalizedSessionId = String(sessionId || '').trim() || 'unknown-session';
  const normalizedInput = normalizeUserInputForSync(input);
  if (!normalizedInput) return false;

  const state = await readInputSyncState();
  const fingerprint = inputFingerprint(normalizedSessionId, normalizedInput);
  const previous = String(state.bySession?.[normalizedSessionId]?.fingerprint || '');
  if (previous === fingerprint) {
    return false;
  }

  state.bySession[normalizedSessionId] = {
    fingerprint,
    updatedAt: new Date().toISOString(),
  };
  await writeInputSyncState(state);
  return true;
}

export async function markInjectedUserInput(sessionId, input) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedInput = normalizeUserInputForSync(input);
  if (!normalizedSessionId || !normalizedInput) return;

  const state = await readInputSyncState();
  state.injectedBySession[normalizedSessionId] = {
    fingerprint: inputFingerprint(normalizedSessionId, normalizedInput),
    updatedAt: new Date().toISOString(),
  };
  await writeInputSyncState(state);
}

export async function consumeInjectedUserInput(sessionId, input) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedInput = normalizeUserInputForSync(input);
  if (!normalizedSessionId || !normalizedInput) return false;

  const state = await readInputSyncState();
  const fingerprint = inputFingerprint(normalizedSessionId, normalizedInput);
  const previous = String(state.injectedBySession?.[normalizedSessionId]?.fingerprint || '');
  if (previous !== fingerprint) {
    return false;
  }

  delete state.injectedBySession[normalizedSessionId];
  await writeInputSyncState(state);
  return true;
}
