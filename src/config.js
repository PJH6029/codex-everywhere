import { existsSync, readFileSync } from 'fs';
import { CODEX_EVERYWHERE_CONFIG_PATH, DAEMON_STATE_PATH } from './constants.js';
import { clampInt, parseBoolean, parseDiscordIds } from './utils.js';

function readRawConfig() {
  if (!existsSync(CODEX_EVERYWHERE_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CODEX_EVERYWHERE_CONFIG_PATH, 'utf-8'));
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

function parseOptionalBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  return undefined;
}

function readDaemonDebugFlag() {
  if (!existsSync(DAEMON_STATE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(DAEMON_STATE_PATH, 'utf-8'));
    return typeof parsed?.debug === 'boolean' ? parsed.debug : undefined;
  } catch {
    return undefined;
  }
}

function resolveDebugMode(notifications) {
  const envDebug = parseOptionalBoolean(process.env.CODEX_EVERYWHERE_DEBUG);
  if (typeof envDebug === 'boolean') return envDebug;

  const fileDebug = parseOptionalBoolean(notifications?.debug);
  if (typeof fileDebug === 'boolean') return fileDebug;

  const daemonDebug = readDaemonDebugFlag();
  if (typeof daemonDebug === 'boolean') return daemonDebug;

  return false;
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

  const envBotToken = typeof process.env.CODEX_EVERYWHERE_DISCORD_BOT_TOKEN === 'string'
    ? process.env.CODEX_EVERYWHERE_DISCORD_BOT_TOKEN.trim()
    : '';
  const fileBotToken = typeof file?.botToken === 'string'
    ? file.botToken.trim()
    : '';

  const botToken = envBotToken || fileBotToken || '';
  const fallbackBotToken =
    envBotToken && fileBotToken && envBotToken !== fileBotToken
      ? fileBotToken
      : '';

  const channelId = process.env.CODEX_EVERYWHERE_DISCORD_CHANNEL || file?.channelId || '';
  const mention = validateMention(process.env.CODEX_EVERYWHERE_DISCORD_MENTION) || validateMention(file?.mention);

  const enabled = fileEnabled && !!botToken && !!channelId;

  return {
    enabled,
    botToken,
    fallbackBotToken,
    channelId,
    mention,
  };
}

function resolveDiscordProvisioningConfig(notifications, hasDiscordBot) {
  const file = notifications?.['discord-bot']?.provisioning;

  const enabled =
    parseBoolean(process.env.CODEX_EVERYWHERE_DISCORD_PROVISION_ENABLED, file?.enabled !== false) &&
    hasDiscordBot;

  const envGuildId = typeof process.env.CODEX_EVERYWHERE_DISCORD_PROVISION_GUILD_ID === 'string'
    ? process.env.CODEX_EVERYWHERE_DISCORD_PROVISION_GUILD_ID.trim()
    : '';
  const fileGuildId = typeof file?.guildId === 'string'
    ? file.guildId.trim()
    : '';
  const guildIdCandidate = envGuildId || fileGuildId;
  const guildId = /^\d{17,20}$/.test(guildIdCandidate) ? guildIdCandidate : '';

  const prefixRaw = typeof process.env.CODEX_EVERYWHERE_DISCORD_PROVISION_PREFIX === 'string'
    ? process.env.CODEX_EVERYWHERE_DISCORD_PROVISION_PREFIX
    : file?.channelPrefix;
  const channelPrefix = typeof prefixRaw === 'string' ? prefixRaw.trim().toLowerCase() : 'codex-';

  const envCategory = typeof process.env.CODEX_EVERYWHERE_DISCORD_PROVISION_CATEGORY_ID === 'string'
    ? process.env.CODEX_EVERYWHERE_DISCORD_PROVISION_CATEGORY_ID.trim()
    : '';
  const fileCategory = typeof file?.categoryId === 'string'
    ? file.categoryId.trim()
    : '';
  const categoryIdCandidate = envCategory || fileCategory;
  const categoryId = /^\d{17,20}$/.test(categoryIdCandidate) ? categoryIdCandidate : '';

  const pollIntervalMs = clampInt(
    process.env.CODEX_EVERYWHERE_DISCORD_PROVISION_POLL_INTERVAL_MS ?? file?.pollIntervalMs,
    3000,
    1000,
    60000,
  );

  const maxManagedChannels = clampInt(
    process.env.CODEX_EVERYWHERE_DISCORD_PROVISION_MAX_CHANNELS ?? file?.maxManagedChannels,
    40,
    1,
    500,
  );

  return {
    enabled,
    guildId,
    channelPrefix,
    categoryId,
    pollIntervalMs,
    maxManagedChannels,
  };
}

