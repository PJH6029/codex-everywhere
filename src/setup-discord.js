import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { CODEX_EVERYWHERE_CONFIG_PATH } from './constants.js';
import {
  fetchChannelMessages,
  getDiscordChannel,
  listCurrentUserGuilds,
  listGuildTextChannels,
  sendDiscordMessage,
} from './discord.js';
import { clampInt, parseBoolean, parseDiscordIds } from './utils.js';

const DISCORD_ID_PATTERN = /^\d{17,20}$/;

function usageText() {
  return [
    'Usage:',
    '  codex-everywhere setup discord --bot-token <token> [--control-channel-id <id> | --guild-name <name>] [options]',
    '',
    'Options:',
    '  --control-channel-id <id>            explicit control channel id (optional if guild/name resolution is used)',
    '  --guild-id <id>                      optional guild id for control channel auto-resolution',
    '  --guild-name <name>                  default: codex-everywhere-server',
    '  --control-channel-name <name>        default: auto (일반, general)',
    '  --authorized-user-id <id|auto>       default: auto (discover from latest non-bot message)',
    '  --authorized-user-ids <id,id,...>    explicit csv list',
    '  --mention-user-id <id>               optional user mention target',
    '  --provision-enabled <true|false>     default: true',
    '  --provision-prefix <prefix>          default: codex-',
    '  --provision-category-id <id>         optional Discord category id',
    '  --poll-interval-ms <int>             default: 3000',
    '  --rate-limit-per-minute <int>        default: 10',
    '  --max-message-length <int>           default: 500',
    '  --max-managed-channels <int>         default: 40',
    '  --config-path <path>                 default: ~/.codex-everywhere/config.json',
    '  --skip-test-message                  do not send setup confirmation message',
    '',
    'Examples:',
    '  codex-everywhere setup discord --bot-token "$BOT" --control-channel-id 123 --authorized-user-id auto',
    '  codex-everywhere setup discord --bot-token "$BOT" --guild-name "codex-everywhere-server" --authorized-user-id auto',
    '  codex-everywhere setup discord --bot-token "$BOT" --guild-id 999 --control-channel-name "general" --authorized-user-ids 111,222',
  ].join('\n');
}

