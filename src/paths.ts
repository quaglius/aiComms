import { homedir } from 'node:os';
import path from 'node:path';

export function getConfigDir(): string {
  return path.join(homedir(), '.ai-comms');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function getSecretsPath(): string {
  return path.join(getConfigDir(), 'secrets.json');
}

export const REPO_COMMS_FILENAME = '.ai-comms.json';

export function getProjectDir(project: string): string {
  return path.join(getConfigDir(), 'projects', project);
}

export function getProjectLogPath(project: string): string {
  return path.join(getProjectDir(project), 'log.jsonl');
}

export function getProjectCursorPath(project: string): string {
  return path.join(getProjectDir(project), 'cursor.json');
}

export function getProjectReadPath(project: string): string {
  return path.join(getProjectDir(project), 'read.json');
}

export function getProjectDaemonLogPath(project: string): string {
  return path.join(getProjectDir(project), 'daemon.log');
}

export function getProjectDaemonPidPath(project: string): string {
  return path.join(getProjectDir(project), 'daemon.pid');
}

export function getProjectBudgetPath(project: string): string {
  return path.join(getProjectDir(project), 'budget.json');
}

/** @deprecated v0 layout — migration only */
export function getV0LogPath(): string {
  return path.join(getConfigDir(), 'log.jsonl');
}

export function getV0CursorPath(): string {
  return path.join(getConfigDir(), 'cursor.json');
}

export function getV0ReadPath(): string {
  return path.join(getConfigDir(), 'read.json');
}

export function getV0DaemonLogPath(): string {
  return path.join(getConfigDir(), 'daemon.log');
}

export function getV0DaemonPidPath(): string {
  return path.join(getConfigDir(), 'daemon.pid');
}