function resolveReplyConfig(notifications, hasDiscordBot) {
  const replyRaw = notifications?.reply;

  const enabled =
    parseBoolean(process.env.CODEX_EVERYWHERE_REPLY_ENABLED, false) ||
    replyRaw?.enabled === true;

  const idsFromEnv = parseDiscordIds(process.env.CODEX_EVERYWHERE_REPLY_DISCORD_USER_IDS);
  const idsFromFile = Array.isArray(replyRaw?.authorizedDiscordUserIds)
    ? replyRaw.authorizedDiscordUserIds.filter((id) => typeof id === 'string' && /^\d{17,20}$/.test(id))
    : [];

  const authorizedDiscordUserIds = idsFromEnv.length > 0 ? idsFromEnv : idsFromFile;

  const pollIntervalMs = clampInt(
    process.env.CODEX_EVERYWHERE_REPLY_POLL_INTERVAL_MS ?? replyRaw?.pollIntervalMs,
    3000,
    500,
    60000,
  );

  const rateLimitPerMinute = clampInt(
    process.env.CODEX_EVERYWHERE_REPLY_RATE_LIMIT ?? replyRaw?.rateLimitPerMinute,
    10,
    1,
    120,
  );

  const maxMessageLength = clampInt(
    process.env.CODEX_EVERYWHERE_REPLY_MAX_MESSAGE_LENGTH ?? replyRaw?.maxMessageLength,
    500,
    1,
    4000,
  );

  const includePrefix =
    process.env.CODEX_EVERYWHERE_REPLY_INCLUDE_PREFIX !== 'false' &&
    replyRaw?.includePrefix !== false;

  const autoContinueOnDeny =
    process.env.CODEX_EVERYWHERE_REPLY_AUTO_CONTINUE_ON_DENY !== 'false' &&
    replyRaw?.autoContinueOnDeny !== false;

  const denyMessageFromEnv = typeof process.env.CODEX_EVERYWHERE_REPLY_ON_DENY_MESSAGE === 'string'
    ? process.env.CODEX_EVERYWHERE_REPLY_ON_DENY_MESSAGE.trim()
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
  const discordProvisioning = resolveDiscordProvisioningConfig(notifications, discordBot.enabled);
  const reply = resolveReplyConfig(notifications, discordBot.enabled);
  const events = notifications?.events || {};
  const debug = resolveDebugMode(notifications);

  return {
    notificationsEnabled,
    debug,
    discordBot,
    discordProvisioning,
    reply,
    events: {
      sessionStart: eventEnabled(events, 'session-start', true),
      sessionEnd: eventEnabled(events, 'session-end', true),
      turnComplete: eventEnabled(events, 'turn-complete', true),
      userInput:
        eventEnabled(events, 'user-input', true) &&
        eventEnabled(events, 'input-message', true),
      approvalRequest: eventEnabled(events, 'approval-request', true),
      askUserQuestion: eventEnabled(events, 'ask-user-question', true),
    },
    rawConfigPath: CODEX_EVERYWHERE_CONFIG_PATH,
  };
}
