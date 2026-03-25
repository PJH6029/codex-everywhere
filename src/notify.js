import { sendDiscordMessage } from './discord.js';
import { loadAppConfig } from './config.js';
import { registerMessageMapping } from './registry.js';
import { summarizeProject, truncate } from './utils.js';

function eventEnabled(config, event) {
  if (!config.notificationsEnabled) return false;
  if (!config.discordBot.enabled) return false;

  if (event === 'session-start') return config.events.sessionStart;
  if (event === 'session-end') return config.events.sessionEnd;
  if (event === 'progress-update') return config.events.progressUpdate;
  if (event === 'turn-complete') return config.events.turnComplete;
  if (event === 'user-input') return config.events.userInput;
  if (event === 'approval-request') return config.events.approvalRequest;
  if (event === 'ask-user-question') return config.events.askUserQuestion;
  if (event === 'plan-decision-request') return config.events.askUserQuestion;
  return true;
}

function shouldMentionEvent(event) {
  return event === 'session-start' || event === 'turn-complete';
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
  const content = String(payload.content || '');
  const target = [payload.tmuxSessionName, payload.paneId].filter(Boolean).join(' ');

  const lines = ['# Result', '', content || '(empty response)'];
  if (debug && payload.sessionId) lines.push('', `Session: \`${payload.sessionId}\``);
  if (debug && target) lines.push(`Target: \`${target}\``);
  return lines.join('\n');
}

function formatProgressUpdate(payload, debug = false) {
  const content = String(payload.content || '');
  const target = [payload.tmuxSessionName, payload.paneId].filter(Boolean).join(' ');
  const includeHeader = payload.includeHeader !== false;

  return [
    includeHeader ? '# Progress' : null,
    includeHeader ? '' : null,
    content || '(empty update)',
    '',
    debug && payload.sessionId ? `Session: \`${payload.sessionId}\`` : null,
    debug && target ? `Target: \`${target}\`` : null,
  ]
    .filter(Boolean)
    .join('\n');
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

function formatAskUserQuestion(payload) {
  const prompt = truncate(String(payload.content || payload.question || ''), 1300);
  const formattedPrompt =
    prompt && prompt.includes('\n') ? `\`\`\`text\n${prompt}\n\`\`\`` : prompt;
  return [
    '# Input Needed',
    '',
    formattedPrompt || 'Codex is waiting for your response.',
    '',
    'Reply in this channel to continue.',
  ].join('\n');
}

function formatPlanDecisionRequest(payload) {
  const planText = String(payload.content || '').trim();
  return [
    '# Proposed Plan',
    '',
    'Codex proposed the plan below.',
    '',
    'Reply with `1` to implement it or `2` to stay in Plan mode.',
    '',
    planText || '(empty plan)',
  ].join('\n');
}

function formatMessage(event, payload, debug = false) {
  if (event === 'session-start') return formatSessionStart(payload, debug);
  if (event === 'session-end') return formatSessionEnd(payload, debug);
  if (event === 'progress-update') return formatProgressUpdate(payload, debug);
  if (event === 'user-input') return formatUserInput(payload, debug);
  if (event === 'approval-request') return formatApprovalRequest(payload);
  if (event === 'ask-user-question') return formatAskUserQuestion(payload);
  if (event === 'plan-decision-request') return formatPlanDecisionRequest(payload);
  return formatTurnComplete(payload, debug);
}

function mappingKindForEvent(event) {
  if (event === 'approval-request') return 'approval';
  if (event === 'plan-decision-request') return 'plan-decision';
  return 'chat';
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
    mention: shouldMentionEvent(event),
  });

  const messageIds = Array.isArray(result.messageIds)
    ? result.messageIds.filter((messageId) => typeof messageId === 'string' && messageId.trim())
    : result.messageId
      ? [result.messageId]
      : [];

  if (messageIds.length > 0 && payload.paneId) {
    for (const messageId of messageIds) {
      await registerMessageMapping({
        platform: 'discord-bot',
        messageId,
        sessionId: payload.sessionId,
        tmuxPaneId: payload.paneId,
        tmuxSessionName: payload.tmuxSessionName || '',
        channelId: payload.channelId || config.discordBot.channelId || '',
        event,
        kind: mappingKindForEvent(event),
        projectPath: payload.projectPath,
      });
    }
  }

  return result;
}
