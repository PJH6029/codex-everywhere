import { homedir } from 'os';
import { join } from 'path';

export const HOME_DIR = homedir();
export const CODEX_EVERYWHERE_HOME_DIR = join(HOME_DIR, '.codex-everywhere');
export const CODEX_EVERYWHERE_CONFIG_PATH = join(CODEX_EVERYWHERE_HOME_DIR, 'config.json');

export const GLOBAL_STATE_DIR = join(CODEX_EVERYWHERE_HOME_DIR, 'state');
export const GLOBAL_LOG_DIR = join(CODEX_EVERYWHERE_HOME_DIR, 'logs');

export const REGISTRY_PATH = join(GLOBAL_STATE_DIR, 'session-registry.jsonl');
export const ACTIVE_SESSIONS_PATH = join(GLOBAL_STATE_DIR, 'active-sessions.json');
export const DAEMON_PID_PATH = join(GLOBAL_STATE_DIR, 'reply-daemon.pid');
export const DAEMON_LOCK_PATH = join(GLOBAL_STATE_DIR, 'reply-daemon.lock');
export const DAEMON_STATE_PATH = join(GLOBAL_STATE_DIR, 'reply-daemon-state.json');
export const INPUT_SYNC_STATE_PATH = join(GLOBAL_STATE_DIR, 'input-sync-state.json');

export const DISCORD_MAX_MESSAGE_LENGTH = 2000;
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
