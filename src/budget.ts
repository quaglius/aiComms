import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getProjectBudgetPath, getProjectDir } from './paths.js';

const WINDOW_MS = 60 * 60 * 1000;

export interface BudgetEntry {
  requester: string;
  ts: string;
}

export interface BudgetState {
  entries: BudgetEntry[];
}

export interface BudgetUsage {
  requester: string;
  count: number;
}

export interface BudgetSnapshot {
  windowStart: string;
  windowEnd: string;
  maxPerRequesterPerHour: number;
  usage: BudgetUsage[];
}

function ensureBudgetFile(project: string): void {
  const budgetPath = getProjectBudgetPath(project);
  if (existsSync(budgetPath)) return;
  mkdirSync(getProjectDir(project), { recursive: true });
  writeFileSync(budgetPath, JSON.stringify({ entries: [] }, null, 2) + '\n', 'utf8');
}

export function loadBudgetState(project: string): BudgetState {
  const budgetPath = getProjectBudgetPath(project);
  if (!existsSync(budgetPath)) return { entries: [] };
  try {
    const raw = JSON.parse(readFileSync(budgetPath, 'utf8')) as BudgetState;
    return { entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    return { entries: [] };
  }
}

export function saveBudgetState(project: string, state: BudgetState): void {
  ensureBudgetFile(project);
  writeFileSync(getProjectBudgetPath(project), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function pruneBudgetEntries(
  entries: BudgetEntry[],
  now = Date.now(),
  windowMs = WINDOW_MS,
): BudgetEntry[] {
  const cutoff = now - windowMs;
  return entries.filter((e) => new Date(e.ts).getTime() > cutoff);
}

export function countRequesterUsage(
  entries: BudgetEntry[],
  requester: string,
  now = Date.now(),
  windowMs = WINDOW_MS,
): number {
  const active = pruneBudgetEntries(entries, now, windowMs);
  return active.filter((e) => e.requester === requester).length;
}

export function isBudgetAvailable(
  project: string,
  requester: string,
  maxPerRequesterPerHour: number,
  now = Date.now(),
): boolean {
  const state = loadBudgetState(project);
  const active = pruneBudgetEntries(state.entries, now);
  return countRequesterUsage(active, requester, now) < maxPerRequesterPerHour;
}

export function recordBudgetUse(
  project: string,
  requester: string,
  now = new Date(),
): void {
  const state = loadBudgetState(project);
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pruned = pruneBudgetEntries(state.entries, now.getTime());
  saveBudgetState(project, { entries: [...pruned, { requester, ts }] });
}

export function getBudgetSnapshot(
  project: string,
  maxPerRequesterPerHour: number,
  now = new Date(),
): BudgetSnapshot {
  const state = loadBudgetState(project);
  const active = pruneBudgetEntries(state.entries, now.getTime());
  const counts = new Map<string, number>();
  for (const entry of active) {
    counts.set(entry.requester, (counts.get(entry.requester) ?? 0) + 1);
  }

  const windowEnd = now;
  const windowStart = new Date(now.getTime() - WINDOW_MS);

  return {
    windowStart: windowStart.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    windowEnd: windowEnd.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    maxPerRequesterPerHour,
    usage: [...counts.entries()]
      .map(([requester, count]) => ({ requester, count }))
      .sort((a, b) => a.requester.localeCompare(b.requester)),
  };
}

export function formatBudgetSnapshot(snapshot: BudgetSnapshot): string {
  const lines = [
    `Budget window: ${snapshot.windowStart} → ${snapshot.windowEnd}`,
    `Limit: ${snapshot.maxPerRequesterPerHour} auto-answers per requester per hour`,
  ];
  if (snapshot.usage.length === 0) {
    lines.push('Usage: (none in current window)');
  } else {
    lines.push('Usage:');
    for (const row of snapshot.usage) {
      lines.push(`  ${row.requester}: ${row.count}/${snapshot.maxPerRequesterPerHour}`);
    }
  }
  return lines.join('\n');
}