function parseArgs(args) {
  const parsed = {
    botToken: '',
    controlChannelId: '',
    guildId: '',
    guildName: 'codex-everywhere-server',
    controlChannelName: '',
    authorizedUserId: 'auto',
    authorizedUserIdsCsv: '',
    mentionUserId: '',
    provisionEnabled: true,
    provisionPrefix: 'codex-',
    provisionCategoryId: '',
    pollIntervalMs: 3000,
    rateLimitPerMinute: 10,
    maxMessageLength: 500,
    maxManagedChannels: 40,
    configPath: CODEX_EVERYWHERE_CONFIG_PATH,
    skipTestMessage: false,
  };

  for (let idx = 0; idx < args.length; idx += 1) {
    const token = args[idx];
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--skip-test-message') {
      parsed.skipTestMessage = true;
      continue;
    }
    if (token === '--bot-token') {
      parsed.botToken = String(args[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token === '--control-channel-id') {
      parsed.controlChannelId = String(args[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token === '--guild-id') {
      parsed.guildId = String(args[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token === '--guild-name') {
      parsed.guildName = String(args[idx + 1] || '').trim() || parsed.guildName;
      idx += 1;
      continue;
    }
    if (token === '--control-channel-name') {
      parsed.controlChannelName = String(args[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token === '--authorized-user-id') {
      parsed.authorizedUserId = String(args[idx + 1] || '').trim() || 'auto';
      idx += 1;
      continue;
    }
    if (token === '--authorized-user-ids') {
      parsed.authorizedUserIdsCsv = String(args[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token === '--mention-user-id') {
      parsed.mentionUserId = String(args[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token === '--provision-enabled') {
      parsed.provisionEnabled = parseBoolean(args[idx + 1], true);
      idx += 1;
      continue;
    }
    if (token === '--provision-prefix') {
      parsed.provisionPrefix = String(args[idx + 1] || '').trim().toLowerCase() || 'codex-';
      idx += 1;
      continue;
    }
    if (token === '--provision-category-id') {
      parsed.provisionCategoryId = String(args[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token === '--poll-interval-ms') {
      parsed.pollIntervalMs = clampInt(args[idx + 1], 3000, 500, 60000);
      idx += 1;
      continue;
    }
    if (token === '--rate-limit-per-minute') {
      parsed.rateLimitPerMinute = clampInt(args[idx + 1], 10, 1, 120);
      idx += 1;
      continue;
    }
    if (token === '--max-message-length') {
      parsed.maxMessageLength = clampInt(args[idx + 1], 500, 1, 4000);
      idx += 1;
      continue;
    }
    if (token === '--max-managed-channels') {
      parsed.maxManagedChannels = clampInt(args[idx + 1], 40, 1, 500);
      idx += 1;
      continue;
    }
    if (token === '--config-path') {
      parsed.configPath = String(args[idx + 1] || '').trim() || CODEX_EVERYWHERE_CONFIG_PATH;
      idx += 1;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  return parsed;
}

function validateArgs(parsed) {
  if (!parsed.botToken) {
    throw new Error('missing --bot-token');
  }
  if (parsed.controlChannelId && !DISCORD_ID_PATTERN.test(parsed.controlChannelId)) {
    throw new Error('invalid --control-channel-id (must be Discord snowflake)');
  }
  if (parsed.guildId && !DISCORD_ID_PATTERN.test(parsed.guildId)) {
    throw new Error('invalid --guild-id (must be Discord snowflake)');
  }
  if (!parsed.controlChannelId && !parsed.guildName && !parsed.guildId) {
    throw new Error('provide --control-channel-id or --guild-name/--guild-id');
  }
  if (parsed.mentionUserId && !DISCORD_ID_PATTERN.test(parsed.mentionUserId)) {
    throw new Error('invalid --mention-user-id (must be Discord snowflake)');
  }
  if (parsed.provisionCategoryId && !DISCORD_ID_PATTERN.test(parsed.provisionCategoryId)) {
    throw new Error('invalid --provision-category-id (must be Discord snowflake)');
  }
}

async function readExistingConfig(path) {
  if (!existsSync(path)) return {};
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function resolveAuthorizedUserIds(parsed, discordConfig) {
  const explicitCsv = parseDiscordIds(parsed.authorizedUserIdsCsv);
  if (explicitCsv.length > 0) {
    return explicitCsv;
  }

  const single = String(parsed.authorizedUserId || '').trim();
  if (single && single.toLowerCase() !== 'auto') {
    if (!DISCORD_ID_PATTERN.test(single)) {
      throw new Error('invalid --authorized-user-id (must be Discord snowflake or auto)');
    }
    return [single];
  }

  const recent = await fetchChannelMessages(discordConfig, parsed.controlChannelId, null, 30);
  if (!recent.success) {
    throw new Error(`failed to discover authorized user id: ${recent.error || 'discord_fetch_failed'}`);
  }

  for (const message of recent.messages) {
    const userId = String(message?.author?.id || '');
    const isBot = message?.author?.bot === true;
    if (!isBot && DISCORD_ID_PATTERN.test(userId)) {
      return [userId];
    }
  }

  throw new Error(
    'failed to discover authorized user id automatically. Send one message in control channel and rerun, or pass --authorized-user-id.',
  );
}

function normalizeNameLower(value) {
  return String(value || '').trim().toLowerCase();
}

async function resolveControlChannelId(parsed, discordConfig) {
  if (parsed.controlChannelId) {
    return parsed.controlChannelId;
  }

  const guildsResult = await listCurrentUserGuilds(discordConfig, 200);
  if (!guildsResult.success) {
    throw new Error(`failed to list guilds: ${guildsResult.error || 'discord_list_guilds_failed'}`);
  }

  const guilds = Array.isArray(guildsResult.guilds) ? guildsResult.guilds : [];
  const targetGuildId = String(parsed.guildId || '').trim();
  const targetGuildName = normalizeNameLower(parsed.guildName || '');

  let guild = null;
  if (targetGuildId) {
    guild = guilds.find((item) => String(item?.id || '') === targetGuildId) || null;
    if (!guild) {
      throw new Error(`guild not found for --guild-id ${targetGuildId}`);
    }
  } else {
    const matches = guilds.filter((item) => normalizeNameLower(item?.name || '') === targetGuildName);
    if (matches.length === 0) {
      throw new Error(
        `guild not found for --guild-name "${parsed.guildName}". Create it first (e.g. via Discord UI/Playwright) or pass --control-channel-id.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `multiple guilds match --guild-name "${parsed.guildName}". Pass --guild-id or --control-channel-id.`,
      );
    }
    guild = matches[0];
  }

  const guildId = String(guild?.id || '');
  const channelsResult = await listGuildTextChannels(discordConfig, guildId);
  if (!channelsResult.success) {
    throw new Error(`failed to list channels in guild ${guildId}: ${channelsResult.error || 'discord_list_channels_failed'}`);
  }

  const channels = Array.isArray(channelsResult.channels) ? channelsResult.channels : [];
  const requested = normalizeNameLower(parsed.controlChannelName || '');
  const preferredNames = requested ? [requested] : ['일반', 'general'];

  for (const name of preferredNames) {
    const hit = channels.find((channel) => normalizeNameLower(channel?.name || '') === name);
    if (hit?.id) {
      return String(hit.id);
    }
  }

  throw new Error(
    `control channel not found in guild "${guild?.name || guildId}" for names: ${preferredNames.join(', ')}`,
  );
}

function buildNotificationsPatch(parsed, authorizedUserIds, controlChannelId) {
  const mentionUserId = parsed.mentionUserId || authorizedUserIds[0] || '';

  return {
    enabled: true,
    events: {
      'user-input': { enabled: true },
    },
    'discord-bot': {
      enabled: true,
      botToken: parsed.botToken,
      channelId: controlChannelId,
      mention: mentionUserId ? `<@${mentionUserId}>` : '',
      provisioning: {
        enabled: parsed.provisionEnabled,
        channelPrefix: parsed.provisionPrefix,
        categoryId: parsed.provisionCategoryId || '',
        pollIntervalMs: parsed.pollIntervalMs,
        maxManagedChannels: parsed.maxManagedChannels,
      },
    },
    reply: {
      enabled: true,
      authorizedDiscordUserIds: authorizedUserIds,
      pollIntervalMs: parsed.pollIntervalMs,
      rateLimitPerMinute: parsed.rateLimitPerMinute,
      includePrefix: true,
      autoContinueOnDeny: true,
      onDenyMessage:
        'User denied this command. Continue without running it and choose a safe alternative.',
      maxMessageLength: parsed.maxMessageLength,
    },
  };
}

function mergeNotifications(existingConfig, notificationsPatch) {
  const current = existingConfig && typeof existingConfig === 'object' ? existingConfig : {};
  const currentNotifications = current.notifications && typeof current.notifications === 'object'
    ? current.notifications
    : {};
  const currentDiscordBot = currentNotifications['discord-bot'] && typeof currentNotifications['discord-bot'] === 'object'
    ? currentNotifications['discord-bot']
    : {};
  const currentProvisioning = currentDiscordBot.provisioning && typeof currentDiscordBot.provisioning === 'object'
    ? currentDiscordBot.provisioning
    : {};
  const currentReply = currentNotifications.reply && typeof currentNotifications.reply === 'object'
    ? currentNotifications.reply
    : {};
  const currentEvents = currentNotifications.events && typeof currentNotifications.events === 'object'
    ? currentNotifications.events
    : {};
  const nextDiscordBot = notificationsPatch['discord-bot'];

  return {
    ...current,
    notifications: {
      ...currentNotifications,
      enabled: notificationsPatch.enabled,
      events: {
        ...currentEvents,
        ...notificationsPatch.events,
      },
      'discord-bot': {
        ...currentDiscordBot,
        ...nextDiscordBot,
        provisioning: {
          ...currentProvisioning,
          ...(nextDiscordBot?.provisioning || {}),
        },
      },
      reply: {
        ...currentReply,
        ...notificationsPatch.reply,
      },
    },
  };
}

async function writeConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export async function runDiscordSetupCommand(args = []) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log(usageText());
    return;
  }

  validateArgs(parsed);

  const discordConfig = {
    enabled: true,
    botToken: parsed.botToken,
    fallbackBotToken: '',
    channelId: parsed.controlChannelId || '',
    mention: '',
  };

  const controlChannelId = await resolveControlChannelId(parsed, discordConfig);
  const channelCheck = await getDiscordChannel(discordConfig, controlChannelId);
  if (!channelCheck.success) {
    throw new Error(
      `Discord control channel validation failed (${controlChannelId}): ${channelCheck.error || 'discord_channel_lookup_failed'}`,
    );
  }

  const effectiveDiscordConfig = {
    ...discordConfig,
    channelId: controlChannelId,
  };

  const authorizedUserIds = await resolveAuthorizedUserIds({
    ...parsed,
    controlChannelId,
  }, effectiveDiscordConfig);
  const patch = buildNotificationsPatch(parsed, authorizedUserIds, controlChannelId);
  const current = await readExistingConfig(parsed.configPath);
  const merged = mergeNotifications(current, patch);
  await writeConfig(parsed.configPath, merged);

  if (!parsed.skipTestMessage) {
    const preview = [
      '# codex-everywhere setup complete',
      '',
      `Control channel configured: \`${controlChannelId}\``,
      `Authorized user ids: \`${authorizedUserIds.join(', ')}\``,
      'Next: run `codex-everywhere daemon start` then type `!ce-new` in this channel.',
    ].join('\n');

    await sendDiscordMessage({
      ...effectiveDiscordConfig,
      mention: patch['discord-bot'].mention || '',
    }, {
      channelId: controlChannelId,
      content: preview,
    }).catch(() => {});
  }

  console.log('[codex-everywhere] Discord setup written successfully');
  console.log(`[codex-everywhere] config: ${parsed.configPath}`);
  console.log(`[codex-everywhere] control channel: ${controlChannelId}`);
  console.log(`[codex-everywhere] authorized users: ${authorizedUserIds.join(', ')}`);
  console.log('[codex-everywhere] next: codex-everywhere daemon stop && codex-everywhere daemon start');
}
