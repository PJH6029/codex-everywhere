import {
  createDiscordInteractionResponse,
  editDiscordInteractionResponse,
  getCurrentDiscordApplication,
  getDiscordGatewayBot,
  upsertGuildApplicationCommand,
} from './discord.js';

const GATEWAY_VERSION = '10';
const GATEWAY_ENCODING = 'json';
const GATEWAY_OP_DISPATCH = 0;
const GATEWAY_OP_HEARTBEAT = 1;
const GATEWAY_OP_IDENTIFY = 2;
const GATEWAY_OP_RECONNECT = 7;
const GATEWAY_OP_INVALID_SESSION = 9;
const GATEWAY_OP_HELLO = 10;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE = 4;
const MESSAGE_FLAG_EPHEMERAL = 1 << 6;
const COMMAND_TYPE_CHAT_INPUT = 1;
const OPTION_TYPE_SUBCOMMAND = 1;
const OPTION_TYPE_STRING = 3;
const OPTION_TYPE_BOOLEAN = 5;
const SLASH_COMMAND_NAME = 'ce';

function commandChoice(name, value) {
  return { name, value };
}

export function buildCeApplicationCommand() {
  return {
    type: COMMAND_TYPE_CHAT_INPUT,
    name: SLASH_COMMAND_NAME,
    description: 'Control codex-everywhere sessions',
    dm_permission: false,
    options: [
      {
        type: OPTION_TYPE_SUBCOMMAND,
        name: 'new',
        description: 'Create a new Codex session channel',
        options: [
          {
            type: OPTION_TYPE_STRING,
            name: 'name',
            description: 'Optional channel/session name',
            required: false,
          },
          {
            type: OPTION_TYPE_STRING,
            name: 'cwd',
            description: 'Working directory to launch Codex from',
            required: false,
          },
          {
            type: OPTION_TYPE_STRING,
            name: 'approval',
            description: 'Approval policy',
            required: false,
            choices: [
              commandChoice('untrusted', 'untrusted'),
              commandChoice('on-request', 'on-request'),
              commandChoice('on-failure', 'on-failure'),
              commandChoice('never', 'never'),
            ],
          },
          {
            type: OPTION_TYPE_STRING,
            name: 'sandbox',
            description: 'Sandbox mode',
            required: false,
            choices: [
              commandChoice('read-only', 'read-only'),
              commandChoice('workspace-write', 'workspace-write'),
              commandChoice('danger-full-access', 'danger-full-access'),
            ],
          },
          {
            type: OPTION_TYPE_BOOLEAN,
            name: 'full-auto',
            description: 'Use full-auto launch defaults',
            required: false,
          },
        ],
      },
      {
        type: OPTION_TYPE_SUBCOMMAND,
        name: 'perm',
        description: 'Update launch policy for the current session',
        options: [
          {
            type: OPTION_TYPE_STRING,
            name: 'approval',
            description: 'Approval policy',
            required: false,
            choices: [
              commandChoice('untrusted', 'untrusted'),
              commandChoice('on-request', 'on-request'),
              commandChoice('on-failure', 'on-failure'),
              commandChoice('never', 'never'),
            ],
          },
          {
            type: OPTION_TYPE_STRING,
            name: 'sandbox',
            description: 'Sandbox mode',
            required: false,
            choices: [
              commandChoice('read-only', 'read-only'),
              commandChoice('workspace-write', 'workspace-write'),
              commandChoice('danger-full-access', 'danger-full-access'),
            ],
          },
          {
            type: OPTION_TYPE_BOOLEAN,
            name: 'full-auto',
            description: 'Use full-auto launch defaults',
            required: false,
          },
          {
            type: OPTION_TYPE_BOOLEAN,
            name: 'default',
            description: 'Reset to the default launch policy',
            required: false,
          },
        ],
      },
      {
        type: OPTION_TYPE_SUBCOMMAND,
        name: 'meta',
        description: 'Show metadata for the current session',
      },
      {
        type: OPTION_TYPE_SUBCOMMAND,
        name: 'plan',
        description: 'Switch the current session to Codex Plan mode',
      },
      {
        type: OPTION_TYPE_SUBCOMMAND,
        name: 'exit',
        description: 'Exit the current session',
      },
      {
        type: OPTION_TYPE_SUBCOMMAND,
        name: 'help',
        description: 'Show codex-everywhere help',
      },
    ],
  };
}

function interactionUserId(interaction) {
  const memberUserId = String(interaction?.member?.user?.id || '').trim();
  if (memberUserId) return memberUserId;
  return String(interaction?.user?.id || '').trim();
}

