import { existsSync, readFileSync } from 'fs';
import { OMX_CONFIG_PATH } from './constants.js';
import { clampInt, parseBoolean, parseDiscordIds } from './utils.js';

function readRawConfig() {
  if (!existsSync(OMX_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OMX_CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function readNotificationsBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const notifications = raw.notifications;
  if (!notifications || typeof notifications !== 'object') return null;
  return notifications;
}

function validateMention(raw) {
  if (typeof raw !== 'string') return undefined;
  const mention = raw.trim();
  if (!mention) return undefined;
  if (/^<@!?\d{17,20}>$/.test(mention)) return mention;
  if (/^<@&\d{17,20}>$/.test(mention)) return mention;
  return undefined;
}

export function parseMentionAllowedMentions(mention) {
  if (!mention) return { parse: [] };
  const user = mention.match(/^<@!?(\d{17,20})>$/);
  if (user) return { parse: [], users: [user[1]] };
  const role = mention.match(/^<@&(\d{17,20})>$/);
  if (role) return { parse: [], roles: [role[1]] };
  return { parse: [] };
}

function resolveDiscordBotConfig(notifications) {
  const file = notifications?.['discord-bot'];
  const fileEnabled = file?.enabled !== false;

  const envBotToken = typeof process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN === 'string'
    ? process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN.trim()
    : '';
  const fileBotToken = typeof file?.botToken === 'string'
    ? file.botToken.trim()
    : '';

  const botToken = envBotToken || fileBotToken || '';
  const fallbackBotToken =
    envBotToken && fileBotToken && envBotToken !== fileBotToken
      ? fileBotToken
      : '';

  const channelId = process.env.OMX_DISCORD_NOTIFIER_CHANNEL || file?.channelId || '';
  const mention = validateMention(process.env.OMX_DISCORD_MENTION) || validateMention(file?.mention);

  const enabled = fileEnabled && !!botToken && !!channelId;

  return {
    enabled,
    botToken,
    fallbackBotToken,
    channelId,
    mention,
  };
}

function resolveReplyConfig(notifications, hasDiscordBot) {
  const replyRaw = notifications?.reply;

  const enabled =
    parseBoolean(process.env.OMX_REPLY_ENABLED, false) ||
    replyRaw?.enabled === true;

  const idsFromEnv = parseDiscordIds(process.env.OMX_REPLY_DISCORD_USER_IDS);
  const idsFromFile = Array.isArray(replyRaw?.authorizedDiscordUserIds)
    ? replyRaw.authorizedDiscordUserIds.filter((id) => typeof id === 'string' && /^\d{17,20}$/.test(id))
    : [];

  const authorizedDiscordUserIds = idsFromEnv.length > 0 ? idsFromEnv : idsFromFile;

  const pollIntervalMs = clampInt(
    process.env.OMX_REPLY_POLL_INTERVAL_MS ?? replyRaw?.pollIntervalMs,
    3000,
    500,
    60000,
  );

  const rateLimitPerMinute = clampInt(
    process.env.OMX_REPLY_RATE_LIMIT ?? replyRaw?.rateLimitPerMinute,
    10,
    1,
    120,
  );

  const maxMessageLength = clampInt(
    process.env.OMX_REPLY_MAX_MESSAGE_LENGTH ?? replyRaw?.maxMessageLength,
    500,
    1,
    4000,
  );

  const includePrefix =
    process.env.OMX_REPLY_INCLUDE_PREFIX !== 'false' &&
    replyRaw?.includePrefix !== false;

  const autoContinueOnDeny =
    process.env.OMX_REPLY_AUTO_CONTINUE_ON_DENY !== 'false' &&
    replyRaw?.autoContinueOnDeny !== false;

  const denyMessageFromEnv = typeof process.env.OMX_REPLY_ON_DENY_MESSAGE === 'string'
    ? process.env.OMX_REPLY_ON_DENY_MESSAGE.trim()
    : '';
  const denyMessageFromFile = typeof replyRaw?.onDenyMessage === 'string'
    ? replyRaw.onDenyMessage.trim()
    : '';
  const onDenyMessage =
    denyMessageFromEnv ||
    denyMessageFromFile ||
    'User denied this command. Continue without running it and choose a safe alternative.';

  return {
    enabled: enabled && hasDiscordBot,
    pollIntervalMs,
    rateLimitPerMinute,
    maxMessageLength,
    includePrefix,
    autoContinueOnDeny,
    onDenyMessage,
    authorizedDiscordUserIds,
  };
}

function eventEnabled(events, eventName, fallback = true) {
  const event = events?.[eventName];
  if (!event || typeof event !== 'object') return fallback;
  if (event.enabled === false) return false;
  if (event.enabled === true) return true;
  return fallback;
}

export function loadAppConfig() {
  const raw = readRawConfig();
  const notifications = readNotificationsBlock(raw);

  const notificationsEnabled = notifications?.enabled !== false;
  const discordBot = resolveDiscordBotConfig(notifications);
  const reply = resolveReplyConfig(notifications, discordBot.enabled);
  const events = notifications?.events || {};

  return {
    notificationsEnabled,
    discordBot,
    reply,
    events: {
      sessionStart: eventEnabled(events, 'session-start', true),
      sessionEnd: eventEnabled(events, 'session-end', true),
      turnComplete: eventEnabled(events, 'turn-complete', true),
      approvalRequest:
        eventEnabled(events, 'approval-request', true) &&
        eventEnabled(events, 'ask-user-question', true),
    },
    rawConfigPath: OMX_CONFIG_PATH,
  };
}
