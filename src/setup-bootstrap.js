#!/usr/bin/env node

import { existsSync } from 'fs';
import { copyFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const SETUP_SKILL_SOURCE_PATH = fileURLToPath(
  new URL('../.agents/skills/setup-discord/SKILL.md', import.meta.url),
);
const SETUP_SKILL_DEST_PATH = resolve(
  process.env.HOME || '',
  '.codex',
  'skills',
  'setup-discord',
  'SKILL.md',
);

function parseBootstrapArgs(args) {
  const parsed = {
    installMissing: true,
    launch: true,
    unsafe: false,
    model: '',
  };

  for (let idx = 0; idx < args.length; idx += 1) {
    const token = String(args[idx] || '').trim();
    if (!token) continue;

    if (token === '--no-install') {
      parsed.installMissing = false;
      continue;
    }
    if (token === '--no-launch') {
      parsed.launch = false;
      continue;
    }
    if (token === '--unsafe') {
      parsed.unsafe = true;
      continue;
    }
    if (token === '--model' || token === '-m') {
      const value = String(args[idx + 1] || '').trim();
      if (!value || value.startsWith('-')) {
        throw new Error('`--model` requires a value');
      }
      parsed.model = value;
      idx += 1;
      continue;
    }
    if (token.startsWith('--model=')) {
      parsed.model = token.slice('--model='.length).trim();
      if (!parsed.model) throw new Error('`--model` requires a value');
      continue;
    }

    throw new Error(`unknown setup bootstrap option: ${token}`);
  }

  return parsed;
}

function commandExists(command, versionArgs = ['--version']) {
  const result = spawnSync(command, versionArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 8000,
  });
  return !result.error && result.status === 0;
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: options.stdio || 'inherit',
    encoding: options.encoding || 'utf-8',
    timeout: options.timeout ?? 0,
  });
}

function tryInstallCodex() {
  console.log('[codex-everywhere] installing codex CLI globally (npm i -g @openai/codex)...');
  const result = runCommand('npm', ['i', '-g', '@openai/codex']);
  return !result.error && result.status === 0;
}

function runPackageInstall(packageManager, args) {
  const hasSudo = commandExists('sudo', ['-V']);
  const canUseSudo = typeof process.getuid === 'function' && process.getuid() !== 0 && hasSudo;
  if (canUseSudo) {
    const sudoResult = runCommand('sudo', [packageManager, ...args]);
    return !sudoResult.error && sudoResult.status === 0;
  }
  const result = runCommand(packageManager, args);
  return !result.error && result.status === 0;
}

function tryInstallTmux() {
  console.log('[codex-everywhere] tmux not found; attempting auto-install...');

  if (process.platform === 'darwin') {
    if (!commandExists('brew')) return false;
    return runPackageInstall('brew', ['install', 'tmux']);
  }

  if (process.platform === 'linux') {
    if (commandExists('apt-get')) {
      return runPackageInstall('apt-get', ['install', '-y', 'tmux']);
    }
    if (commandExists('dnf')) {
      return runPackageInstall('dnf', ['install', '-y', 'tmux']);
    }
    if (commandExists('yum')) {
      return runPackageInstall('yum', ['install', '-y', 'tmux']);
    }
    if (commandExists('pacman')) {
      return runPackageInstall('pacman', ['-S', '--noconfirm', 'tmux']);
    }
  }

  return false;
}

function ensurePlaywrightMcp() {
  if (!commandExists('codex')) {
    throw new Error('codex not found while configuring MCP');
  }

  console.log('[codex-everywhere] ensuring playwright MCP server is configured...');
  const addResult = runCommand(
    'codex',
    ['mcp', 'add', 'playwright', '--', 'npx', '-y', '@playwright/mcp@latest'],
    { stdio: 'pipe', encoding: 'utf-8', timeout: 30000 },
  );

  if (addResult.error || addResult.status !== 0) {
    const stderr = String(addResult.stderr || '').trim();
    const stdout = String(addResult.stdout || '').trim();
    throw new Error(`failed to configure playwright MCP (${stderr || stdout || 'unknown error'})`);
  }
}

async function ensureSetupDiscordSkillInstalled() {
  if (!process.env.HOME) {
    throw new Error('HOME environment variable is not set');
  }
  if (!existsSync(SETUP_SKILL_SOURCE_PATH)) {
    throw new Error(`setup-discord skill source not found: ${SETUP_SKILL_SOURCE_PATH}`);
  }

  await mkdir(dirname(SETUP_SKILL_DEST_PATH), { recursive: true });
  await copyFile(SETUP_SKILL_SOURCE_PATH, SETUP_SKILL_DEST_PATH);
  console.log(`[codex-everywhere] installed skill at ${SETUP_SKILL_DEST_PATH}`);
}

function launchGuidedSetupSession(options) {
  const prompt = [
    'Run $setup-discord and complete codex-everywhere Discord setup end-to-end.',
    'Target server name: codex-everywhere-server.',
    'Use default control channel (일반 in Korean locale, general in English locale).',
    'If Discord requests login, CAPTCHA, or re-authentication, ask the user to complete it.',
    'After setup, verify daemon is started and tell the user to type !ce-new in the control channel.',
  ].join(' ');

  const args = ['--no-alt-screen'];
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.unsafe) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request');
  }
  args.push(prompt);

  console.log('[codex-everywhere] launching codex for guided setup...');
  const result = runCommand('codex', args);
  if (result.error) {
    throw new Error(result.error.message || 'failed to launch codex');
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`codex exited with status ${result.status}`);
  }
}

export async function runBootstrapSetupCommand(args = []) {
  const options = parseBootstrapArgs(args);

  if (!commandExists('codex')) {
    if (!options.installMissing || !tryInstallCodex() || !commandExists('codex')) {
      throw new Error('codex binary not found. Install with: npm i -g @openai/codex');
    }
  }

  if (!commandExists('tmux', ['-V'])) {
    if (!options.installMissing || !tryInstallTmux() || !commandExists('tmux', ['-V'])) {
      throw new Error(
        'tmux is required. Install tmux, then rerun `codex-everywhere setup bootstrap`.',
      );
    }
  }

  ensurePlaywrightMcp();
  await ensureSetupDiscordSkillInstalled();

  console.log('[codex-everywhere] bootstrap preparation complete.');
  console.log('[codex-everywhere] user actions still required during setup: /permissions approval, CAPTCHA, and Discord re-auth prompts.');

  if (!options.launch) {
    console.log('[codex-everywhere] launch skipped (`--no-launch`).');
    console.log('[codex-everywhere] next: run `codex` and type `$setup-discord`.');
    return;
  }

  launchGuidedSetupSession(options);
}

