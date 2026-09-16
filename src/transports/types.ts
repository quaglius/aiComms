import type { Envelope } from '../envelope.js';

export interface TransportIdentity {
  dev: string;
  authenticated: boolean;
  warning?: string;
}

export interface TransportSendResult {
  id: string;
  truncated?: boolean;
}

export interface TransportFetchResult {
  envelopes: Envelope[];
  cursor: string | null;
}

export interface Transport {
  send(envelope: Envelope): Promise<TransportSendResult>;
  fetchSince(cursor: string | null): Promise<TransportFetchResult>;
  /** Optional full backfill when the transport supports paginated history. */
  backfill?(cursor: string | null): Promise<TransportFetchResult>;
  whoami(): Promise<TransportIdentity>;
  describe(): string;
}

export interface GitHubBusConfig {
  kind: 'github';
  repo: string;
  issue: number;
}

export interface DiscordBusConfig {
  kind: 'discord';
  channelId: string;
}

export type BusConfig = GitHubBusConfig | DiscordBusConfig;

export function isGitHubBus(bus: BusConfig): bus is GitHubBusConfig {
  return bus.kind === 'github';
}

export function isDiscordBus(bus: BusConfig): bus is DiscordBusConfig {
  return bus.kind === 'discord';
}