function gatewayConnectionUrl(rawUrl) {
  const base = String(rawUrl || '').trim();
  if (!base) return '';
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}v=${GATEWAY_VERSION}&encoding=${GATEWAY_ENCODING}`;
}

function immediateEphemeralMessage(content) {
  return {
    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
    data: {
      content: String(content || '').trim() || 'Request rejected.',
      flags: MESSAGE_FLAG_EPHEMERAL,
    },
  };
}

function immediateChannelMessage(content) {
  return {
    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
    data: {
      content: String(content || '').trim() || 'Processing `/ce`...',
      allowed_mentions: { parse: [] },
    },
  };
}

export async function createDiscordSlashCommandRuntime(config, guildId, callbacks = {}) {
  const botConfig = config?.discordBot || {};

  const applicationResult = await getCurrentDiscordApplication(botConfig);
  if (!applicationResult.success) {
    throw new Error(applicationResult.error || 'discord_current_application_failed');
  }

  const applicationId = String(applicationResult?.application?.id || '').trim();
  if (!applicationId) {
    throw new Error('discord_current_application_missing_id');
  }

  const commandResult = await upsertGuildApplicationCommand(
    botConfig,
    applicationId,
    guildId,
    buildCeApplicationCommand(),
  );
  if (!commandResult.success) {
    throw new Error(commandResult.error || 'discord_upsert_application_command_failed');
  }

  const gatewayResult = await getDiscordGatewayBot(botConfig);
  if (!gatewayResult.success) {
    throw new Error(gatewayResult.error || 'discord_gateway_bot_failed');
  }

  const rawGatewayUrl = String(gatewayResult?.gateway?.url || '').trim();
  const url = gatewayConnectionUrl(rawGatewayUrl);
  if (!url) {
    throw new Error('discord_gateway_url_missing');
  }

  const authorizedIds = new Set(
    Array.isArray(config?.reply?.authorizedDiscordUserIds)
      ? config.reply.authorizedDiscordUserIds
      : [],
  );

  let socket = null;
  let stopped = false;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let sequence = null;
  let reconnectDelayMs = 1000;

  function clearTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function emitError(error) {
    if (typeof callbacks?.onError === 'function') {
      callbacks.onError(error);
    }
  }

  function sendGatewayPayload(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  function startHeartbeat(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    heartbeatTimer = setInterval(() => {
      sendGatewayPayload({
        op: GATEWAY_OP_HEARTBEAT,
        d: sequence,
      });
    }, intervalMs);
  }

  async function handleInteraction(interaction) {
    if (interaction?.type !== INTERACTION_TYPE_APPLICATION_COMMAND) return;
    if (String(interaction?.data?.name || '').trim() !== SLASH_COMMAND_NAME) return;

    const userId = interactionUserId(interaction);
    if (!authorizedIds.has(userId)) {
      await createDiscordInteractionResponse(
        interaction.id,
        interaction.token,
        immediateEphemeralMessage('You are not authorized to run `/ce` commands.'),
      ).catch(() => {});
      return;
    }

    const acknowledged = await createDiscordInteractionResponse(
      interaction.id,
      interaction.token,
      immediateChannelMessage('Processing `/ce`...'),
    );
    if (!acknowledged.success) {
      emitError(new Error(acknowledged.error || 'discord_create_interaction_response_failed'));
      return;
    }

    try {
      if (typeof callbacks?.onInteraction === 'function') {
        await callbacks.onInteraction(interaction);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await editDiscordInteractionResponse(
        interaction.application_id,
        interaction.token,
        { content: `Command failed: ${message}` },
      ).catch(() => {});
      emitError(error instanceof Error ? error : new Error(message));
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) {
        connect();
      }
    }, delay);
  }

  function connect() {
    clearTimers();
    socket = new WebSocket(url);

    socket.addEventListener('message', async (event) => {
      let payload = null;
      try {
        payload = JSON.parse(String(event.data || ''));
      } catch (error) {
        emitError(error instanceof Error ? error : new Error('discord_gateway_payload_parse_failed'));
        return;
      }

      if (Number.isFinite(payload?.s)) {
        sequence = payload.s;
      }

      if (payload?.op === GATEWAY_OP_HELLO) {
        const intervalMs = Number(payload?.d?.heartbeat_interval || 0);
        reconnectDelayMs = 1000;
        startHeartbeat(intervalMs);
        sendGatewayPayload({
          op: GATEWAY_OP_IDENTIFY,
          d: {
            token: config.discordBot.botToken,
            intents: 0,
            properties: {
              os: process.platform,
              browser: 'codex-everywhere',
              device: 'codex-everywhere',
            },
          },
        });
        return;
      }

      if (payload?.op === GATEWAY_OP_RECONNECT || payload?.op === GATEWAY_OP_INVALID_SESSION) {
        try {
          socket.close();
        } catch {
          // Best effort
        }
        return;
      }

      if (payload?.op === GATEWAY_OP_DISPATCH && payload?.t === 'INTERACTION_CREATE') {
        await handleInteraction(payload.d);
      }
    });

    socket.addEventListener('close', () => {
      clearTimers();
      if (!stopped) {
        scheduleReconnect();
      }
    });

    socket.addEventListener('error', () => {
      emitError(new Error('discord_gateway_socket_error'));
    });
  }

  connect();

  return {
    applicationId,
    guildId,
    async stop() {
      stopped = true;
      clearTimers();
      if (socket) {
        try {
          socket.close(1000, 'shutdown');
        } catch {
          // Best effort
        }
      }
    },
  };
}
