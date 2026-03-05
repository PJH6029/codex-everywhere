#!/usr/bin/env node

import { existsSync } from 'fs';
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

const SETUP_SKILL_SOURCE_PATH = fileURLToPath(
  new URL('../.agents/skills/setup-discord/SKILL.md', import.meta.url),
);
const PROJECT_CODEX_CONFIG_PATH = resolve(process.cwd(), '.codex', 'config.toml');
const GLOBAL_CODEX_CONFIG_PATH = resolve(process.env.HOME || '', '.codex', 'config.toml');
const PROJECT_CONFIG_BEGIN = '# BEGIN codex-everywhere bootstrap config';
const PROJECT_CONFIG_END = '# END codex-everywhere bootstrap config';

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlString(value) {
  return `"${String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')}"`;
}

function normalizePathForToml(value) {
  return String(value || '').replace(/\\/g, '/');
}

function resolveLocalSkillDir(cwd) {
  return resolve(cwd, '.agents', 'skills', 'setup-discord');
}

function resolveLocalSkillFile(cwd) {
  return resolve(resolveLocalSkillDir(cwd), 'SKILL.md');
}

function buildProjectConfigBlock(cwd) {
  const playwrightProfileDir = resolve(cwd, '.codex', 'playwright-mcp-profile');
  return [
    PROJECT_CONFIG_BEGIN,
    '[mcp_servers.playwright]',
    'command = "npx"',
    `args = ["-y", "@playwright/mcp@latest", "--user-data-dir=${playwrightProfileDir.replace(/\\/g, '/')}"]`,
    '',
    '[apps.playwright.tools.browser_navigate]',
    'approval_mode = "approve"',
    '',
    '[apps.playwright.tools.browser_click]',
    'approval_mode = "approve"',
    '',
    '[apps.playwright.tools.browser_type]',
    'approval_mode = "approve"',
    '',
    '[apps.playwright.tools.browser_fill_form]',
    'approval_mode = "approve"',
    '',
    '[apps.playwright.tools.browser_close]',
    'approval_mode = "approve"',
    PROJECT_CONFIG_END,
    '',
  ].join('\n');
}

async function readTextOrEmpty(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

async function writeProjectConfigBlock(cwd) {
  const current = await readTextOrEmpty(PROJECT_CODEX_CONFIG_PATH);
  const hasPlaywrightSections =
    current.includes('[mcp_servers.playwright]') ||
    current.includes('[apps.playwright.tools.browser_navigate]');
  const block = buildProjectConfigBlock(cwd);

  let next = current;
  if (current.includes(PROJECT_CONFIG_BEGIN) && current.includes(PROJECT_CONFIG_END)) {
    const pattern = new RegExp(
      `${escapeRegExp(PROJECT_CONFIG_BEGIN)}[\\s\\S]*?${escapeRegExp(PROJECT_CONFIG_END)}\\n?`,
      'm',
    );
    next = current.replace(pattern, block);
  } else if (hasPlaywrightSections) {
    // Preserve user-owned sections when they already configured this manually.
    console.log('[codex-everywhere] project .codex/config.toml already has playwright config; leaving as-is.');
    return;
  } else if (!current.trim()) {
    next = `${block}`;
  } else {
    next = `${current.trimEnd()}\n\n${block}`;
  }

  await mkdir(dirname(PROJECT_CODEX_CONFIG_PATH), { recursive: true });
  await writeFile(PROJECT_CODEX_CONFIG_PATH, next, 'utf-8');
  console.log(`[codex-everywhere] wrote project config: ${PROJECT_CODEX_CONFIG_PATH}`);
}

function replaceTrustInsideProjectTable(content, escapedProjectPath) {
  const header = `[projects.${tomlString(escapedProjectPath)}]`;
  const headerIndex = content.indexOf(header);
  if (headerIndex < 0) return null;

  const headerEnd = content.indexOf('\n', headerIndex);
  const sectionStart = headerEnd >= 0 ? headerEnd + 1 : content.length;
  const rest = content.slice(sectionStart);
  const nextTableMatch = rest.match(/^\s*\[[^\]]+\]/m);
  const sectionEnd = nextTableMatch ? sectionStart + nextTableMatch.index : content.length;
  const section = content.slice(sectionStart, sectionEnd);

  let updatedSection = section;
  if (/^\s*trust_level\s*=.*$/m.test(section)) {
    updatedSection = section.replace(/^\s*trust_level\s*=.*$/m, 'trust_level = "trusted"');
  } else {
    updatedSection = `${section.trimEnd()}\ntrust_level = "trusted"\n`;
  }

  return `${content.slice(0, sectionStart)}${updatedSection}${content.slice(sectionEnd)}`;
}

