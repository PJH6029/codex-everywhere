import { ACTIVE_SESSIONS_PATH } from './constants.js';
import { nowIso, readJson, writeJsonAtomic } from './utils.js';

function normalizeSessions(raw) {
  if (!raw || typeof raw !== 'object') {
    return { sessions: [] };
  }

  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.filter((session) => session && typeof session === 'object')
    : [];

  return { sessions };
}

export async function listActiveSessions() {
  const raw = await readJson(ACTIVE_SESSIONS_PATH, { sessions: [] });
  return normalizeSessions(raw).sessions;
}

export async function findActiveSessionByChannelId(channelId) {
  const normalizedChannelId = String(channelId || '').trim();
  if (!normalizedChannelId) return null;

  const sessions = await listActiveSessions();
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    if (String(sessions[i]?.channelId || '') === normalizedChannelId) {
      return sessions[i];
    }
  }
  return null;
}

export async function upsertActiveSession(session) {
  const raw = await readJson(ACTIVE_SESSIONS_PATH, { sessions: [] });
  const normalized = normalizeSessions(raw);
  const index = normalized.sessions.findIndex((item) => item.sessionId === session.sessionId);

  const next = {
    updatedAt: nowIso(),
    ...session,
  };

  if (index >= 0) {
    normalized.sessions[index] = { ...normalized.sessions[index], ...next };
  } else {
    normalized.sessions.push(next);
  }

  await writeJsonAtomic(ACTIVE_SESSIONS_PATH, normalized);
  return next;
}

export async function removeActiveSession(sessionId) {
  const raw = await readJson(ACTIVE_SESSIONS_PATH, { sessions: [] });
  const normalized = normalizeSessions(raw);
  const filtered = normalized.sessions.filter((session) => session.sessionId !== sessionId);
  await writeJsonAtomic(ACTIVE_SESSIONS_PATH, { sessions: filtered });
}

export async function pruneActiveSessions(validPaneIds) {
  const raw = await readJson(ACTIVE_SESSIONS_PATH, { sessions: [] });
  const normalized = normalizeSessions(raw);
  const isSet = validPaneIds && typeof validPaneIds.has === 'function';
  if (!isSet) return normalized.sessions;

  const filtered = normalized.sessions.filter((session) => {
    const paneId = typeof session.paneId === 'string' ? session.paneId : '';
    return validPaneIds.has(paneId);
  });

  if (filtered.length !== normalized.sessions.length) {
    await writeJsonAtomic(ACTIVE_SESSIONS_PATH, { sessions: filtered });
  }

  return filtered;
}
