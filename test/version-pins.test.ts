import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The plugin, its hooks and the install docs pin the package version by hand.
// A release that forgets one of them ships a plugin that runs an older CLI.
describe('version pins', () => {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

  it('plugin.json matches package.json', () => {
    const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
    assert.equal(plugin.version, version);
    assert.ok(plugin.mcpServers['ai-comms'].args.includes(`@quaglius/ai-comms@${version}`));
  });

  it('every pinned reference uses the package version', () => {
    for (const file of ['hooks/hooks.json', '.claude-plugin/plugin.json', 'docs/INSTALL.md']) {
      const pins = readFileSync(file, 'utf8').match(/@quaglius\/ai-comms@[0-9][^\s"']*/g) ?? [];
      for (const pin of pins) assert.equal(pin, `@quaglius/ai-comms@${version}`, `${file}: ${pin}`);
    }
  });
});
