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
  if (event === 'approval-request') return config.events.approvalRequest;
  return true;
}

function formatSessionStart(payload) {
  const project = summarizeProject(payload.projectPath || process.cwd());
  const paneLine = payload.paneId ? `Pane: \`${payload.paneId}\`` : null;
  return [
    '# Session Started',
    '',
    `Project: \`${project}\``,
    `Session: \`${payload.sessionId}\``,
    payload.tmuxSessionName ? `tmux: \`${payload.tmuxSessionName}\`` : null,
    paneLine,
    '',
    'Reply to this message to send input to the Codex session.',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSessionEnd(payload) {
  const project = summarizeProject(payload.projectPath || process.cwd());
  return [
    '# Session Ended',
    '',
    `Project: \`${project}\``,
    `Session: \`${payload.sessionId}\``,
    payload.reason ? `Reason: ${payload.reason}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatTurnComplete(payload) {
  const content = truncate(payload.content || '', 1600);
  const target = [payload.tmuxSessionName, payload.paneId].filter(Boolean).join(' ');

  return [
    '# Codex Response',
    '',
    content || '(empty response)',
    '',
    payload.sessionId ? `Session: \`${payload.sessionId}\`` : null,
    target ? `Target: \`${target}\`` : null,
  ].join('\n');
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

function formatMessage(event, payload) {
  if (event === 'session-start') return formatSessionStart(payload);
  if (event === 'session-end') return formatSessionEnd(payload);
  if (event === 'approval-request') return formatApprovalRequest(payload);
  return formatTurnComplete(payload);
}

export async function notifyEvent(event, payload) {
  const config = loadAppConfig();
  if (!eventEnabled(config, event)) {
    return { success: false, error: 'event_disabled' };
  }

  const message = payload.message || formatMessage(event, payload);
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
