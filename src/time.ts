/** Human-readable duration, e.g. `2h57m`, `45m`, `3h`. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

export function formatRemaining(until: string, now = new Date()): string {
  return formatDuration(new Date(until).getTime() - now.getTime());
}

export function overlapRemainingMs(
  untilA: string,
  untilB: string,
  now = new Date(),
): number {
  const overlapEnd = Math.min(new Date(untilA).getTime(), new Date(untilB).getTime());
  return Math.max(0, overlapEnd - now.getTime());
}
