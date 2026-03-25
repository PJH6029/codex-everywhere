import { DISCORD_MAX_MESSAGE_LENGTH } from './constants.js';
import { parseMentionAllowedMentions } from './config.js';
import { truncate } from './utils.js';

function findChunkBoundary(text, maxLength) {
  if (text.length <= maxLength) return text.length;

  const minimumPreferredBoundary = Math.max(1, Math.floor(maxLength * 0.5));
  const newlineBoundary = text.lastIndexOf('\n', maxLength);
  if (newlineBoundary >= minimumPreferredBoundary) {
    return newlineBoundary;
  }

  const spaceBoundary = text.lastIndexOf(' ', maxLength);
  if (spaceBoundary >= minimumPreferredBoundary) {
    return spaceBoundary;
  }

  return maxLength;
}

function splitContentBody(content, maxLength) {
  const text = String(content ?? '');
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const boundary = findChunkBoundary(remaining, maxLength);
    const splitOnSeparator =
      boundary < remaining.length && (remaining[boundary] === '\n' || remaining[boundary] === ' ');
    const chunk = remaining.slice(0, boundary);

    chunks.push(chunk);
    remaining = remaining.slice(boundary + (splitOnSeparator ? 1 : 0));
  }

  if (remaining.length > 0 || chunks.length === 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function composeContentParts(content, mention) {
  const text = String(content ?? '');
  if (!mention) {
    return splitContentBody(text, DISCORD_MAX_MESSAGE_LENGTH);
  }

  const prefix = `${mention}\n`;
  const maxBodyLength = Math.max(1, DISCORD_MAX_MESSAGE_LENGTH - prefix.length);
  const chunks = splitContentBody(text, maxBodyLength);

  if (chunks.length === 0) return [prefix];
  chunks[0] = `${prefix}${chunks[0]}`;
  return chunks;
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

function resolveMention(config, options = {}) {
  if (typeof options.mention === 'string') {
    return options.mention.trim();
  }
  if (options.mention === true) {
    return String(config.mention || '').trim();
  }
  return '';
}

function normalizeApiErrorFragment(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

export async function sendDiscordMessage(config, options) {
  const mention = resolveMention(config, options);
  const channelId = resolveChannelId(config, options);
  const tokens = tokenCandidates(config);

  if (tokens.length === 0 || !channelId) {
    return { success: false, error: 'discord_not_configured' };
  }

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const contents = composeContentParts(options.content, mention);
  const allowedMentions = parseMentionAllowedMentions(mention);

  let lastError = 'discord_send_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    const messageIds = [];
    try {
      for (let partIndex = 0; partIndex < contents.length; partIndex += 1) {
        const body = {
          content: contents[partIndex],
          allowed_mentions: allowedMentions,
        };

        if (options.replyToMessageId && partIndex === 0) {
          body.message_reference = {
            message_id: options.replyToMessageId,
            fail_if_not_exists: false,
          };
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          lastError = `discord_http_${response.status}`;
          if (response.status === 401 && idx < tokens.length - 1 && messageIds.length === 0) {
            break;
          }
          return {
            success: false,
            error: lastError,
            messageIds,
            messageId: messageIds[0],
            usedFallbackToken: idx > 0,
          };
        }

        const data = await response.json().catch(() => ({}));
        const messageId = typeof data.id === 'string' ? data.id : undefined;
        if (messageId) {
          messageIds.push(messageId);
        }
      }

      if (lastError === 'discord_http_401' && idx < tokens.length - 1 && messageIds.length === 0) {
        lastError = 'discord_send_failed';
        continue;
      }

      return {
        success: true,
        messageId: messageIds[0],
        messageIds,
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_send_failed';
      if (idx < tokens.length - 1 && messageIds.length === 0) {
        continue;
      }
      return {
        success: false,
        error: lastError,
        messageIds,
        messageId: messageIds[0],
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

export async function listCurrentUserGuilds(config, limit = 200) {
  const tokens = tokenCandidates(config);
  if (tokens.length === 0) {
    return { success: false, error: 'discord_not_configured', guilds: [] };
  }

  const query = new URLSearchParams();
  query.set('limit', String(Math.max(1, Math.min(200, limit))));
  const url = `https://discord.com/api/v10/users/@me/guilds?${query.toString()}`;

  let lastError = 'discord_list_guilds_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(tokens[idx]),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        let apiCode = '';
        let apiMessage = '';
        try {
          const payload = await response.json();
          apiCode = payload && payload.code !== undefined ? String(payload.code) : '';
          apiMessage = payload && payload.message !== undefined ? String(payload.message) : '';
        } catch {
          // ignore parse failure
        }

        const codePart = normalizeApiErrorFragment(apiCode);
        const messagePart = normalizeApiErrorFragment(apiMessage);
        const extras = [codePart, messagePart].filter(Boolean).join('_');
        lastError = extras
          ? `discord_http_${response.status}_${extras}`
          : `discord_http_${response.status}`;

        if ((response.status === 401 || response.status === 403) && idx < tokens.length - 1) continue;
        return { success: false, error: lastError, guilds: [] };
      }

      const guilds = await response.json().catch(() => []);
      return {
        success: true,
        guilds: Array.isArray(guilds) ? guilds : [],
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_list_guilds_failed';
      if (idx < tokens.length - 1) continue;
      return { success: false, error: lastError, guilds: [] };
    }
  }

  return { success: false, error: lastError, guilds: [] };
}

export async function createGuildTextChannel(config, guildId, options = {}) {
  const resolvedGuildId = String(guildId || '').trim();
  const tokens = tokenCandidates(config);
  if (!resolvedGuildId || tokens.length === 0) {
    return { success: false, error: 'discord_not_configured' };
  }

  const nameRaw = String(options.name || '').trim();
  const name = nameRaw
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 95);
  if (!name) {
    return { success: false, error: 'invalid_channel_name' };
  }

  const parentId = String(options.parentId || '').trim();
  const topic = String(options.topic || '').trim().slice(0, 1024);

  const body = {
    name,
    type: 0,
  };
  if (parentId) body.parent_id = parentId;
  if (topic) body.topic = topic;

  const url = `https://discord.com/api/v10/guilds/${resolvedGuildId}/channels`;
  let lastError = 'discord_create_channel_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: authHeaders(tokens[idx]),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        let apiCode = '';
        let apiMessage = '';
        try {
          const payload = await response.json();
          apiCode = payload && payload.code !== undefined ? String(payload.code) : '';
          apiMessage = payload && payload.message !== undefined ? String(payload.message) : '';
        } catch {
          // ignore parse failure
        }

        const codePart = normalizeApiErrorFragment(apiCode);
        const messagePart = normalizeApiErrorFragment(apiMessage);
        const extras = [codePart, messagePart].filter(Boolean).join('_');
        lastError = extras
          ? `discord_http_${response.status}_${extras}`
          : `discord_http_${response.status}`;

        if ((response.status === 401 || response.status === 403) && idx < tokens.length - 1) continue;
        return { success: false, error: lastError };
      }

      const channel = await response.json().catch(() => null);
      return { success: true, channel, usedFallbackToken: idx > 0 };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_create_channel_failed';
      if (idx < tokens.length - 1) continue;
      return { success: false, error: lastError };
    }
  }

  return { success: false, error: lastError };
}

export async function deleteDiscordChannel(config, channelId, reason = '') {
  const resolvedChannelId = resolveChannelId(config, { channelId });
  const tokens = tokenCandidates(config);
  if (tokens.length === 0 || !resolvedChannelId) {
    return { success: false, error: 'discord_not_configured' };
  }

  const url = `https://discord.com/api/v10/channels/${resolvedChannelId}`;
  const reasonText = String(reason || '').trim();

  let lastError = 'discord_delete_channel_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const headers = {
      Authorization: `Bot ${tokens[idx]}`,
    };
    if (reasonText) {
      headers['X-Audit-Log-Reason'] = encodeURIComponent(reasonText).slice(0, 512);
    }

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        let apiCode = '';
        let apiMessage = '';
        try {
          const body = await response.json();
          apiCode = body && body.code !== undefined ? String(body.code) : '';
          apiMessage = body && body.message !== undefined ? String(body.message) : '';
        } catch {
          // Ignore parse errors and keep generic status.
        }

        const codePart = normalizeApiErrorFragment(apiCode);
        const messagePart = normalizeApiErrorFragment(apiMessage);
        const extras = [codePart, messagePart].filter(Boolean).join('_');
        lastError = extras
          ? `discord_http_${response.status}_${extras}`
          : `discord_http_${response.status}`;

        if ((response.status === 401 || response.status === 403) && idx < tokens.length - 1) continue;
        return { success: false, error: lastError };
      }

      return {
        success: true,
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_delete_channel_failed';
      if (idx < tokens.length - 1) continue;
      return { success: false, error: lastError };
    }
  }

  return { success: false, error: lastError };
}