async function ensureProjectTrusted(cwd) {
  if (!process.env.HOME) {
    throw new Error('HOME environment variable is not set');
  }

  const escapedProjectPath = String(cwd || '').replace(/\\/g, '/');
  const quotedPath = tomlString(escapedProjectPath);
  const dottedTrustLine = `projects.${quotedPath}.trust_level = "trusted"`;
  const dottedRegex = new RegExp(
    `^\\s*projects\\.${escapeRegExp(quotedPath)}\\.trust_level\\s*=\\s*".*?"\\s*$`,
    'm',
  );

  const markerId = createHash('sha256').update(escapedProjectPath).digest('hex').slice(0, 12);
  const begin = `# BEGIN codex-everywhere project trust ${markerId}`;
  const end = `# END codex-everywhere project trust ${markerId}`;
  const block = `${begin}\n${dottedTrustLine}\n${end}\n`;

  const current = await readTextOrEmpty(GLOBAL_CODEX_CONFIG_PATH);
  let next = current;

  if (dottedRegex.test(current)) {
    next = current.replace(dottedRegex, dottedTrustLine);
  } else {
    const tableUpdated = replaceTrustInsideProjectTable(current, escapedProjectPath);
    if (tableUpdated !== null) {
      next = tableUpdated;
    } else if (current.includes(begin) && current.includes(end)) {
      const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, 'm');
      next = current.replace(pattern, block);
    } else if (!current.trim()) {
      next = block;
    } else {
      next = `${current.trimEnd()}\n\n${block}`;
    }
  }

  await mkdir(dirname(GLOBAL_CODEX_CONFIG_PATH), { recursive: true });
  await writeFile(GLOBAL_CODEX_CONFIG_PATH, next, 'utf-8');
  console.log(`[codex-everywhere] marked project as trusted in ${GLOBAL_CODEX_CONFIG_PATH}`);
}

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

async function ensureSetupDiscordSkillInstalled(cwd) {
  const localSkillFile = resolveLocalSkillFile(cwd);
  if (existsSync(localSkillFile)) {
    console.log(`[codex-everywhere] local skill already present at ${localSkillFile}`);
    return;
  }

  if (!existsSync(SETUP_SKILL_SOURCE_PATH)) {
    throw new Error(`setup-discord skill source not found: ${SETUP_SKILL_SOURCE_PATH}`);
  }

  const sourceResolved = resolve(SETUP_SKILL_SOURCE_PATH);
  const destinationResolved = resolve(localSkillFile);
  if (sourceResolved === destinationResolved) {
    console.log(`[codex-everywhere] local skill already present at ${localSkillFile}`);
    return;
  }

  await mkdir(dirname(localSkillFile), { recursive: true });
  await copyFile(sourceResolved, destinationResolved);
  console.log(`[codex-everywhere] installed local skill at ${destinationResolved}`);
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
  const cwd = process.cwd();

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

  await writeProjectConfigBlock(cwd);
  await ensureProjectTrusted(cwd);
  await ensureSetupDiscordSkillInstalled(cwd);

  console.log('[codex-everywhere] bootstrap preparation complete.');
  console.log('[codex-everywhere] project-scoped Codex config for playwright MCP + tool approvals is ready.');
  console.log('[codex-everywhere] user actions still required during setup: /permissions approval, CAPTCHA, and Discord re-auth prompts.');

  if (!options.launch) {
    console.log('[codex-everywhere] launch skipped (`--no-launch`).');
    console.log('[codex-everywhere] next: run `codex` and type `$setup-discord`.');
    return;
  }

  launchGuidedSetupSession(options);
}
