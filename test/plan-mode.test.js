import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPlanPrompt,
  parseCeSlashCommand,
  parseLifecycleCommand,
  parsePlanDecision,
} from '../src/reply-daemon.js';
import { parseCodexSessionLogLine } from '../src/codex-session-commentary.js';

test('parseLifecycleCommand recognizes legacy plan command', () => {
  assert.deepEqual(parseLifecycleCommand('!ce-plan'), { kind: 'enter-plan-mode' });
  assert.deepEqual(parseLifecycleCommand('!codex-plan'), { kind: 'enter-plan-mode' });
});

test('parsePlanDecision recognizes implement and stay responses', () => {
  assert.deepEqual(parsePlanDecision('1'), { key: '1', label: 'implement_plan' });
  assert.deepEqual(parsePlanDecision('yes implement it'), { key: '1', label: 'implement_plan' });
  assert.deepEqual(parsePlanDecision('2'), { key: '2', label: 'stay_in_plan_mode' });
  assert.deepEqual(parsePlanDecision('stay in plan mode'), { key: '2', label: 'stay_in_plan_mode' });
  assert.equal(parsePlanDecision('maybe later'), null);
});

test('detectPlanPrompt identifies Codex plan popup', () => {
  const prompt = [
    'Implement this plan?',
    '',
    '1. Yes, implement this plan',
    '2. No, stay in Plan mode',
  ].join('\n');

  const detected = detectPlanPrompt(prompt);
  assert.ok(detected);
  assert.equal(detected.question, 'Implement this plan?');
  assert.match(detected.signature, /^[a-f0-9]{16}$/);
});

test('parseCeSlashCommand recognizes /ce plan', () => {
  const interaction = {
    data: {
      name: 'ce',
      options: [
        {
          type: 1,
          name: 'plan',
        },
      ],
    },
  };

  assert.deepEqual(parseCeSlashCommand(interaction), { kind: 'enter-plan-mode' });
});

test('parseCodexSessionLogLine parses collaboration mode start events', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'task_started',
      collaboration_mode_kind: 'plan',
    },
  });

  assert.deepEqual(parseCodexSessionLogLine(line), {
    type: 'collaboration-mode',
    mode: 'plan',
  });
});

test('parseCodexSessionLogLine parses completed plan items', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        id: 'plan_123',
        type: 'Plan',
        text: '1. Inspect\n2. Patch\n3. Verify',
      },
    },
  });

  assert.deepEqual(parseCodexSessionLogLine(line), {
    type: 'plan-completed',
    itemId: 'plan_123',
    planText: '1. Inspect\n2. Patch\n3. Verify',
  });
});