export async function updateDiscordChannel(config, channelId, options = {}) {
  const resolvedChannelId = resolveChannelId(config, { channelId });
  const tokens = tokenCandidates(config);
  if (tokens.length === 0 || !resolvedChannelId) {
    return { success: false, error: 'discord_not_configured' };
  }

  const body = {};
  if (typeof options?.name === 'string') {
    const normalizedName = options.name
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 95);
    if (!normalizedName) {
      return { success: false, error: 'invalid_channel_name' };
    }
    body.name = normalizedName;
  }

  if (typeof options?.topic === 'string') {
    body.topic = options.topic.trim().slice(0, 1024);
  }

  if (Object.keys(body).length === 0) {
    return { success: false, error: 'no_channel_update_fields' };
  }

  const url = `https://discord.com/api/v10/channels/${resolvedChannelId}`;
  const reasonText = String(options?.reason || '').trim();
  let lastError = 'discord_update_channel_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const headers = authHeaders(tokens[idx]);
    if (reasonText) {
      headers['X-Audit-Log-Reason'] = encodeURIComponent(reasonText).slice(0, 512);
    }

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        let apiCode = '';
        let apiMessage = '';
        try {
          const payload = await response.json();
          apiCode = payload && payload.code !== undefined ? String(payload.code) : '';
          apiMessage = payload && payload.message !== undefined ? String(payload.message) : '';
        } catch {
          // ignore parse failure
        }

        const codePart = normalizeApiErrorFragment(apiCode);
        const messagePart = normalizeApiErrorFragment(apiMessage);
        const extras = [codePart, messagePart].filter(Boolean).join('_');
        lastError = extras
          ? `discord_http_${response.status}_${extras}`
          : `discord_http_${response.status}`;

        if ((response.status === 401 || response.status === 403) && idx < tokens.length - 1) continue;
        return { success: false, error: lastError };
      }

      const channel = await response.json().catch(() => null);
      return {
        success: true,
        channel,
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_update_channel_failed';
      if (idx < tokens.length - 1) continue;
      return { success: false, error: lastError };
    }
  }

  return { success: false, error: lastError };
}

