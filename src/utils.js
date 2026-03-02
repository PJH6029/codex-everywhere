import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

export function safeString(value) {
  return typeof value === 'string' ? value : '';
}

export function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(path, value) {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await rename(tmp, path);
}

export async function appendJsonl(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value)}\n`, {
    encoding: 'utf-8',
    flag: 'a',
    mode: 0o600,
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso() {
  return new Date().toISOString();
}

export function todayFileName(prefix) {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.jsonl`;
}

export function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export async function fileAgeMs(path) {
  try {
    const fileStat = await stat(path);
    return Date.now() - fileStat.mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function summarizeProject(projectPath) {
  const parts = projectPath.split('/').filter(Boolean);
  return parts.length === 0 ? projectPath : parts[parts.length - 1];
}

export function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const lowered = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  return fallback;
}

export function parseDiscordIds(csv) {
  if (!csv || typeof csv !== 'string') return [];
  return csv
    .split(',')
    .map((token) => token.trim())
    .filter((token) => /^\d{17,20}$/.test(token));
}

export function normalizeMultiline(text) {
  return safeString(text).replace(/\r?\n/g, ' ').trim();
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function resolveFromCwd(cwd, ...segments) {
  return join(cwd, ...segments);
}
