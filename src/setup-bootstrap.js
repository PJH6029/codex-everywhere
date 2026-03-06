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
const BOOTSTRAP_GUIDED_PROMPT_TEMPLATE_PATH = fileURLToPath(
  new URL('../bootstrap/guided-setup-prompt.txt', import.meta.url),
);
const GLOBAL_CODEX_CONFIG_PATH = resolve(process.env.HOME || '', '.codex', 'config.toml');
const DEFAULT_SETUP_MODEL = 'gpt-5.4';
const FALLBACK_SETUP_MODEL = 'gpt-5.3-codex';
const BOOTSTRAP_REASONING_EFFORT = 'xhigh';

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlString(value) {
  return `"${String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')}"`;
}

function resolveLocalSkillDir(cwd) {
  return resolve(cwd, '.agents', 'skills', 'setup-discord');
}

function resolveLocalSkillFile(cwd) {
  return resolve(resolveLocalSkillDir(cwd), 'SKILL.md');
}

function resolveCodexHome() {
  const configuredHome = String(process.env.CODEX_HOME || '').trim();
  if (configuredHome) return resolve(configuredHome);
  if (process.env.HOME) return resolve(process.env.HOME, '.codex');
  throw new Error('HOME environment variable is not set');
}

function resolveGlobalPlaywrightSkillDir() {
  return resolve(resolveCodexHome(), 'skills', 'playwright');
}

function resolveGlobalPlaywrightSkillFile() {
  return resolve(resolveGlobalPlaywrightSkillDir(), 'SKILL.md');
}

function resolveGlobalPlaywrightWrapperPath() {
  return resolve(resolveGlobalPlaywrightSkillDir(), 'scripts', 'playwright_cli.sh');
}

function getPlaywrightSkillStatus() {
  const skillFile = resolveGlobalPlaywrightSkillFile();
  const wrapperPath = resolveGlobalPlaywrightWrapperPath();
  return {
    skillFile,
    wrapperPath,
    installed: existsSync(skillFile) && existsSync(wrapperPath),
  };
}

