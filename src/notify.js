import { sendDiscordMessage } from './discord.js';
import { loadAppConfig } from './config.js';
import { registerMessageMapping } from './registry.js';
import { summarizeProject, truncate } from './utils.js';

function eventEnabled(config, event) {
  if (!config.notificationsEnabled) return false;
  if (!config.discordBot.enabled) return false;

  if (event === 'session-start') return config.events.sessionStart;
  if (event === 'session-end') return config.events.sessionEnd;
  if (event === 'turn-complete') return config.events.turnComplete;
  if (event === 'user-input') return config.events.userInput;
  if (event === 'approval-request') return config.events.approvalRequest;
  return true;
}

function formatSessionStart(payload, debug = false) {
  const project = summarizeProject(payload.projectPath || process.cwd());
  const paneLine = debug && payload.paneId ? `Pane: \`${payload.paneId}\`` : null;
  return [
    '# Session Started',
    '',
    `Project: \`${project}\``,
    debug ? `Session: \`${payload.sessionId}\`` : null,
    debug && payload.tmuxSessionName ? `tmux: \`${payload.tmuxSessionName}\`` : null,
    paneLine,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSessionEnd(payload, debug = false) {
  const project = summarizeProject(payload.projectPath || process.cwd());
  return [
    '# Session Ended',
    '',
    `Project: \`${project}\``,
    debug ? `Session: \`${payload.sessionId}\`` : null,
    payload.reason ? `Reason: ${payload.reason}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatTurnComplete(payload, debug = false) {
  const content = truncate(payload.content || '', 1600);
  const target = [payload.tmuxSessionName, payload.paneId].filter(Boolean).join(' ');

  const lines = [content || '(empty response)'];
  if (debug && payload.sessionId) lines.push('', `Session: \`${payload.sessionId}\``);
  if (debug && target) lines.push(`Target: \`${target}\``);
  return lines.join('\n');
}

function formatUserInput(payload, debug = false) {
  const content = truncate(payload.content || '', 1600);
  const target = [payload.tmuxSessionName, payload.paneId].filter(Boolean).join(' ');

  return [
    '# User Input (tmux)',
    '',
    content ? `\`\`\`text\n${content}\n\`\`\`` : '(empty input)',
    '',
    debug && payload.sessionId ? `Session: \`${payload.sessionId}\`` : null,
    debug && target ? `Target: \`${target}\`` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatApprovalRequest(payload) {
  const command = payload.command ? `\`\`\`bash\n${truncate(payload.command, 600)}\n\`\`\`` : 'Command not detected from pane output.';

  return [
    '# Approval Needed',
    '',
    'Codex is waiting for permission before running a command.',
    '',
    command,
    '',
    'Reply with one of: `y` (approve once), `p` (approve this command prefix), `n` (deny).',
  ].join('\n');
}

function formatMessage(event, payload, debug = false) {
  if (event === 'session-start') return formatSessionStart(payload, debug);
  if (event === 'session-end') return formatSessionEnd(payload, debug);
  if (event === 'user-input') return formatUserInput(payload, debug);
  if (event === 'approval-request') return formatApprovalRequest(payload);
  return formatTurnComplete(payload, debug);
}

export async function notifyEvent(event, payload) {
  const config = loadAppConfig();
  if (!eventEnabled(config, event)) {
    return { success: false, error: 'event_disabled' };
  }

  const message = payload.message || formatMessage(event, payload, config.debug === true);
  const result = await sendDiscordMessage(config.discordBot, {
    content: message,
    replyToMessageId: payload.replyToMessageId,
    channelId: payload.channelId,
  });

  if (result.success && result.messageId && payload.paneId) {
    await registerMessageMapping({
      platform: 'discord-bot',
      messageId: result.messageId,
      sessionId: payload.sessionId,
      tmuxPaneId: payload.paneId,
      tmuxSessionName: payload.tmuxSessionName || '',
      channelId: payload.channelId || config.discordBot.channelId || '',
      event,
      kind: event === 'approval-request' ? 'approval' : 'chat',
      projectPath: payload.projectPath,
    });
  }

  return result;
}
