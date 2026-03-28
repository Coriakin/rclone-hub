import os from 'node:os';
import path from 'node:path';

export const APP_DIR = path.join(os.homedir(), '.rclone-hub');
export const DB_PATH = path.join(APP_DIR, 'rclone_hub.db');
export const DEFAULT_STAGING_PATH = path.join(os.tmpdir(), 'rclone-hub-staging');

export const RCLONE_TIMEOUT_SECONDS = Number(process.env.RCLONE_HUB_RCLONE_TIMEOUT_SECONDS ?? '300');
export const RCLONE_MAX_RETRIES = Number(process.env.RCLONE_HUB_RCLONE_MAX_RETRIES ?? '1');
export const SEARCH_HEARTBEAT_SECONDS = Number(process.env.RCLONE_HUB_SEARCH_HEARTBEAT_SECONDS ?? '1.0');
export const SEARCH_DIR_TIMEOUT_SECONDS = Number(process.env.RCLONE_HUB_SEARCH_DIR_TIMEOUT_SECONDS ?? '30');
export const SIZE_HEARTBEAT_SECONDS = Number(process.env.RCLONE_HUB_SIZE_HEARTBEAT_SECONDS ?? '1.0');
export const SIZE_DIR_TIMEOUT_SECONDS = Number(process.env.RCLONE_HUB_SIZE_DIR_TIMEOUT_SECONDS ?? '30');
