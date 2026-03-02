import { homedir } from 'os';
import { join } from 'path';

export const HOME_DIR = homedir();
export const OMX_CONFIG_PATH = join(HOME_DIR, '.codex', '.omx-config.json');

export const GLOBAL_STATE_DIR = join(HOME_DIR, '.omx', 'state', 'codex-everywhere');
export const GLOBAL_LOG_DIR = join(HOME_DIR, '.omx', 'logs');

export const REGISTRY_PATH = join(GLOBAL_STATE_DIR, 'session-registry.jsonl');
export const ACTIVE_SESSIONS_PATH = join(GLOBAL_STATE_DIR, 'active-sessions.json');
export const DAEMON_PID_PATH = join(GLOBAL_STATE_DIR, 'reply-daemon.pid');
export const DAEMON_LOCK_PATH = join(GLOBAL_STATE_DIR, 'reply-daemon.lock');
export const DAEMON_STATE_PATH = join(GLOBAL_STATE_DIR, 'reply-daemon-state.json');

export const DISCORD_MAX_MESSAGE_LENGTH = 2000;
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
