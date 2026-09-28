// Guards the HOME/USERPROFILE split that test/*.test.ts's various
// `withTempHome` helpers depend on: `os.homedir()` (which every path in
// src/paths.ts is built from) reads $HOME on POSIX, but on Windows it reads
// %USERPROFILE% and does not consult %HOME% at all (see Node's lib/os.js —
// this is Node's own platform behavior, not something ai-comms controls).
// A `withTempHome` helper that only faked one of the two would silently
// read or write the real profile on the other platform, which is why every
// one of those helpers sets both vars. This test pins down that
// getConfigDir() follows *this platform's* var (HOME on POSIX, USERPROFILE
// on Windows) and never the other one — which is what would break if
// someone read the wrong env var directly, or stopped setting one of the
// two, instead of going through os.homedir().
//
// An earlier version of this test hardcoded the POSIX expectation (asserted
// configDir always follows HOME), which is simply wrong on Windows and
// failed there for that reason, not because of any production bug —
// caught by CI run 36496187806 (windows-latest, both node 20 and 22).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getConfigDir } from '../src/paths.js';

describe('getConfigDir — HOME vs USERPROFILE', () => {
  it("follows this platform's home var and never the other one, even when they differ", () => {
    const ORIGINAL_HOME = process.env.HOME;
    const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-paths-home-'));
    const decoy = mkdtempSync(path.join(tmpdir(), 'ai-comms-paths-decoy-'));
    // os.homedir() reads %USERPROFILE% on Windows and $HOME everywhere
    // else, so which of the two temp dirs is "the real one" vs. "the decoy"
    // for this assertion flips by platform.
    const platformHome = process.platform === 'win32' ? decoy : home;
    const otherDecoy = process.platform === 'win32' ? home : decoy;
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = decoy;

      const configDir = getConfigDir();

      assert.equal(
        configDir,
        path.join(platformHome, '.ai-comms'),
        `must resolve under this platform's home var (${process.platform === 'win32' ? 'USERPROFILE' : 'HOME'})`,
      );
      assert.ok(
        !configDir.startsWith(otherDecoy),
        `must never land under the other var's decoy dir, got ${configDir}`,
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
