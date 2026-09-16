import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The running package version, read from package.json at startup.
 *
 * Two things depend on this being the real version rather than a literal
 * somebody has to remember to bump: what the MCP server advertises to clients,
 * and the version `ai-comms link` pins into a repo's `.mcp.json`.
 */
export const PACKAGE_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return JSON.parse(readFileSync(require.resolve('../package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
})();
