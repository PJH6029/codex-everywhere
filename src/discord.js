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

export async function sendDiscordMessage(config, options) {
  const { channelId, mention } = config;
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

export async function fetchChannelMessages(config, afterMessageId = null, limit = 20) {
  const { channelId } = config;
  const tokens = tokenCandidates(config);
  if (tokens.length === 0 || !channelId) return { success: false, error: 'discord_not_configured', messages: [] };

  const query = new URLSearchParams();
  query.set('limit', String(Math.max(1, Math.min(100, limit))));
  if (afterMessageId) query.set('after', afterMessageId);

  const url = `https://discord.com/api/v10/channels/${channelId}/messages?${query.toString()}`;

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

export async function addReaction(config, messageId, emojiEncoded = '%E2%9C%85') {
  const { channelId } = config;
  const tokens = tokenCandidates(config);
  if (tokens.length === 0 || !channelId || !messageId) return false;

  const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${emojiEncoded}/@me`;

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
