import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { REGISTRY_PATH, REGISTRY_TTL_MS } from './constants.js';
import { appendJsonl, ensureDir, nowIso } from './utils.js';

export async function registerMessageMapping(mapping) {
  const normalized = {
    platform: 'discord-bot',
    kind: 'chat',
    createdAt: nowIso(),
    ...mapping,
  };
  await appendJsonl(REGISTRY_PATH, normalized);
  return normalized;
}

export async function loadMappings() {
  if (!existsSync(REGISTRY_PATH)) return [];

  try {
    const content = await readFile(REGISTRY_PATH, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((value) => value !== null);
  } catch {
    return [];
  }
}

export async function lookupMessageMapping(messageId) {
  const mappings = await loadMappings();
  for (let i = mappings.length - 1; i >= 0; i -= 1) {
    if (mappings[i].messageId === messageId) {
      return mappings[i];
    }
  }
  return null;
}

export async function pruneOldMappings(maxAgeMs = REGISTRY_TTL_MS) {
  const mappings = await loadMappings();
  const now = Date.now();
  const filtered = mappings.filter((mapping) => {
    const createdAt = new Date(mapping.createdAt || 0).getTime();
    if (!Number.isFinite(createdAt)) return false;
    return now - createdAt <= maxAgeMs;
  });

  if (filtered.length === mappings.length) return;

  await ensureDir(dirname(REGISTRY_PATH));
  const content = filtered.map((mapping) => JSON.stringify(mapping)).join('\n');
  await writeFile(REGISTRY_PATH, content.length > 0 ? `${content}\n` : '', 'utf-8');
}
