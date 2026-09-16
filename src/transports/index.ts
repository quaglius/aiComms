import type { ConfigV2 } from '../config.js';
import type { ResolvedContext } from '../context.js';
import { getEffectiveToken } from '../secrets.js';
import { DiscordTransport } from './discord.js';
import { GitHubTransport } from './github.js';
import type { Transport } from './types.js';
import { isDiscordBus, isGitHubBus } from './types.js';

export type { Transport, BusConfig, GitHubBusConfig, DiscordBusConfig } from './types.js';
export { isDiscordBus, isGitHubBus } from './types.js';
export { GitHubTransport } from './github.js';
export { DiscordTransport } from './discord.js';

export interface CreateTransportOptions {
  onIdentityMismatch?: (declared: string, actual: string, commentId: number) => void;
  getEtag?: () => string | undefined;
  setEtag?: (etag: string | undefined) => void;
  githubToken?: string;
  discordToken?: string;
}

export function createTransport(
  ctx: ResolvedContext,
  config: ConfigV2,
  options: CreateTransportOptions = {},
): Transport {
  const bus = ctx.bus;

  if (isGitHubBus(bus)) {
    return new GitHubTransport({
      repo: bus.repo,
      issue: bus.issue,
      token: options.githubToken,
      onIdentityMismatch: options.onIdentityMismatch,
      getEtag: options.getEtag,
      setEtag: options.setEtag,
    });
  }

  if (isDiscordBus(bus)) {
    const dev = config.identity?.dev ?? ctx.dev;
    let token = options.discordToken;
    if (!token) {
      try {
        token = getEffectiveToken(ctx.project).token;
      } catch {
        // doctor will report missing token
      }
    }
    return new DiscordTransport({
      channelId: bus.channelId,
      project: ctx.project,
      configuredDev: dev,
      token,
    });
  }

  throw new Error(`Unknown bus kind: ${(bus as { kind: string }).kind}`);
}