export async function getCurrentDiscordApplication(config) {
  const tokens = tokenCandidates(config);
  if (tokens.length === 0) {
    return { success: false, error: 'discord_not_configured' };
  }

  const url = 'https://discord.com/api/v10/applications/@me';
  let lastError = 'discord_current_application_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(tokens[idx]),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        lastError = `discord_http_${response.status}`;
        if ((response.status === 401 || response.status === 403) && idx < tokens.length - 1) continue;
        return { success: false, error: lastError };
      }

      const application = await response.json().catch(() => null);
      return {
        success: true,
        application,
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_current_application_failed';
      if (idx < tokens.length - 1) continue;
      return { success: false, error: lastError };
    }
  }

  return { success: false, error: lastError };
}

export async function getDiscordGatewayBot(config) {
  const tokens = tokenCandidates(config);
  if (tokens.length === 0) {
    return { success: false, error: 'discord_not_configured' };
  }

  const url = 'https://discord.com/api/v10/gateway/bot';
  let lastError = 'discord_gateway_bot_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(tokens[idx]),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        lastError = `discord_http_${response.status}`;
        if ((response.status === 401 || response.status === 403) && idx < tokens.length - 1) continue;
        return { success: false, error: lastError };
      }

      const gateway = await response.json().catch(() => null);
      return {
        success: true,
        gateway,
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_gateway_bot_failed';
      if (idx < tokens.length - 1) continue;
      return { success: false, error: lastError };
    }
  }

  return { success: false, error: lastError };
}

export async function upsertGuildApplicationCommand(config, applicationId, guildId, command) {
  const resolvedApplicationId = String(applicationId || '').trim();
  const resolvedGuildId = String(guildId || '').trim();
  const tokens = tokenCandidates(config);
  if (!resolvedApplicationId || !resolvedGuildId || tokens.length === 0) {
    return { success: false, error: 'discord_not_configured' };
  }

  const url = `https://discord.com/api/v10/applications/${resolvedApplicationId}/guilds/${resolvedGuildId}/commands`;
  let lastError = 'discord_upsert_application_command_failed';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: authHeaders(tokens[idx]),
        body: JSON.stringify(command || {}),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        lastError = `discord_http_${response.status}`;
        if ((response.status === 401 || response.status === 403) && idx < tokens.length - 1) continue;
        return { success: false, error: lastError };
      }

      const registeredCommand = await response.json().catch(() => null);
      return {
        success: true,
        command: registeredCommand,
        usedFallbackToken: idx > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'discord_upsert_application_command_failed';
      if (idx < tokens.length - 1) continue;
      return { success: false, error: lastError };
    }
  }

  return { success: false, error: lastError };
}

export async function createDiscordInteractionResponse(interactionId, interactionToken, body) {
  const resolvedInteractionId = String(interactionId || '').trim();
  const resolvedToken = String(interactionToken || '').trim();
  if (!resolvedInteractionId || !resolvedToken) {
    return { success: false, error: 'discord_invalid_interaction_response_request' };
  }

  const url = `https://discord.com/api/v10/interactions/${resolvedInteractionId}/${resolvedToken}/callback`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { success: false, error: `discord_http_${response.status}` };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'discord_create_interaction_response_failed',
    };
  }
}

export async function editDiscordInteractionResponse(applicationId, interactionToken, options = {}) {
  const resolvedApplicationId = String(applicationId || '').trim();
  const resolvedToken = String(interactionToken || '').trim();
  if (!resolvedApplicationId || !resolvedToken) {
    return { success: false, error: 'discord_invalid_interaction_edit_request' };
  }

  const body = {};
  if (typeof options?.content === 'string') {
    body.content = truncate(String(options.content), DISCORD_MAX_MESSAGE_LENGTH);
    body.allowed_mentions = { parse: [] };
  }

  if (Object.keys(body).length === 0) {
    return { success: false, error: 'discord_no_interaction_response_fields' };
  }

  const url = `https://discord.com/api/v10/webhooks/${resolvedApplicationId}/${resolvedToken}/messages/@original`;

  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { success: false, error: `discord_http_${response.status}` };
    }

    const message = await response.json().catch(() => null);
    return { success: true, message };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'discord_edit_interaction_response_failed',
    };
  }
}
