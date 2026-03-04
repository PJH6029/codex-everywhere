#!/usr/bin/env node

import { createHash } from 'crypto';
import { INPUT_SYNC_STATE_PATH } from './constants.js';
import {
  appendJsonl,
  readJson,
  resolveFromCwd,
  safeString,
  todayFileName,
  writeJsonAtomic,
} from './utils.js';
import { notifyEvent } from './notify.js';

function parsePayloadArg() {
  const raw = process.argv[process.argv.length - 1];
  if (!raw || raw.startsWith('-')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readField(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return '';
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > 0 ? text : '';
}

function readQuestionFromObject(value) {
  if (!value) return '';
  if (typeof value === 'string') return asNonEmptyString(value);
  if (typeof value !== 'object') return '';

  const direct = [
    asNonEmptyString(value.question),
    asNonEmptyString(value.prompt),
    asNonEmptyString(value.message),
    asNonEmptyString(value.content),
    asNonEmptyString(value.title),
  ].find(Boolean);
  if (direct) return direct;

  const questions = value.questions;
  if (Array.isArray(questions)) {
    for (const item of questions) {
      const extracted = readQuestionFromObject(item);
      if (extracted) return extracted;
    }
  }

  return '';
}

function readQuestion(payload) {
  const direct = readField(payload, ['question', 'ask-user-question', 'ask_user_question']);
  if (direct) return direct;

  const nestedCandidates = [
    payload?.['ask-user-question'],
    payload?.ask_user_question,
    payload?.['request-user-input'],
    payload?.request_user_input,
    payload?.requestUserInput,
  ];

  for (const candidate of nestedCandidates) {
    const extracted = readQuestionFromObject(candidate);
    if (extracted) return extracted;
  }

  return '';
}

function readInputMessages(payload) {
  const candidates = [payload?.['input-messages'], payload?.input_messages, payload?.inputMessages];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((item) => (typeof item === 'string' ? item : ''))
        .filter((item) => item.length > 0);
    }
  }
  return [];
}

function normalizeUserInputForSync(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function isDiscordInjectedInput(text) {
  return /^\[reply:discord\]\s*/i.test(String(text || '').trim());
}

function inputFingerprint(sessionId, input) {
  return createHash('sha256')
    .update(`${sessionId}\n${input}`)
    .digest('hex')
    .slice(0, 24);
}

async function shouldForwardUserInput(sessionId, input) {
  const state = await readJson(INPUT_SYNC_STATE_PATH, { bySession: {} });
  const bySession = state?.bySession && typeof state.bySession === 'object' ? state.bySession : {};

  const fingerprint = inputFingerprint(sessionId, input);
  const previous = String(bySession?.[sessionId]?.fingerprint || '');
  if (previous === fingerprint) {
    return false;
  }

  const nextBySession = {
    ...bySession,
    [sessionId]: {
      fingerprint,
      updatedAt: new Date().toISOString(),
    },
  };

  const sessionIds = Object.keys(nextBySession);
  if (sessionIds.length > 400) {
    const sorted = sessionIds
      .map((id) => ({ id, updatedAt: String(nextBySession[id]?.updatedAt || '') }))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (let idx = 0; idx < sorted.length - 400; idx += 1) {
      delete nextBySession[sorted[idx].id];
    }
  }

  await writeJsonAtomic(INPUT_SYNC_STATE_PATH, { bySession: nextBySession }).catch(() => {});
  return true;
}

async function main() {
  const payload = parsePayloadArg();
  if (!payload) {
    process.exit(0);
  }

  const projectPath =
    process.env.CODEX_EVERYWHERE_PROJECT_PATH ||
    readField(payload, ['cwd', 'workdir']) ||
    process.cwd();

  const sessionId =
    process.env.CODEX_EVERYWHERE_SESSION_ID ||
    readField(payload, ['session_id', 'session-id', 'thread_id', 'thread-id']) ||
    'unknown-session';

  const paneId =
    process.env.CODEX_EVERYWHERE_PANE_ID ||
    process.env.TMUX_PANE ||
    readField(payload, ['tmux_pane_id', 'tmux-pane-id']);

  const tmuxSessionName =
    process.env.CODEX_EVERYWHERE_TMUX_SESSION ||
    readField(payload, ['tmux_session', 'tmux-session']);

  const channelId =
    process.env.CODEX_EVERYWHERE_DISCORD_CHANNEL ||
    readField(payload, ['discord_channel_id', 'discord-channel-id', 'channel_id', 'channel-id']);

  const assistantMessage = readField(payload, ['last-assistant-message', 'last_assistant_message']);
  const question = readQuestion(payload);
  const inputMessages = readInputMessages(payload);
  const latestInput = normalizeUserInputForSync(inputMessages.slice(-1)[0] || '');

  const logPath = resolveFromCwd(projectPath, '.omx', 'logs', todayFileName('codex-everywhere-turns'));

  await appendJsonl(logPath, {
    timestamp: new Date().toISOString(),
    type: safeString(payload.type || 'agent-turn-complete'),
    session_id: sessionId,
    turn_id: readField(payload, ['turn_id', 'turn-id']),
    thread_id: readField(payload, ['thread_id', 'thread-id']),
    pane_id: paneId,
    input_preview: latestInput.slice(0, 120),
    output_preview: assistantMessage.slice(0, 300),
  }).catch(() => {});

  if (latestInput && !isDiscordInjectedInput(latestInput)) {
    const shouldForward = await shouldForwardUserInput(sessionId, latestInput);
    if (shouldForward) {
      await notifyEvent('user-input', {
        sessionId,
        paneId,
        tmuxSessionName,
        projectPath,
        channelId,
        content: latestInput,
      }).catch(() => {});
    }
  }

  if (assistantMessage) {
    await notifyEvent('turn-complete', {
      sessionId,
      paneId,
      tmuxSessionName,
      projectPath,
      channelId,
      content: assistantMessage,
    }).catch(() => {});
  }

  if (question) {
    await notifyEvent('ask-user-question', {
      sessionId,
      paneId,
      tmuxSessionName,
      projectPath,
      channelId,
      question,
      content: question,
    }).catch(() => {});
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