async function readTextOrEmpty(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

async function loadGuidedSetupPrompt() {
  const template = await readTextOrEmpty(BOOTSTRAP_GUIDED_PROMPT_TEMPLATE_PATH);
  const normalized = template
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  if (!normalized) {
    throw new Error(
      `bootstrap guided prompt template missing or empty: ${BOOTSTRAP_GUIDED_PROMPT_TEMPLATE_PATH}`,
    );
  }
  return normalized;
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
    reasoningEffort: BOOTSTRAP_REASONING_EFFORT,
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
    if (token === '--reasoning-effort' || token === '--effort') {
      const value = String(args[idx + 1] || '').trim();
      if (!value || value.startsWith('-')) {
        throw new Error('`--reasoning-effort` requires a value');
      }
      parsed.reasoningEffort = value;
      idx += 1;
      continue;
    }
    if (token.startsWith('--model=')) {
      parsed.model = token.slice('--model='.length).trim();
      if (!parsed.model) throw new Error('`--model` requires a value');
      continue;
    }
    if (token.startsWith('--reasoning-effort=')) {
      parsed.reasoningEffort = token.slice('--reasoning-effort='.length).trim();
      if (!parsed.reasoningEffort) throw new Error('`--reasoning-effort` requires a value');
      continue;
    }
    if (token.startsWith('--effort=')) {
      parsed.reasoningEffort = token.slice('--effort='.length).trim();
      if (!parsed.reasoningEffort) throw new Error('`--reasoning-effort` requires a value');
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

function buildCodexArgsBase(options, cwd) {
  const args = ['--cd', cwd];
  args.push('-c', `model_reasoning_effort=${tomlString(options.reasoningEffort)}`);
  if (options.model) {
    args.push('--model', options.model);
  }
  return args;
}

function getCodexCommandOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

function formatCodexFailure(result, fallbackMessage) {
  const output = getCodexCommandOutput(result);
  if (!output) {
    if (result.error?.message) return result.error.message;
    if (typeof result.status === 'number') return `${fallbackMessage} (exit ${result.status})`;
    return fallbackMessage;
  }
  return `${fallbackMessage}: ${output}`;
}

function isModelUnavailableFailure(result) {
  const output = getCodexCommandOutput(result).toLowerCase();
  if (!output) return false;
  return [
    /model .* not found/,
    /unknown model/,
    /invalid model/,
    /unsupported model/,
    /unrecognized model/,
    /model .* does not exist/,
    /model .* not available/,
    /model .* not accessible/,
    /do not have access/,
    /don't have access/,
    /not authorized to use model/,
  ].some((pattern) => pattern.test(output));
}

function probeCodexModel(options, cwd, model) {
  const probeOptions = { ...options, model };
  const args = [
    'exec',
    ...buildCodexArgsBase(probeOptions, cwd),
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--ephemeral',
    'Reply with exactly OK.',
  ];
  return runCommand('codex', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
}

function resolveBootstrapModel(options, cwd) {
  if (options.model) {
    return options.model;
  }

  const preferredProbe = probeCodexModel(options, cwd, DEFAULT_SETUP_MODEL);
  if (!preferredProbe.error && preferredProbe.status === 0) {
    return DEFAULT_SETUP_MODEL;
  }

  if (!isModelUnavailableFailure(preferredProbe)) {
    throw new Error(
      formatCodexFailure(preferredProbe, `failed to validate bootstrap model ${DEFAULT_SETUP_MODEL}`),
    );
  }

  console.log(
    `[codex-everywhere] default setup model ${DEFAULT_SETUP_MODEL} is unavailable; falling back to ${FALLBACK_SETUP_MODEL}.`,
  );

  const fallbackProbe = probeCodexModel(options, cwd, FALLBACK_SETUP_MODEL);
  if (!fallbackProbe.error && fallbackProbe.status === 0) {
    return FALLBACK_SETUP_MODEL;
  }

  throw new Error(
    formatCodexFailure(
      fallbackProbe,
      `failed to validate fallback bootstrap model ${FALLBACK_SETUP_MODEL}`,
    ),
  );
}

function codexSupportsNoAltScreen() {
  const result = spawnSync('codex', ['--help'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return false;
  const helpText = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();
  return helpText.includes('--no-alt-screen');
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

function runCodexExec(options, cwd, prompt, description) {
  const args = ['exec', ...buildCodexArgsBase(options, cwd)];
  if (options.unsafe) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'danger-full-access');
  }
  args.push(prompt);

  console.log(`[codex-everywhere] ${description}`);
  const result = runCommand('codex', args);
  if (result.error) {
    throw new Error(result.error.message || 'failed to launch codex exec');
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`codex exec exited with status ${result.status}`);
  }
}

function ensurePlaywrightSkillAvailable(options, cwd) {
  if (!commandExists('npx')) {
    throw new Error(
      'npx is required for Playwright skill installation and execution. Install Node.js/npm, then rerun `codex-everywhere setup bootstrap`.',
    );
  }

  let status = getPlaywrightSkillStatus();
  if (!status.installed && options.installMissing) {
    const prompt = [
      'Run `$skill-installer playwright` to install the Playwright skill for this machine.',
      `Treat the task as complete only when both \`${status.skillFile}\` and \`${status.wrapperPath}\` exist.`,
      'If the skill is already installed, verify the files instead of reinstalling.',
      'If installation fails, explain the blocker clearly before exiting.',
    ].join(' ');
    runCodexExec(options, cwd, prompt, 'Playwright skill not found; launching Codex to install it...');
    status = getPlaywrightSkillStatus();
  }

  if (!status.installed) {
    throw new Error(
      `installed Playwright skill not found. Expected ${status.skillFile} and ${status.wrapperPath}. Install it with \`$skill-installer playwright\` (or rerun without \`--no-install\`), then rerun \`codex-everywhere setup bootstrap\`.`,
    );
  }

  return status;
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

function launchGuidedSetupSession(options, cwd, prompt) {
  const args = [];
  if (codexSupportsNoAltScreen()) {
    args.push('--no-alt-screen');
  }
  args.push(...buildCodexArgsBase(options, cwd));
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
  const guidedPrompt = await loadGuidedSetupPrompt();

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

  const initialPlaywrightSkill = getPlaywrightSkillStatus();
  let bootstrapOptions = options;
  if (!initialPlaywrightSkill.installed && options.installMissing) {
    bootstrapOptions = {
      ...options,
      model: resolveBootstrapModel(options, cwd),
    };
  }

  const playwrightSkill = ensurePlaywrightSkillAvailable(bootstrapOptions, cwd);
  await ensureProjectTrusted(cwd);
  await ensureSetupDiscordSkillInstalled(cwd);

  if (options.launch && !bootstrapOptions.model) {
    bootstrapOptions = {
      ...options,
      model: resolveBootstrapModel(options, cwd),
    };
  }

  console.log('[codex-everywhere] bootstrap preparation complete.');
  if (bootstrapOptions.model) {
    console.log(`[codex-everywhere] using bootstrap model: ${bootstrapOptions.model}`);
  }
  console.log(`[codex-everywhere] verified Playwright skill: ${playwrightSkill.skillFile}`);
  console.log(`[codex-everywhere] verified Playwright CLI wrapper: ${playwrightSkill.wrapperPath}`);
  console.log('[codex-everywhere] user actions still required during setup: /permissions approval, Discord login, CAPTCHA, and Discord re-auth prompts.');

  if (!options.launch) {
    console.log('[codex-everywhere] launch skipped (`--no-launch`).');
    console.log('[codex-everywhere] next: run `codex` and type `$setup-discord`.');
    return;
  }

  launchGuidedSetupSession(bootstrapOptions, cwd, guidedPrompt);
}
