// Guards the HOME/USERPROFILE split that test/*.test.ts's various
// `withTempHome` helpers depend on: `os.homedir()` (which every path in
// src/paths.ts is built from) reads $HOME on POSIX and %USERPROFILE% on
// Windows. A helper that only fakes one of the two would silently read or
// write the real profile on the other platform. This can only exercise the
// POSIX side here (CI's Windows runners exercise the other), but it pins
// down that getConfigDir() follows HOME and never USERPROFILE on this OS —
// which is what would break if someone read process.env.USERPROFILE (or
// stopped setting process.env.HOME) directly instead of going through
// os.homedir().

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getConfigDir } from '../src/paths.js';

describe('getConfigDir — HOME vs USERPROFILE', () => {
  it('follows the platform home var (HOME here) and never the other one, even when they differ', () => {
    const ORIGINAL_HOME = process.env.HOME;
    const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-paths-home-'));
    const decoy = mkdtempSync(path.join(tmpdir(), 'ai-comms-paths-decoy-'));
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = decoy;

      const configDir = getConfigDir();

      assert.equal(configDir, path.join(home, '.ai-comms'), 'must resolve under the faked HOME');
      assert.ok(
        !configDir.startsWith(decoy),
        `must never land under USERPROFILE's decoy dir, got ${configDir}`,
      );
    } finally {
      if (ORIGINAL_HOME === undefined) delete process.env.HOME;
      else process.env.HOME = ORIGINAL_HOME;
      if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(decoy, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
