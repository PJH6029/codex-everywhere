import { DISCORD_MAX_MESSAGE_LENGTH } from './constants.js';
import { parseMentionAllowedMentions } from './config.js';
import { truncate } from './utils.js';

function composeContent(content, mention) {
  const text = String(content ?? '');
  if (!mention) {
    return truncate(text, DISCORD_MAX_MESSAGE_LENGTH);
  }

  const prefix = `${mention}\n`;
  const maxBody = Math.max(1, DISCORD_MAX_MESSAGE_LENGTH - prefix.length);
  return `${prefix}${truncate(text, maxBody)}`;
}

function authHeaders(botToken) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bot ${botToken}`,
  };
}

function tokenCandidates(config) {
  const primary = String(config.botToken || '').trim();
  const fallback = String(config.fallbackBotToken || '').trim();

  if (!primary) return [];
  if (!fallback || fallback === primary) return [primary];
  return [primary, fallback];
}

function resolveChannelId(config, options = {}) {
  const candidate = typeof options.channelId === 'string' ? options.channelId.trim() : '';
  if (candidate) return candidate;
  return String(config.channelId || '').trim();
}

export async function sendDiscordMessage(config, options) {
  const { mention } = config;
  const channelId = resolveChannelId(config, options);
  const tokens = tokenCandidates(config);

  if (tokens.length === 0 || !channelId) {
    return { success: false, error: 'discord_not_configured' };
  }

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const body = {
    content: composeContent(options.content, mention),
    allowed_mentions: parseMentionAllowedMentions(mention),
  };

  if (options.replyToMessageId) {
    body.message_reference = {
      message_id: options.replyToMessageId,
      fail_if_not_exists: false,
    };
  }

  let lastError = 'discord_send_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        lastError = `discord_http_${response.status}`;
        if (response.status === 401 && idx < tokens.length - 1) {
          continue;
        }
        return { success: false, error: lastError };
      }

      const data = await response.json().catch(() => ({}));
      return {
        success: true,
        messageId: typeof data.id === 'string' ? data.id : undefined,
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_send_failed';
      if (idx < tokens.length - 1) {
        continue;
      }
      return {
        success: false,
        error: lastError,
      };
    }
  }

  return { success: false, error: lastError };
}

export async function fetchChannelMessages(config, channelId, afterMessageId = null, limit = 20) {
  const resolvedChannelId = resolveChannelId(config, { channelId });
  const tokens = tokenCandidates(config);
  if (tokens.length === 0 || !resolvedChannelId) {
    return { success: false, error: 'discord_not_configured', messages: [] };
  }

  const query = new URLSearchParams();
  query.set('limit', String(Math.max(1, Math.min(100, limit))));
  if (afterMessageId) query.set('after', afterMessageId);

  const url = `https://discord.com/api/v10/channels/${resolvedChannelId}/messages?${query.toString()}`;

  let lastError = 'discord_fetch_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(token),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        lastError = `discord_http_${response.status}`;
        if (response.status === 401 && idx < tokens.length - 1) {
          continue;
        }
        return {
          success: false,
          error: lastError,
          messages: [],
          headers: response.headers,
        };
      }

      const messages = await response.json().catch(() => []);
      return {
        success: true,
        messages: Array.isArray(messages) ? messages : [],
        headers: response.headers,
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_fetch_failed';
      if (idx < tokens.length - 1) {
        continue;
      }
      return {
        success: false,
        error: lastError,
        messages: [],
      };
    }
  }

  return { success: false, error: lastError, messages: [] };
}

export async function addReaction(config, messageId, emojiEncoded = '%E2%9C%85', channelId = '') {
  const resolvedChannelId = resolveChannelId(config, { channelId });
  const tokens = tokenCandidates(config);
  if (tokens.length === 0 || !resolvedChannelId || !messageId) return false;

  const url = `https://discord.com/api/v10/channels/${resolvedChannelId}/messages/${messageId}/reactions/${emojiEncoded}/@me`;

  for (let idx = 0; idx < tokens.length; idx += 1) {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${tokens[idx]}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return true;
      if (response.status === 401 && idx < tokens.length - 1) {
        continue;
      }
      return false;
    } catch {
      if (idx < tokens.length - 1) continue;
      return false;
    }
  }

  return false;
}

export async function getDiscordChannel(config, channelId) {
  const resolvedChannelId = resolveChannelId(config, { channelId });
  const tokens = tokenCandidates(config);
  if (!resolvedChannelId || tokens.length === 0) {
    return { success: false, error: 'discord_not_configured' };
  }

  const url = `https://discord.com/api/v10/channels/${resolvedChannelId}`;

  let lastError = 'discord_fetch_channel_failed';
  for (let idx = 0; idx < tokens.length; idx += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(tokens[idx]),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        lastError = `discord_http_${response.status}`;
        if (response.status === 401 && idx < tokens.length - 1) continue;
        return { success: false, error: lastError };
      }

      const channel = await response.json().catch(() => null);
      return { success: true, channel, usedFallbackToken: idx > 0 };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_fetch_channel_failed';
      if (idx < tokens.length - 1) continue;
      return { success: false, error: lastError };
    }
  }

  return { success: false, error: lastError };
}

export async function listGuildTextChannels(config, guildId) {
  const resolvedGuildId = String(guildId || '').trim();
  const tokens = tokenCandidates(config);
  if (!resolvedGuildId || tokens.length === 0) {
    return { success: false, error: 'discord_not_configured', channels: [] };
  }

  const url = `https://discord.com/api/v10/guilds/${resolvedGuildId}/channels`;
  let lastError = 'discord_list_channels_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(tokens[idx]),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        lastError = `discord_http_${response.status}`;
        if (response.status === 401 && idx < tokens.length - 1) continue;
        return { success: false, error: lastError, channels: [] };
      }

      const channels = await response.json().catch(() => []);
      const textChannels = Array.isArray(channels)
        ? channels.filter((channel) => channel?.type === 0 && typeof channel?.id === 'string')
        : [];

      return {
        success: true,
        channels: textChannels,
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_list_channels_failed';
      if (idx < tokens.length - 1) continue;
      return { success: false, error: lastError, channels: [] };
    }
  }

  return { success: false, error: lastError, channels: [] };
}
